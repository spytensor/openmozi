import { z } from 'zod';
import { TaskBriefSchema, ResultEnvelopeSchema, type TaskBrief, type ResultEnvelope } from '../agents/protocol.js';
import {
  ExternalWorkerTransportOptionsSchema,
  WorkerTransportKindSchema,
  type WorkerTransportKind,
} from './transport.js';

export const ExternalWorkerAgentConfigSchema = z.object({
  adapter: z.string().min(1),
  transport: WorkerTransportKindSchema.default('stdio'),
  cwd: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  transport_options: ExternalWorkerTransportOptionsSchema.default({}),
});

export type ExternalWorkerAgentConfig = z.infer<typeof ExternalWorkerAgentConfigSchema>;

export type WorkerExecutionLane = 'review' | 'code' | 'dangerous';
export type WorkerSandboxProfile = 'read-only' | 'workspace-write' | 'full-access' | 'adapter-managed';

export function resolveExternalWorkerAgentConfig(
  agentConfig?: Record<string, unknown>,
): ExternalWorkerAgentConfig | null {
  const raw = agentConfig?.external_worker;
  if (raw === undefined || raw === null) return null;

  const parsed = ExternalWorkerAgentConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map(issue => `${issue.path.join('.') || 'external_worker'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid external_worker config: ${issues}`);
}

export const WorkerLaunchRequestSchema = z.object({
  job_id: z.string().min(1),
  tenant_id: z.string().default('default'),
  task: TaskBriefSchema,
  system_prompt: z.string().default(''),
  timeout_ms: z.number().int().positive().optional(),
  transport: WorkerTransportKindSchema.default('stdio'),
  adapter_config: ExternalWorkerAgentConfigSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type WorkerLaunchRequest = z.infer<typeof WorkerLaunchRequestSchema>;

export type WorkerLifecycleState =
  | 'launching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkerHandle {
  id: string;
  job_id: string;
  adapter_id: string;
  transport: WorkerTransportKind;
  pid?: number;
  started_at: number;
  metadata?: Record<string, unknown>;
}

export interface WorkerStatus {
  state: WorkerLifecycleState;
  pid?: number;
  exit_code?: number | null;
  error?: string;
  started_at: number;
  completed_at?: number;
}

export interface WorkerLaunchResult {
  handle: WorkerHandle;
  status: WorkerStatus;
}

export const WorkerCollectResultSchema = z.object({
  envelope: ResultEnvelopeSchema,
  artifacts: z.array(z.string()).default([]),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  runtime_label: z.string().optional(),
});

export type WorkerCollectResult = z.infer<typeof WorkerCollectResultSchema>;

export interface WorkerAdapterMetadata {
  id: string;
  display_name: string;
  kind: 'external_cli';
  supported_transports: readonly WorkerTransportKind[];
  supported_lanes?: readonly WorkerExecutionLane[];
  supported_sandbox_profiles?: readonly WorkerSandboxProfile[];
  description?: string;
}

export interface WorkerAdapter {
  readonly metadata: WorkerAdapterMetadata;
  supportsTransport(transport: string): boolean;
  launch(request: WorkerLaunchRequest): Promise<WorkerLaunchResult>;
  poll(handle: WorkerHandle): Promise<WorkerStatus>;
  waitForCompletion?(handle: WorkerHandle, timeoutMs?: number): Promise<WorkerStatus>;
  cancel(handle: WorkerHandle, reason?: string): Promise<void>;
  collectResult(handle: WorkerHandle): Promise<WorkerCollectResult>;
}

export function isTerminalWorkerState(state: WorkerLifecycleState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function buildManagedWorkerFailureEnvelope(
  taskId: string,
  message: string,
  elapsedMs = 0,
): ResultEnvelope {
  return ResultEnvelopeSchema.parse({
    task_id: taskId,
    status: 'failed',
    output: [],
    summary: message,
    cost: {
      tokens: 0,
      tool_calls: 0,
      elapsed_time: elapsedMs,
    },
    issues: [message],
  });
}

export class WorkerAdapterRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();

  constructor(initialAdapters: WorkerAdapter[] = []) {
    for (const adapter of initialAdapters) {
      this.register(adapter);
    }
  }

  register(adapter: WorkerAdapter): void {
    this.adapters.set(adapter.metadata.id, adapter);
  }

  get(id: string): WorkerAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  list(): WorkerAdapterMetadata[] {
    return [...this.adapters.values()].map(adapter => adapter.metadata);
  }
}

export type ManagedWorkerTaskInput = {
  job_id: string;
  agent_id: string;
  tenant_id: string;
  task: TaskBrief;
  system_prompt: string;
  worker: ExternalWorkerAgentConfig;
  timeout_ms: number;
  metadata?: Record<string, unknown>;
  abort_signal?: AbortSignal;
};

export type ManagedWorkerVerifyStatus = 'not_required' | 'pending' | 'passed' | 'failed' | 'skipped';

export type ManagedWorkerTaskResult = {
  job_id: string;
  envelope: ResultEnvelope;
  run_id: string;
  runtime_label: string;
  adapter_id: string;
  verify_status: ManagedWorkerVerifyStatus;
  verify_summary: string;
  artifacts: string[];
};
