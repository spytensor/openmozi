import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { TaskBriefSchema, type TaskBrief } from '../agents/protocol.js';
import { buildSubagentEnv } from '../agents/process-manager.js';
import { readClaudeCliCredentials, readCodexCliCredentials } from '../core/cli-credentials.js';
import { getProvider } from '../core/providers.js';
import { getRuntimeProjectRoot, resolveProjectRelativePath } from '../runtime/project-root.js';
import type {
  ExternalWorkerAgentConfig,
  ManagedWorkerTaskInput,
  WorkerAdapter,
  WorkerExecutionLane,
  WorkerSandboxProfile,
} from './adapter.js';
import { parseCliWorkerOutput, sanitizeCliWorkerEnv } from './cli-worker-utils.js';

export type WorkerReadinessStatus = 'ready' | 'degraded' | 'blocked';
export type WorkerHealthStatus = 'healthy' | 'degraded' | 'down';

export interface WorkerPreflightCheck {
  id: string;
  ok: boolean;
  severity: 'hard' | 'soft' | 'info';
  summary: string;
}

export interface WorkerLiveProbeResult {
  enabled: boolean;
  ok: boolean;
  summary: string;
  latency_ms?: number;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
}

export interface WorkerHealthSnapshot {
  status: WorkerHealthStatus;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  avg_latency_ms: number | null;
}

export interface WorkerPreflightReport {
  adapter_id: string;
  command: string | null;
  command_path: string | null;
  auth_source: string | null;
  lane: WorkerExecutionLane;
  sandbox_profile: WorkerSandboxProfile;
  status: WorkerReadinessStatus;
  checks: WorkerPreflightCheck[];
  health: WorkerHealthSnapshot;
  live_probe: WorkerLiveProbeResult;
  generated_at: string;
  summary: string;
}

type WorkerHealthState = {
  status: WorkerHealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  latencyMs: number[];
};

const workerHealth = new Map<string, WorkerHealthState>();
const DEGRADED_THRESHOLD = 2;
const DOWN_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;
const MAX_LATENCY_SAMPLES = 20;

function getOrCreateWorkerHealth(adapterId: string): WorkerHealthState {
  const existing = workerHealth.get(adapterId);
  if (existing) return existing;

  const created: WorkerHealthState = {
    status: 'healthy',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    latencyMs: [],
  };
  workerHealth.set(adapterId, created);
  return created;
}

function nowIso(): string {
  return new Date().toISOString();
}

function averageLatency(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildWorkerHealthSnapshot(adapterId: string): WorkerHealthSnapshot {
  const state = getOrCreateWorkerHealth(adapterId);
  return {
    status: state.status,
    consecutive_failures: state.consecutiveFailures,
    last_success_at: state.lastSuccessAt?.toISOString() ?? null,
    last_failure_at: state.lastFailureAt?.toISOString() ?? null,
    avg_latency_ms: averageLatency(state.latencyMs),
  };
}

export function reportManagedWorkerSuccess(adapterId: string, latencyMs?: number): void {
  const state = getOrCreateWorkerHealth(adapterId);
  state.consecutiveSuccesses += 1;
  state.consecutiveFailures = 0;
  state.lastSuccessAt = new Date();

  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    state.latencyMs.push(latencyMs);
    if (state.latencyMs.length > MAX_LATENCY_SAMPLES) {
      state.latencyMs.shift();
    }
  }

  if (state.status === 'down' && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
    state.status = 'degraded';
  } else if (state.status === 'degraded' && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
    state.status = 'healthy';
  }
}

export function reportManagedWorkerFailure(adapterId: string): void {
  const state = getOrCreateWorkerHealth(adapterId);
  state.consecutiveFailures += 1;
  state.consecutiveSuccesses = 0;
  state.lastFailureAt = new Date();

  if (state.consecutiveFailures >= DOWN_THRESHOLD) {
    state.status = 'down';
  } else if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
    state.status = 'degraded';
  }
}

export function resetManagedWorkerHealth(adapterId?: string): void {
  if (adapterId) {
    workerHealth.delete(adapterId);
    return;
  }
  workerHealth.clear();
}

function normalizeLane(value: unknown): WorkerExecutionLane | null {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'review':
      return 'review';
    case 'code':
    case 'coding':
      return 'code';
    case 'dangerous':
    case 'full-access':
      return 'dangerous';
    default:
      return null;
  }
}

function preferredLaneFromTask(task: TaskBrief): WorkerExecutionLane {
  if (task.constraints.permission_level === 'L3_FULL_ACCESS') {
    return 'dangerous';
  }
  if (task.hints.type === 'review' || task.constraints.permission_level === 'L0_READ_ONLY') {
    return 'review';
  }
  return 'code';
}

