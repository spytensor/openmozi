/**
 * Managed worker delegation tools.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../core/llm.js';
import { getConfig } from '../config/index.js';
import { TaskBriefSchema, type TaskBrief } from '../agents/protocol.js';
import type {
  ExternalWorkerAgentConfig,
  ManagedWorkerTaskInput,
  WorkerAdapter,
  WorkerAdapterRegistry,
  WorkerExecutionLane,
} from '../workers/adapter.js';
import { dispatchManagedWorkerTask } from '../workers/dispatch.js';
import { getExternalWorkerJob } from '../workers/job-state.js';
import { getDefaultWorkerAdapterRegistry } from '../workers/index.js';
import { inspectManagedWorkerPreflight, type WorkerPreflightReport } from '../workers/preflight.js';
import type { ToolContext, ToolResult } from './types.js';
import { buildManagedCodingWorkerPrompt } from '../core/delegation-prompt.js';

const CodingWorkerIdSchema = z.string().min(1);
type CodingWorkerId = z.infer<typeof CodingWorkerIdSchema>;

const DelegateCodingTaskInputSchema = z.object({
  task_id: z.string().min(1).optional(),
  objective: z.string().min(1),
  done_criteria: z.string().default(''),
  acceptance_criteria: z.array(z.string()).default([]),
  required_tests: z.array(z.string()).default([]),
  allowed_scope: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  context_refs: z.array(z.string()).default([]),
  timeout_seconds: z.number().int().min(1).max(7200).default(900),
  token_budget: z.number().int().min(1).default(20_000),
  permission_level: z.string().default('L2_SHELL_EXEC'),
  allowed_tools: z.array(z.string()).default(['filesystem', 'shell', 'git']),
  forbidden_paths: z.array(z.string()).default([]),
  lane: z.enum(['review', 'code']).default('code'),
  complexity: z.enum(['low', 'medium', 'high']).default('medium'),
  estimated_tokens: z.number().int().min(1).default(4000),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
type DelegateCodingTaskInput = z.infer<typeof DelegateCodingTaskInputSchema>;

type CodingWorkerConfig = {
  routing?: 'auto' | CodingWorkerId;
  available?: CodingWorkerId[];
};

type DelegationDeps = {
  getConfig: typeof getConfig;
  getRegistry: () => WorkerAdapterRegistry;
  inspectPreflight: typeof inspectManagedWorkerPreflight;
  dispatch: typeof dispatchManagedWorkerTask;
};

const defaultDeps: DelegationDeps = {
  getConfig,
  getRegistry: getDefaultWorkerAdapterRegistry,
  inspectPreflight: inspectManagedWorkerPreflight,
  dispatch: dispatchManagedWorkerTask,
};

let testDeps: Partial<DelegationDeps> | null = null;

export function __setDelegateCodingTaskDepsForTests(deps: Partial<DelegationDeps> | null): void {
  testDeps = deps;
}

function getDeps(): DelegationDeps {
  return {
    ...defaultDeps,
    ...(testDeps ?? {}),
  };
}

export const delegateCodingTaskTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_coding_task',
    description: 'Delegate a concrete coding or code-review task to the managed external worker runtime. Use for substantial repository work that benefits from a real CLI worker. This tool creates a durable external_worker_jobs record and never silently falls back to in-process chat.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Optional stable task ID. Omit to let runtime generate one.',
        },
        objective: {
          type: 'string',
          description: 'Specific coding objective for the worker.',
        },
        done_criteria: {
          type: 'string',
          description: 'How the worker should know the task is complete.',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete verifier criteria expected in the worker result.',
        },
        required_tests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests the worker should run and report when applicable.',
        },
        allowed_scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, directories, or modules the worker is allowed to touch.',
        },
        non_goals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit out-of-scope work for the worker.',
        },
        context_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant files, docs, issues, or task IDs the worker should inspect.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Worker inactivity timeout in seconds. Defaults to 900.',
        },
        token_budget: {
          type: 'number',
          description: 'Token budget hint for the managed worker.',
        },
        permission_level: {
          type: 'string',
          description: 'Requested permission level for the task brief.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool classes the worker may use.',
        },
        forbidden_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths the worker must not touch.',
        },
        lane: {
          type: 'string',
          enum: ['review', 'code'],
          description: 'Managed worker lane. review selects read-only defaults; code selects workspace-write defaults.',
        },
        complexity: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Complexity hint for the task brief.',
        },
        estimated_tokens: {
          type: 'number',
          description: 'Estimated tokens needed by the worker.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory, resolved by the worker adapter.',
        },
        model: {
          type: 'string',
          description: 'Optional model hint for the configured worker adapter.',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  },
};

export const DELEGATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  delegateCodingTaskTool,
];

function buildTaskBrief(input: DelegateCodingTaskInput): TaskBrief {
  return TaskBriefSchema.parse({
    task_id: input.task_id ?? `coding_task_${randomUUID()}`,
    objective: input.objective,
    done_criteria: input.done_criteria,
    context_refs: input.context_refs,
    constraints: {
      token_budget: input.token_budget,
      timeout_seconds: input.timeout_seconds,
      permission_level: input.permission_level,
      allowed_tools: input.allowed_tools,
      forbidden_paths: input.forbidden_paths,
    },
    hints: {
      complexity: input.complexity,
      type: input.lane === 'review' ? 'review' : 'code',
      needs_tool_calling: true,
      estimated_tokens: input.estimated_tokens,
    },
  });
}

function readCodingWorkerConfig(config: unknown): CodingWorkerConfig | null {
  const raw = (config as { coding_worker?: unknown }).coding_worker;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const supported = (id: unknown): id is CodingWorkerId => id === 'claude_code' || id === 'codex_cli';
  const routingParse = z.union([z.literal('auto'), CodingWorkerIdSchema]).safeParse(obj.routing);
  const availableParse = z.array(CodingWorkerIdSchema).safeParse(obj.available);
  return {
    routing: routingParse.success && (routingParse.data === 'auto' || supported(routingParse.data))
      ? routingParse.data
      : 'auto',
    available: availableParse.success ? availableParse.data.filter(supported) : [],
  };
}

function orderedCandidates(config: CodingWorkerConfig | null): CodingWorkerId[] {
  const available = config?.available ?? [];
  const routing = config?.routing ?? 'auto';
  if (routing === 'auto') return [...available];
  return [routing, ...available.filter((id) => id !== routing)];
}

/**
 * Whether any coding worker is configured at all. Used to gate registration of
 * delegate_coding_task: without a configured worker the tool can only ever
 * return "worker not ready", so exposing it would claim delegation capability
 * the runtime does not have.
 */
