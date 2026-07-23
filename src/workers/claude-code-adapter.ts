import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getProvider } from '../core/providers.js';
import { resolveCliPromptDelivery, writeCliPromptToStdin } from '../core/cli-prompt-delivery.js';
import { assertCliSpawnBudget } from '../core/cli-spawn-budget.js';
import { buildSubagentEnv } from '../agents/process-manager.js';
import {
  ResultEnvelopeSchema,
  type ResultEnvelope,
} from '../agents/protocol.js';
import type {
  WorkerAdapter,
  WorkerCollectResult,
  WorkerHandle,
  WorkerLaunchRequest,
  WorkerLaunchResult,
  WorkerLifecycleState,
  WorkerStatus,
} from './adapter.js';
import {
  getDefaultWorkerTransportRegistry,
  type WorkerTransportRegistry,
} from './transport.js';
import { getRuntimeProjectRoot, resolveProjectRelativePath } from '../runtime/project-root.js';
import {
  buildManagedWorkerTaskPrompt,
  formatCliWorkerSystemPromptValue,
  parseCliWorkerOutput,
  sanitizeCliWorkerEnv,
} from './cli-worker-utils.js';
import { resolveWorkerExecutionLane, resolveWorkerSandboxProfile } from './preflight.js';

type ClaudeBackend = {
  command: string;
  args: string[];
  modelArg?: string;
  systemPromptArg?: string;
  systemPromptFormat: 'raw' | 'codex-config-instructions';
  mcpConfigArg?: string;
  strictMcpConfigFlag?: string;
  input: 'arg' | 'stdin';
  maxPromptArgBytes?: number;
  stdinPromptArgs?: string[];
};

type ActiveRun = {
  request: WorkerLaunchRequest;
  handle: WorkerHandle;
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  state: WorkerLifecycleState;
  exitCode: number | null;
  error?: string;
  cancelReason?: string;
  completedAt?: number;
  completion: Promise<void>;
  resolveCompletion: () => void;
  completionResolved: boolean;
  collected?: WorkerCollectResult;
  artifacts: string[];
};

function resolveClaudeBackend(): ClaudeBackend {
  const backend = getProvider('claude-cli')?.cliBackend;
  if (!backend?.command) {
    throw new Error('Claude CLI backend is not configured');
  }

  return {
    command: backend.command,
    args: [...backend.args],
    modelArg: backend.modelArg,
    systemPromptArg: backend.systemPromptArg,
    systemPromptFormat: backend.systemPromptFormat ?? 'raw',
    mcpConfigArg: backend.mcpConfigArg,
    strictMcpConfigFlag: backend.strictMcpConfigFlag,
    input: backend.input,
    maxPromptArgBytes: backend.maxPromptArgBytes,
    stdinPromptArgs: backend.stdinPromptArgs,
  };
}

function toResultEnvelope(run: ActiveRun): ResultEnvelope {
  const stdout = run.stdout.join('');
  const stderr = run.stderr.join('').trim();
  const summary = parseCliWorkerOutput(stdout, 'json') || stderr || run.error || 'Claude Code worker finished without output';
  const elapsed = Math.max(0, Date.now() - run.handle.started_at);

  if (run.state === 'cancelled') {
    return ResultEnvelopeSchema.parse({
      task_id: run.request.task.task_id,
      status: 'cancelled',
      output: [],
      summary: run.cancelReason || `Managed worker cancelled: ${run.request.task.task_id}`,
      cost: { tokens: 0, tool_calls: 0, elapsed_time: elapsed },
      issues: run.cancelReason ? [run.cancelReason] : [],
    });
  }

  if (run.state === 'failed') {
    const issue = run.error || stderr || parseCliWorkerOutput(stdout, 'json') || 'Claude Code worker failed';
    return ResultEnvelopeSchema.parse({
      task_id: run.request.task.task_id,
      status: 'failed',
      output: [issue],
      summary: issue,
      cost: { tokens: 0, tool_calls: 0, elapsed_time: elapsed },
      issues: [issue],
    });
  }

  return ResultEnvelopeSchema.parse({
    task_id: run.request.task.task_id,
    status: 'success',
    output: summary ? [summary] : [],
    summary: summary || 'Claude Code worker completed',
    cost: { tokens: 0, tool_calls: 0, elapsed_time: elapsed },
    issues: [],
  });
}