export function resolveWorkerExecutionLane(
  task: TaskBrief,
  worker?: Pick<ExternalWorkerAgentConfig, 'metadata'> | null,
): WorkerExecutionLane {
  const metadataLane = normalizeLane(worker?.metadata?.lane);
  return metadataLane ?? preferredLaneFromTask(task);
}

export function defaultSandboxProfileForLane(lane: WorkerExecutionLane): WorkerSandboxProfile {
  switch (lane) {
    case 'review':
      return 'read-only';
    case 'dangerous':
      return 'full-access';
    default:
      return 'workspace-write';
  }
}

export function resolveWorkerSandboxProfile(
  adapter: WorkerAdapter,
  lane: WorkerExecutionLane,
): WorkerSandboxProfile {
  const preferred = defaultSandboxProfileForLane(lane);
  const supported = adapter.metadata.supported_sandbox_profiles ?? [];
  if (supported.length === 0 || supported.includes(preferred)) return preferred;
  if (lane !== 'dangerous' && supported.includes('adapter-managed')) return 'adapter-managed';
  return preferred;
}

function resolveProviderCommand(adapterId: string): string | null {
  if (adapterId === 'claude_code') {
    return getProvider('claude-cli')?.cliBackend?.command ?? null;
  }
  if (adapterId === 'codex_cli') {
    return getProvider('codex-cli')?.cliBackend?.command ?? null;
  }
  return null;
}

function resolveWorkerCommand(adapterId: string, config: ExternalWorkerAgentConfig): string | null {
  return config.command || resolveProviderCommand(adapterId);
}

