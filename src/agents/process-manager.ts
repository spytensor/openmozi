import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createRpcRequest, createRpcNotification, type JsonRpcResponse } from './protocol.js';
import { incrementSpawnCount } from './registry.js';
import type { AgentMessage } from './messaging.js';
import { log as logEvent } from '../store/events.js';
import { getAllProviders } from '../core/providers.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:process-manager' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubAgentProcess {
  id: string;
  agentId: string;
  pid: number | undefined;
  alive: boolean;
  lastHeartbeat: number;
  startedAt: number;
}

interface ManagedProcess {
  info: SubAgentProcess;
  child: ChildProcess;
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lineBuffer: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const processes = new Map<string, ManagedProcess>();
const liveCapabilities = new Map<string, string[]>();
let rpcIdCounter = 0;

const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const GRACEFUL_KILL_TIMEOUT_MS = 5000;

const SAFE_RUNTIME_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'NODE_ENV',
  'NODE_OPTIONS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
] as const;

const SAFE_TOOL_ENV_KEYS = [
  'SEARCH1API_KEY',
] as const;

function resolveTenantId(tenantId?: string): string {
  return tenantId ?? process.env.MOZI_TENANT_ID ?? 'default';
}

function parseExtraAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/**
 * Build a minimal child-process environment for subagents.
 * Uses explicit allowlists to avoid leaking unrelated parent secrets.
 */
export function buildSubagentEnv(parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const exactKeys = new Set<string>([
    ...SAFE_RUNTIME_ENV_KEYS,
    ...SAFE_TOOL_ENV_KEYS,
    ...parseExtraAllowlist(parentEnv.MOZI_SUBAGENT_ENV_ALLOWLIST),
  ]);
  const apiKeyNumberedPrefixes = new Set<string>();

  for (const provider of getAllProviders()) {
    exactKeys.add(provider.env.primaryKey);
    for (const alias of provider.env.keyAliases) {
      exactKeys.add(alias);
    }
    for (const baseUrlKey of provider.env.baseUrlKeys) {
      exactKeys.add(baseUrlKey);
    }
    for (const prefix of provider.env.keyPrefixes) {
      exactKeys.add(`MOZI_LIVE_${prefix}_KEY`);
      exactKeys.add(`${prefix}_API_KEY`);
      exactKeys.add(`${prefix}_API_KEYS`);
      apiKeyNumberedPrefixes.add(prefix);
    }
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== 'string') continue;
    if (exactKeys.has(key)) {
      env[key] = value;
      continue;
    }
    for (const prefix of apiKeyNumberedPrefixes) {
      if (key.startsWith(`${prefix}_API_KEY_`)) {
        env[key] = value;
        break;
      }
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Spawn a new subagent child process */
export function spawn(
  agentId: string,
  options: {
    system_prompt?: string;
    tools_allowed?: string[];
    permission_level?: string;
    llm_provider?: string;
    llm_model?: string;
    max_tool_iterations?: number;
    peer_collaboration?: boolean;
    capabilities?: string[];
    tenant_id?: string;
  } = {}
): SubAgentProcess {
  const processId = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const effectiveTenantId = resolveTenantId(options.tenant_id);

  const workerPath = resolve(import.meta.dirname ?? '.', 'subagent-worker.js');
  const baseEnv = buildSubagentEnv(process.env);

  const child = fork(workerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...baseEnv,
      MOZI_AGENT_ID: agentId,
      MOZI_PROCESS_ID: processId,
      MOZI_SYSTEM_PROMPT: options.system_prompt || '',
      MOZI_TOOLS_ALLOWED: JSON.stringify(options.tools_allowed || []),
      MOZI_PERMISSION_LEVEL: options.permission_level || 'L0_READ_ONLY',
      MOZI_LLM_PROVIDER: options.llm_provider || '',
      MOZI_LLM_MODEL: options.llm_model || '',
      MOZI_SUBAGENT_MAX_TOOL_ITERATIONS: String(options.max_tool_iterations ?? ''),
      MOZI_PEER_COLLABORATION: options.peer_collaboration ? 'true' : '',
      MOZI_CAPABILITIES: JSON.stringify(options.capabilities || []),
      MOZI_TENANT_ID: effectiveTenantId,
    },
  });

  const info: SubAgentProcess = {
    id: processId,
    agentId,
    pid: child.pid,
    alive: true,
    lastHeartbeat: Date.now(),
    startedAt: Date.now(),
  };

  const managed: ManagedProcess = {
    info,
    child,
    pendingRequests: new Map(),
    heartbeatTimer: null,
    lineBuffer: '',
  };

  // Handle JSON-RPC messages over stdout (line-delimited JSON)
  child.stdout?.on('data', (data: Buffer) => {
    managed.lineBuffer += data.toString();
    const lines = managed.lineBuffer.split('\n');
    managed.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleMessage(managed, JSON.parse(trimmed));
      } catch {
        logger.debug({ processId, line: trimmed }, 'Non-JSON line from subagent');
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    logger.warn({ processId, stderr: data.toString().trim() }, 'SubAgent stderr');
  });

  child.on('exit', (code, signal) => {
    info.alive = false;
    clearHeartbeatMonitor(managed);
    liveCapabilities.delete(processId);
    // Reject all pending requests
    for (const [, pending] of managed.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`SubAgent exited (code=${code}, signal=${signal})`));
    }
    managed.pendingRequests.clear();
    logger.info({ processId, agentId, code, signal }, 'SubAgent exited');
  });

  // Start heartbeat monitor
  managed.heartbeatTimer = setInterval(() => {
    if (Date.now() - info.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      logger.warn({ processId, agentId, lastHeartbeat: info.lastHeartbeat }, 'SubAgent heartbeat timeout');
      kill(processId);
    }
  }, HEARTBEAT_INTERVAL_MS);

  processes.set(processId, managed);

  // Update spawn count in registry
  try { incrementSpawnCount(agentId); } catch { /* ignore if agent not in registry */ }

  logger.info({ processId, agentId, pid: child.pid }, 'SubAgent spawned');
  return info;
}