export function isCodingWorkerConfigured(config: unknown): boolean {
  return orderedCandidates(readCodingWorkerConfig(config)).length > 0;
}

function buildWorkerConfig(
  adapterId: CodingWorkerId,
  input: DelegateCodingTaskInput,
  lane: WorkerExecutionLane,
): ExternalWorkerAgentConfig {
  return {
    adapter: adapterId,
    transport: 'stdio',
    cwd: input.cwd,
    model: input.model,
    args: [],
    env: {},
    metadata: { lane },
    transport_options: {},
  };
}

function requiresDeclaredCommand(adapterId: string): boolean {
  return adapterId === 'claude_code' || adapterId === 'codex_cli';
}

function isWorkerReady(adapter: WorkerAdapter, preflight: WorkerPreflightReport): boolean {
  if (preflight.status !== 'ready') return false;
  if (requiresDeclaredCommand(adapter.metadata.id) && !preflight.command_path) return false;
  return true;
}

function readinessSummary(adapterId: string, preflight: WorkerPreflightReport): string {
  const checks = preflight.checks
    .filter((check) => !check.ok)
    .map((check) => check.summary);
  const detail = checks.length > 0 ? checks.join('; ') : preflight.summary;
  return `${adapterId}: ${detail}`;
}

async function selectReadyWorker(input: DelegateCodingTaskInput, task: TaskBrief, deps: DelegationDeps): Promise<{
  worker: ExternalWorkerAgentConfig;
  adapter: WorkerAdapter;
  preflight: WorkerPreflightReport;
} | {
  error: string;
  details: string[];
}> {
  const config = readCodingWorkerConfig(deps.getConfig());
  const candidates = orderedCandidates(config);
  if (candidates.length === 0) {
    return {
      error: 'coding_worker.available is empty',
      details: ['No ready coding worker is configured. Run onboarding or configure coding_worker with a ready CLI worker.'],
    };
  }

  const registry = deps.getRegistry();
  const details: string[] = [];
  const lane = input.lane;

  for (const adapterId of candidates) {
    const adapter = registry.get(adapterId);
    if (!adapter) {
      details.push(`${adapterId}: worker adapter is not registered`);
      continue;
    }

    const worker = buildWorkerConfig(adapterId, input, lane);
    const preflightInput: ManagedWorkerTaskInput = {
      job_id: `readiness_${randomUUID()}`,
      agent_id: `coding_worker:${adapterId}`,
      tenant_id: 'default',
      task,
      system_prompt: '',
      worker,
      timeout_ms: input.timeout_seconds * 1000,
    };
    const preflight = await deps.inspectPreflight(preflightInput, adapter, { liveProbe: false });

    if (isWorkerReady(adapter, preflight)) {
      return { worker, adapter, preflight };
    }
    details.push(readinessSummary(adapterId, preflight));
  }

  return {
    error: 'no configured coding worker is ready',
    details,
  };
}