export class ClaudeCodeWorkerAdapter implements WorkerAdapter {
  readonly metadata;

  private readonly backend: ClaudeBackend;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly transportRegistry: WorkerTransportRegistry;

  constructor(transportRegistry: WorkerTransportRegistry = getDefaultWorkerTransportRegistry()) {
    this.backend = resolveClaudeBackend();
    this.transportRegistry = transportRegistry;
    this.metadata = {
      id: 'claude_code',
      display_name: 'Claude Code',
      kind: 'external_cli' as const,
      supported_transports: this.backend.mcpConfigArg ? ['stdio', 'mcp'] as const : ['stdio'] as const,
      supported_lanes: ['review', 'code'] as const,
      supported_sandbox_profiles: ['adapter-managed'] as const,
      description: 'Managed external worker adapter for Claude Code CLI',
    };
  }

  supportsTransport(transport: string): boolean {
    return transport === 'stdio' || (transport === 'mcp' && Boolean(this.backend.mcpConfigArg));
  }

  async launch(request: WorkerLaunchRequest): Promise<WorkerLaunchResult> {
    if (!this.supportsTransport(request.transport)) {
      throw new Error(`Worker adapter ${this.metadata.id} does not support transport: ${request.transport}`);
    }

    const args = request.adapter_config.args.length > 0
      ? [...request.adapter_config.args]
      : [...this.backend.args];

    const requestedModel = request.adapter_config.model?.trim().toLowerCase();
    const isRealModel = request.adapter_config.model
      && requestedModel !== 'auto'
      && requestedModel !== 'default'
      && requestedModel !== '_cli-default';
    if (isRealModel && this.backend.modelArg) {
      args.push(this.backend.modelArg, request.adapter_config.model!);
    }
    if (request.system_prompt && this.backend.systemPromptArg) {
      args.push(
        this.backend.systemPromptArg,
        formatCliWorkerSystemPromptValue(request.system_prompt, this.backend.systemPromptFormat),
      );
    }
    const promptDelivery = resolveCliPromptDelivery(
      buildManagedWorkerTaskPrompt(request.task),
      this.backend,
    );
    args.push(...promptDelivery.promptArgs);

    const prepared = await this.transportRegistry.get(request.transport)?.prepareLaunch({
      adapter_id: this.metadata.id,
      job_id: request.job_id,
      transport: request.transport,
      command: request.adapter_config.command || this.backend.command,
      args,
      cwd: request.adapter_config.cwd
        ? resolveProjectRelativePath(request.adapter_config.cwd)
        : getRuntimeProjectRoot(),
      env: {
        ...sanitizeCliWorkerEnv(buildSubagentEnv(process.env)),
        ...request.adapter_config.env,
      },
      transport_options: request.adapter_config.transport_options,
      adapter_capabilities: this.backend.mcpConfigArg
        ? {
          mcp: {
            config_arg: this.backend.mcpConfigArg,
            strict_config_flag: this.backend.strictMcpConfigFlag,
          },
        }
        : undefined,
    });

    if (!prepared) {
      throw new Error(`Unknown worker transport: ${request.transport}`);
    }

    const lane = resolveWorkerExecutionLane(request.task, request.adapter_config);
    const sandboxProfile = resolveWorkerSandboxProfile(this, lane);

    const handle: WorkerHandle = {
      id: `worker_${randomUUID()}`,
      job_id: request.job_id,
      adapter_id: this.metadata.id,
      transport: request.transport,
      started_at: Date.now(),
      metadata: {
        lane,
        sandbox_profile: sandboxProfile,
        ...prepared.metadata,
      },
    };

    let resolveCompletion = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    assertCliSpawnBudget(prepared.command, prepared.args, prepared.env);
    const child = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: [promptDelivery.mode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    handle.pid = child.pid;

    const run: ActiveRun = {
      request,
      handle,
      child,
      stdout: [],
      stderr: [],
      state: 'running',
      exitCode: null,
      completion,
      resolveCompletion,
      completionResolved: false,
      artifacts: prepared.artifacts,
    };

    const resolveRunCompletion = (): void => {
      if (run.completionResolved) return;
      run.completionResolved = true;
      run.resolveCompletion();
    };

    let promptDeliverySettleTimer: NodeJS.Timeout | undefined;
    let promptDeliveryError: string | undefined;
    const finishRun = (): void => {
      if (run.completionResolved) return;
      if (promptDeliverySettleTimer) clearTimeout(promptDeliverySettleTimer);
      run.completedAt = Date.now();
      resolveRunCompletion();
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      run.stdout.push(chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      run.stderr.push(chunk.toString());
    });

    child.on('error', (error) => {
      if (promptDeliveryError) {
        run.error = promptDeliveryError;
        if (run.state !== 'cancelled') run.state = 'failed';
        return;
      }
      run.error = error.message;
      run.state = run.state === 'cancelled' ? 'cancelled' : 'failed';
      finishRun();
    });

    child.on('close', (code) => {
      run.exitCode = code ?? null;
      if (run.state !== 'cancelled') {
        if (run.error) {
          run.state = 'failed';
        } else if ((code ?? 1) === 0) {
          run.state = 'completed';
        } else {
          run.state = 'failed';
          run.error = run.stderr.join('').trim() || `Claude Code exited with code ${code ?? 'unknown'}`;
        }
      }
      finishRun();
    });

    if (promptDelivery.stdinPayload !== undefined && child.stdin) {
      writeCliPromptToStdin(child.stdin, promptDelivery.stdinPayload, error => {
        promptDeliveryError ??= error.message;
        run.error = promptDeliveryError;
        if (run.state !== 'cancelled') run.state = 'failed';
        promptDeliverySettleTimer ??= setTimeout(() => {
          child.kill('SIGKILL');
          finishRun();
        }, 2_000);
        child.kill('SIGTERM');
      });
    }

    this.runs.set(handle.id, run);

    return {
      handle,
      status: this.snapshot(run),
    };
  }

  async poll(handle: WorkerHandle): Promise<WorkerStatus> {
    const run = this.getRun(handle);
    return this.snapshot(run);
  }

  async waitForCompletion(handle: WorkerHandle, timeoutMs?: number): Promise<WorkerStatus> {
    const run = this.getRun(handle);
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await run.completion;
      return this.snapshot(run);
    }

    await Promise.race([
      run.completion,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        run.completion.finally(() => clearTimeout(timer));
      }),
    ]);

    return this.snapshot(run);
  }

  async cancel(handle: WorkerHandle, reason?: string): Promise<void> {
    const run = this.getRun(handle);
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') {
      return;
    }

    run.cancelReason = reason;
    run.state = 'cancelled';
    run.child.kill('SIGTERM');
  }

  async collectResult(handle: WorkerHandle): Promise<WorkerCollectResult> {
    const run = this.getRun(handle);
    if (!run.collected) {
      await run.completion;

      run.collected = {
        envelope: toResultEnvelope(run),
        artifacts: [...run.artifacts],
        stdout: run.stdout.join(''),
        stderr: run.stderr.join(''),
        runtime_label: run.request.adapter_config.model || this.metadata.display_name,
      };
    }

    const result = run.collected;
    this.runs.delete(handle.id);
    return result;
  }

  private getRun(handle: WorkerHandle): ActiveRun {
    const run = this.runs.get(handle.id);
    if (!run) {
      throw new Error(`Unknown worker handle: ${handle.id}`);
    }
    return run;
  }

  private snapshot(run: ActiveRun): WorkerStatus {
    return {
      state: run.state,
      pid: run.handle.pid,
      exit_code: run.exitCode,
      error: run.error,
      started_at: run.handle.started_at,
      completed_at: run.completedAt,
    };
  }
}