/** Send a JSON-RPC request and wait for response */
export async function send(
  processId: string,
  method: string,
  params?: unknown,
  timeoutMs = 30_000
): Promise<unknown> {
  const managed = processes.get(processId);
  if (!managed || !managed.info.alive) {
    throw new Error(`SubAgent process not found or dead: ${processId}`);
  }

  const id = ++rpcIdCounter;
  const request = createRpcRequest(method, params, id);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      managed.pendingRequests.delete(id);
      reject(new Error(`RPC timeout for method "${method}" (${timeoutMs}ms)`));
    }, timeoutMs);

    managed.pendingRequests.set(id, { resolve, reject, timer });
    managed.child.stdin?.write(JSON.stringify(request) + '\n');
  });
}

/** Send a JSON-RPC notification (no response expected) */
export function notify(processId: string, method: string, params?: unknown): void {
  const managed = processes.get(processId);
  if (!managed || !managed.info.alive) return;

  const notification = createRpcNotification(method, params);
  managed.child.stdin?.write(JSON.stringify(notification) + '\n');
}

/** Kill a subagent process (SIGTERM → wait → SIGKILL) */
export async function kill(processId: string): Promise<void> {
  const managed = processes.get(processId);
  if (!managed) return;

  managed.info.alive = false;
  clearHeartbeatMonitor(managed);

  return new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      try { managed.child.kill('SIGKILL'); } catch { /* already dead */ }
      cleanup();
    }, GRACEFUL_KILL_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(forceTimer);
      processes.delete(processId);
      resolve();
    }

    managed.child.on('exit', cleanup);

    try {
      managed.child.kill('SIGTERM');
    } catch {
      cleanup();
    }

    logger.info({ processId }, 'SubAgent kill initiated');
  });
}

/** Get info about a running subagent */
export function getProcess(processId: string): SubAgentProcess | null {
  return processes.get(processId)?.info ?? null;
}

/** List all active subagent processes */
export function listActive(): SubAgentProcess[] {
  return Array.from(processes.values())
    .filter((m) => m.info.alive)
    .map((m) => m.info);
}

/** Kill all active subagent processes */
export async function killAll(): Promise<void> {
  const kills = Array.from(processes.keys()).map((id) => kill(id));
  await Promise.all(kills);
}

/** Get live capabilities advertised by running processes */
export function getLiveCapabilities(): ReadonlyMap<string, string[]> {
  return liveCapabilities;
}

/** Send a notification to all active processes */
export function broadcastToProcesses(method: string, params?: unknown): void {
  for (const [processId, managed] of processes) {
    if (managed.info.alive) {
      notify(processId, method, params);
    }
  }
}

// ---------------------------------------------------------------------------
// Capability routing
// ---------------------------------------------------------------------------

/**
 * Find a running process by agent registry ID.
 */
export function getProcessByAgentId(agentId: string): SubAgentProcess | undefined {
  return listActive().find(p => p.agentId === agentId);
}

/**
 * Route a task to the best available agent with the required capability.
 * Queries registry, picks highest evolution_score, spawns the agent.
 * Returns null if no agent found with the capability.
 */