function workerNotReadyResult(id: string, reason: string, details: string[]): ToolResult {
  return {
    tool_call_id: id,
    tool_name: 'delegate_coding_task',
    content: [
      'Delegation failed: worker not ready',
      JSON.stringify({ reason, details }, null, 2),
    ].join('\n'),
    is_error: true,
  };
}

function isWorkerReadinessError(message: string): boolean {
  return /preflight|not found|not configured|not registered|not support|credentials|auth|worker.*down/i.test(message);
}

export async function executeDelegationTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'delegate_coding_task') return null;

  const input = DelegateCodingTaskInputSchema.parse(args);
  const task = buildTaskBrief(input);
  const deps = getDeps();
  const selected = await selectReadyWorker(input, task, deps);
  if ('error' in selected) {
    return workerNotReadyResult(id, selected.error, selected.details);
  }

  const jobId = `external_worker_${randomUUID()}`;
  const metadata = {
    chat_id: context?.chatId,
    session_id: context?.sessionId,
    turn_id: context?.turnId,
    user_id: context?.userId,
    objective: input.objective,
    acceptance_criteria: input.acceptance_criteria,
    required_tests: input.required_tests,
    allowed_scope: input.allowed_scope,
    non_goals: input.non_goals,
    working_directory: input.cwd,
    worker_preflight: selected.preflight,
  };

  try {
    const result = await deps.dispatch({
      job_id: jobId,
      agent_id: `coding_worker:${selected.adapter.metadata.id}`,
      tenant_id: context?.tenantId ?? 'default',
      task,
      system_prompt: buildManagedCodingWorkerPrompt(),
      worker: selected.worker,
      timeout_ms: input.timeout_seconds * 1000,
      metadata,
      abort_signal: context?.abortSignal,
    }, deps.getRegistry());

    const persisted = getExternalWorkerJob(result.job_id, context?.tenantId ?? 'default');
    return {
      tool_call_id: id,
      tool_name: 'delegate_coding_task',
      content: JSON.stringify({
        job_id: result.job_id,
        task_id: task.task_id,
        job_status: persisted?.status ?? null,
        worker: {
          adapter_id: result.adapter_id,
          runtime_label: result.runtime_label,
          run_id: result.run_id,
        },
        result: {
          status: result.envelope.status,
          summary: result.envelope.summary,
          output: result.envelope.output,
          issues: result.envelope.issues,
          cost: result.envelope.cost,
        },
        verify_status: result.verify_status,
        verify_summary: result.verify_summary,
      }, null, 2),
      is_error: false,
      produced_files: result.artifacts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefix = isWorkerReadinessError(message)
      ? 'Delegation failed: worker not ready'
      : 'Delegation failed';
    return {
      tool_call_id: id,
      tool_name: 'delegate_coding_task',
      content: `${prefix}: ${message}`,
      is_error: true,
    };
  }
}