function findCommandOnPath(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (isAbsolute(trimmed)) {
    try {
      accessSync(trimmed, constants.X_OK);
      return trimmed;
    } catch {
      return null;
    }
  }

  const searchPath = process.env.PATH ?? '';
  for (const entry of searchPath.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, trimmed);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function resolveAuthState(
  adapterId: string,
  commandPath: string | null,
): { ok: boolean; source: string | null; summary: string } {
  if (adapterId === 'claude_code') {
    if (readClaudeCliCredentials()) {
      return { ok: true, source: '~/.claude/.credentials.json', summary: 'Claude CLI OAuth credentials found' };
    }
    if (!commandPath) {
      return { ok: false, source: null, summary: 'Claude CLI command not found; authentication could not be verified' };
    }
    try {
      const result = spawnSync(commandPath, ['auth', 'status', '--json'], {
        encoding: 'utf-8',
        timeout: 5_000,
        env: sanitizeCliWorkerEnv(buildSubagentEnv()),
      });
      if (result.status !== 0 || result.error) {
        return { ok: false, source: null, summary: 'Claude CLI authentication status check failed' };
      }
      const payload = JSON.parse(String(result.stdout || '{}')) as { loggedIn?: unknown };
      return payload.loggedIn === true
        ? { ok: true, source: 'claude auth status', summary: 'Claude CLI reports an authenticated session' }
        : { ok: false, source: null, summary: 'Claude CLI reports no authenticated session' };
    } catch {
      return { ok: false, source: null, summary: 'Claude CLI authentication status could not be verified' };
    }
  }
  if (adapterId === 'codex_cli') {
    return readCodexCliCredentials()
      ? { ok: true, source: '~/.codex/auth.json', summary: 'Codex CLI auth found' }
      : { ok: false, source: null, summary: 'Codex CLI auth not found (~/.codex/auth.json)' };
  }
  return { ok: true, source: null, summary: 'Adapter-specific auth check not required' };
}

function buildSyntheticTask(lane: WorkerExecutionLane): TaskBrief {
  return TaskBriefSchema.parse({
    task_id: `preflight_${lane}`,
    objective: `Managed worker preflight for ${lane} lane`,
    done_criteria: 'Readiness checks completed',
    constraints: {
      token_budget: 256,
      timeout_seconds: 15,
      permission_level:
        lane === 'dangerous'
          ? 'L3_FULL_ACCESS'
          : lane === 'review'
            ? 'L0_READ_ONLY'
            : 'L2_SHELL_EXEC',
      allowed_tools: lane === 'review' ? ['filesystem'] : ['filesystem', 'shell'],
      forbidden_paths: [],
    },
    hints: {
      complexity: 'low',
      type: lane === 'review' ? 'review' : 'code',
      needs_tool_calling: lane !== 'review',
      estimated_tokens: 64,
    },
  });
}

function buildProbeSpec(
  adapter: WorkerAdapter,
  config: ExternalWorkerAgentConfig,
  command: string,
  sandboxProfile: WorkerSandboxProfile,
): {
  args: string[];
  mode: 'json' | 'jsonl' | 'text';
  timeoutMs: number;
} | null {
  if (adapter.metadata.id === 'claude_code') {
    const backend = getProvider('claude-cli')?.cliBackend;
    if (!backend?.args?.length) return null;
    const args = [...backend.args];
    if (config.model && backend.modelArg) {
      args.push(backend.modelArg, config.model);
    }
    args.push('Reply exactly OK');
    return { args, mode: 'json', timeoutMs: 15_000 };
  }

  if (adapter.metadata.id === 'codex_cli') {
    if (sandboxProfile !== 'read-only' && sandboxProfile !== 'workspace-write') {
      return null;
    }
    const backend = getProvider('codex-cli')?.cliBackend;
    const args = backend?.args?.length
      ? [...backend.args]
      : ['exec', '--json', '--color', 'never', '--sandbox', 'read-only'];
    const sandboxIndex = args.indexOf('--sandbox');
    if (sandboxIndex >= 0 && sandboxIndex + 1 < args.length) {
      args[sandboxIndex + 1] = sandboxProfile;
    } else {
      args.push('--sandbox', sandboxProfile);
    }
    if (config.model && backend?.modelArg) {
      args.push(backend.modelArg, config.model);
    }
    args.push('Reply exactly OK');
    return { args, mode: 'jsonl', timeoutMs: 15_000 };
  }

  void command;
  return null;
}

function runLiveProbe(
  adapter: WorkerAdapter,
  config: ExternalWorkerAgentConfig,
  command: string,
  sandboxProfile: WorkerSandboxProfile,
): WorkerLiveProbeResult {
  const probe = buildProbeSpec(adapter, config, command, sandboxProfile);
  if (!probe) {
    return {
      enabled: false,
      ok: true,
      summary: 'Live probe not available for this adapter/lane combination',
    };
  }

  const startedAt = Date.now();
  const result = spawnSync(command, probe.args, {
    cwd: config.cwd ? resolveProjectRelativePath(config.cwd) : getRuntimeProjectRoot(),
    env: sanitizeCliWorkerEnv(buildSubagentEnv(process.env)),
    encoding: 'utf-8',
    timeout: probe.timeoutMs,
  });
  const latencyMs = Date.now() - startedAt;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const parsed = parseCliWorkerOutput(stdout, probe.mode);

  if (result.error) {
    return {
      enabled: true,
      ok: false,
      summary: `Live probe failed: ${result.error.message}`,
      latency_ms: latencyMs,
      stdout_excerpt: stdout.slice(0, 300),
      stderr_excerpt: stderr.slice(0, 300),
    };
  }

  if (result.status !== 0) {
    return {
      enabled: true,
      ok: false,
      summary: stderr.trim() || parsed || `Live probe exited with code ${result.status ?? 'unknown'}`,
      latency_ms: latencyMs,
      stdout_excerpt: stdout.slice(0, 300),
      stderr_excerpt: stderr.slice(0, 300),
    };
  }

  if (!parsed.includes('OK')) {
    return {
      enabled: true,
      ok: false,
      summary: `Live probe succeeded but returned unexpected output: ${parsed || '(empty)'}`,
      latency_ms: latencyMs,
      stdout_excerpt: stdout.slice(0, 300),
      stderr_excerpt: stderr.slice(0, 300),
    };
  }

  return {
    enabled: true,
    ok: true,
    summary: 'Live probe succeeded',
    latency_ms: latencyMs,
    stdout_excerpt: stdout.slice(0, 300),
    stderr_excerpt: stderr.slice(0, 300),
  };
}

function summarizePreflightStatus(status: WorkerReadinessStatus, checks: WorkerPreflightCheck[]): string {
  if (status === 'ready') return 'Managed worker ready';
  const failedChecks = checks.filter((check) => !check.ok).map((check) => check.summary);
  if (failedChecks.length === 0) {
    return status === 'degraded' ? 'Managed worker degraded' : 'Managed worker blocked';
  }
  return failedChecks.join('; ');
}

function buildReadinessStatus(
  checks: WorkerPreflightCheck[],
  health: WorkerHealthSnapshot,
  liveProbe: WorkerLiveProbeResult,
): WorkerReadinessStatus {
  const hasHardFailure = checks.some((check) => check.severity === 'hard' && !check.ok);
  if (hasHardFailure) return 'blocked';
  if (liveProbe.enabled && !liveProbe.ok) return 'blocked';
  if (health.status === 'degraded' || checks.some((check) => check.severity === 'soft' && !check.ok)) {
    return 'degraded';
  }
  return 'ready';
}

export async function inspectManagedWorkerPreflight(
  input: ManagedWorkerTaskInput,
  adapter: WorkerAdapter,
  options: { liveProbe?: boolean } = {},
): Promise<WorkerPreflightReport> {
  const lane = resolveWorkerExecutionLane(input.task, input.worker);
  const sandboxProfile = resolveWorkerSandboxProfile(adapter, lane);
  const command = resolveWorkerCommand(adapter.metadata.id, input.worker);
  const commandPath = command ? findCommandOnPath(command) : null;
  const auth = resolveAuthState(adapter.metadata.id, commandPath);
  const health = buildWorkerHealthSnapshot(adapter.metadata.id);
  const checks: WorkerPreflightCheck[] = [];

  checks.push({
    id: 'lane',
    ok: !adapter.metadata.supported_lanes || adapter.metadata.supported_lanes.includes(lane),
    severity: 'hard',
    summary:
      !adapter.metadata.supported_lanes || adapter.metadata.supported_lanes.includes(lane)
        ? `Lane ${lane} allowed`
        : `Adapter ${adapter.metadata.id} does not support lane ${lane}`,
  });
  checks.push({
    id: 'transport',
    ok: adapter.supportsTransport(input.worker.transport),
    severity: 'hard',
    summary: adapter.supportsTransport(input.worker.transport)
      ? `Transport ${input.worker.transport} supported`
      : `Transport ${input.worker.transport} is not supported by ${adapter.metadata.id}`,
  });
  checks.push({
    id: 'sandbox',
    ok: !adapter.metadata.supported_sandbox_profiles
      || adapter.metadata.supported_sandbox_profiles.includes(sandboxProfile),
    severity: lane === 'dangerous' ? 'hard' : 'soft',
    summary:
      !adapter.metadata.supported_sandbox_profiles
        || adapter.metadata.supported_sandbox_profiles.includes(sandboxProfile)
        ? `Sandbox profile ${sandboxProfile} selected for ${lane} lane`
        : `Sandbox profile ${sandboxProfile} is not supported by ${adapter.metadata.id}`,
  });
  checks.push({
    id: 'command',
    ok: command ? Boolean(commandPath) : true,
    severity: 'hard',
    summary: command
      ? commandPath
        ? `Command ${command} found`
        : `Command ${command} not found in PATH`
      : 'Adapter command not declared',
  });
  checks.push({
    id: 'auth',
    ok: auth.ok,
    severity: 'hard',
    summary: auth.summary,
  });
  checks.push({
    id: 'health',
    ok: health.status !== 'down',
    severity: 'hard',
    summary: `Worker health is ${health.status}`,
  });

  const shouldRunProbe = Boolean(options.liveProbe && command && commandPath && auth.ok && health.status !== 'down');
  const liveProbe = shouldRunProbe
    ? runLiveProbe(adapter, input.worker, commandPath!, sandboxProfile)
    : {
      enabled: Boolean(options.liveProbe),
      ok: true,
      summary: options.liveProbe
        ? 'Live probe skipped because static readiness checks did not pass'
        : 'Live probe disabled',
    } satisfies WorkerLiveProbeResult;

  const status = buildReadinessStatus(checks, health, liveProbe);
  return {
    adapter_id: adapter.metadata.id,
    command,
    command_path: commandPath,
    auth_source: auth.source,
    lane,
    sandbox_profile: sandboxProfile,
    status,
    checks,
    health,
    live_probe: liveProbe,
    generated_at: nowIso(),
    summary: summarizePreflightStatus(status, checks),
  };
}

export async function inspectWorkerAdapterLaneReadiness(
  adapter: WorkerAdapter,
  lane: WorkerExecutionLane,
  options: {
    config?: Partial<ExternalWorkerAgentConfig>;
    liveProbe?: boolean;
  } = {},
): Promise<WorkerPreflightReport> {
  return inspectManagedWorkerPreflight({
    job_id: `worker_readiness_${adapter.metadata.id}_${lane}`,
    agent_id: `worker_readiness_${adapter.metadata.id}`,
    tenant_id: 'default',
    task: buildSyntheticTask(lane),
    system_prompt: '',
    worker: {
      adapter: adapter.metadata.id,
      transport: 'stdio',
      args: [],
      env: {},
      metadata: { lane },
      transport_options: {},
      ...options.config,
    },
    timeout_ms: 15_000,
  }, adapter, { liveProbe: options.liveProbe });
}

export async function inspectAllWorkerReadiness(
  adapters: WorkerAdapter[],
  options: { liveProbe?: boolean } = {},
): Promise<WorkerPreflightReport[]> {
  const reports: WorkerPreflightReport[] = [];

  for (const adapter of adapters) {
    const lanes = adapter.metadata.supported_lanes ?? ['review', 'code'];
    for (const lane of lanes) {
      reports.push(await inspectWorkerAdapterLaneReadiness(adapter, lane, options));
    }
  }

  return reports;
}