export async function route(
  capability: string,
  options?: Partial<{
    system_prompt?: string;
    tools_allowed?: string[];
    permission_level?: string;
    llm_provider?: string;
    llm_model?: string;
    max_tool_iterations?: number;
    tenant_id?: string;
  }>,
  tenantId?: string,
): Promise<{ process: SubAgentProcess; agentId: string } | null> {
  const { findBestForCapability } = await import('./registry.js');
  const effectiveTenantId = resolveTenantId(options?.tenant_id ?? tenantId);
  const agent = findBestForCapability(capability, effectiveTenantId);
  if (!agent) {
    logger.warn({ capability, tenantId: effectiveTenantId }, 'No agent found for capability');
    return null;
  }

  const proc = spawn(agent.id, {
    system_prompt: agent.system_prompt,
    tools_allowed: agent.tools_allowed,
    permission_level: agent.permission_level,
    ...options,
    tenant_id: resolveTenantId(options?.tenant_id ?? tenantId ?? agent.tenant_id),
  });

  return { process: proc, agentId: agent.id };
}

/**
 * Forward a message from one agent process to another.
 * Persists via messaging.send() and delivers live via forwardToProcess() if target is alive.
 */
export async function forward(
  fromProcessId: string,
  toProcessId: string,
  message: AgentMessage,
): Promise<void> {
  const { send: sendMsg, forwardToProcess } = await import('./messaging.js');

  // Persist the message
  sendMsg(message);

  // Try live delivery if target process is running
  const target = getProcess(toProcessId);
  if (target?.alive) {
    try {
      forwardToProcess(toProcessId, message);
    } catch (err) {
      logger.warn({ toProcessId, err }, 'Live delivery failed, message persisted in queue');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal message handling
// ---------------------------------------------------------------------------

function handleMessage(managed: ManagedProcess, msg: Record<string, unknown>): void {
  // Handle heartbeat notifications
  if (msg.method === 'heartbeat') {
    managed.info.lastHeartbeat = Date.now();
    return;
  }

  // Handle JSON-RPC responses
  if ('id' in msg && msg.id !== undefined) {
    const pending = managed.pendingRequests.get(msg.id as string | number);
    if (pending) {
      clearTimeout(pending.timer);
      managed.pendingRequests.delete(msg.id as string | number);
      if (msg.error) {
        const err = msg.error as { message: string };
        pending.reject(new Error(err.message || 'RPC error'));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Handle capability_ad notifications from subagents
  if (msg.method === 'capability_ad' && !('id' in msg && msg.id !== undefined)) {
    const params = msg.params as { capabilities: string[] };
    if (Array.isArray(params?.capabilities)) {
      liveCapabilities.set(managed.info.id, params.capabilities);
      logger.info({ processId: managed.info.id, capabilities: params.capabilities }, 'Capability advertisement received');
    }
    return;
  }

  // Handle peer_request notifications from subagents
  if (msg.method === 'peer_request' && !('id' in msg && msg.id !== undefined)) {
    const params = msg.params as { request_id: string; capability: string; objective: string; tenant_id?: string; timeout_ms?: number };
    const proc = managed;
    const tenantId = resolveTenantId(params.tenant_id);
    const timeoutMs = params.timeout_ms || 30000;
    logger.info({ processId: proc.info.id, ...params }, 'Peer request from subagent');
    // Route asynchronously — don't block the stdio handler
    route(params.capability, undefined, tenantId).then(async (routed) => {
      if (!routed) {
        logEvent('peer_task_failed', 'agent', proc.info.agentId, {
          request_id: params.request_id,
          capability: params.capability,
          reason: 'No agent found for capability',
        }, tenantId);
        notify(proc.info.id, 'agent_message', {
          type: 'peer_response',
          from: 'system',
          payload: { request_id: params.request_id, status: 'failed', reason: 'No agent found for capability' },
        });
        return;
      }
      try {
        const result = await send(routed.process.id, 'execute_task', {
          task_id: `peer_${params.request_id}`,
          objective: params.objective,
        }, timeoutMs);
        logEvent('peer_task_completed', 'agent', routed.agentId, {
          request_id: params.request_id,
          capability: params.capability,
          requester_process: proc.info.id,
        }, tenantId);
        notify(proc.info.id, 'agent_message', {
          type: 'peer_response',
          from: routed.agentId,
          payload: { request_id: params.request_id, status: 'completed', result },
        });
      } catch (err) {
        logEvent('peer_task_failed', 'agent', routed.agentId, {
          request_id: params.request_id,
          capability: params.capability,
          error: String(err),
        }, tenantId);
        notify(proc.info.id, 'agent_message', {
          type: 'peer_response',
          from: routed.agentId,
          payload: { request_id: params.request_id, status: 'failed', reason: String(err) },
        });
      } finally {
        kill(routed.process.id);
      }
    }).catch(err => {
      logger.error({ err, processId: proc.info.id }, 'Peer routing failed');
    });
    return;
  }

  // Handle other notifications
  logger.debug({ processId: managed.info.id, method: msg.method }, 'SubAgent notification');
}

function clearHeartbeatMonitor(managed: ManagedProcess): void {
  if (managed.heartbeatTimer) {
    clearInterval(managed.heartbeatTimer);
    managed.heartbeatTimer = null;
  }
}
