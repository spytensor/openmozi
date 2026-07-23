import { z } from 'zod';
import { getDb } from '../store/db.js';

export const RuntimeStateKindSchema = z.enum([
  'session_hard_state',
  'task_execution_state',
  'worker_runtime_state',
  'checkpoint_state',
]);
export type RuntimeStateKind = z.infer<typeof RuntimeStateKindSchema>;

export const RuntimeStateScopeSchema = z.enum([
  'session',
  'task',
  'worker',
  'checkpoint',
  'chat',
]);
export type RuntimeStateScope = z.infer<typeof RuntimeStateScopeSchema>;

export const CheckpointFileStateSchema = z.object({
  path: z.string(),
  hash_before: z.string().nullable().optional().default(null),
  hash_after: z.string().nullable().optional().default(null),
});
export type CheckpointFileState = z.infer<typeof CheckpointFileStateSchema>;

export const CheckpointHardStateSchema = z.object({
  checkpoint_id: z.string(),
  task_id: z.string(),
  step_index: z.number().int().nonnegative(),
  files: z.array(CheckpointFileStateSchema).default([]),
  db_mutations: z.unknown().nullable().default(null),
  rollback_commands: z.array(z.string()).default([]),
  created_at: z.string(),
});
export type CheckpointHardState = z.infer<typeof CheckpointHardStateSchema>;

export const TaskCheckpointRefSchema = z.object({
  checkpoint_id: z.string(),
  step_index: z.number().int().nonnegative(),
  created_at: z.string(),
});
export type TaskCheckpointRef = z.infer<typeof TaskCheckpointRefSchema>;

export const TaskExecutionStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assigned_agent: z.string().nullable().default(null),
  progress: z.string().default(''),
  key_output: z.string().default(''),
  checkpoints: z.array(TaskCheckpointRefSchema).default([]),
});
export type TaskExecutionState = z.infer<typeof TaskExecutionStateSchema>;

export const WorkerRuntimeStateSchema = z.object({
  id: z.string(),
  role: z.string(),
  status: z.string(),
  task_id: z.string().nullable().default(null),
});
export type WorkerRuntimeState = z.infer<typeof WorkerRuntimeStateSchema>;

export const SessionHardStateSchema = z.object({
  session_id: z.string(),
  state: z.enum(['IDLE', 'WORKING', 'RESPONDING']).default('IDLE'),
  file_changes: z.array(z.string()).default([]),
  active_task_ids: z.array(z.string()).default([]),
  active_worker_ids: z.array(z.string()).default([]),
  checkpoint_ids: z.array(z.string()).default([]),
});
export type SessionHardState = z.infer<typeof SessionHardStateSchema>;

export const HardStateBundleSchema = z.object({
  session: SessionHardStateSchema,
  tasks: z.array(TaskExecutionStateSchema).default([]),
  workers: z.array(WorkerRuntimeStateSchema).default([]),
  checkpoints: z.array(CheckpointHardStateSchema).default([]),
});
export type HardStateBundle = z.infer<typeof HardStateBundleSchema>;

interface RuntimeStateRow {
  payload: string;
}

export function buildCheckpointHardState(input: {
  checkpoint_id: string;
  task_id: string;
  step_index: number;
  files: Array<{
    path: string;
    hash_before?: string | null;
    hash_after?: string | null;
  }>;
  db_mutations?: unknown;
  rollback_commands?: string[] | null;
  created_at?: string;
}): CheckpointHardState {
  return CheckpointHardStateSchema.parse({
    checkpoint_id: input.checkpoint_id,
    task_id: input.task_id,
    step_index: input.step_index,
    files: input.files,
    db_mutations: input.db_mutations ?? null,
    rollback_commands: input.rollback_commands ?? [],
    created_at: input.created_at ?? new Date().toISOString(),
  });
}

export function buildHardStateBundle(input: {
  session_id: string;
  session_state?: SessionHardState['state'];
  file_changes?: string[];
  tasks?: TaskExecutionState[];
  workers?: WorkerRuntimeState[];
  checkpoints?: CheckpointHardState[];
}): HardStateBundle {
  const tasks = (input.tasks ?? []).map(task => TaskExecutionStateSchema.parse(task));
  const workers = (input.workers ?? []).map(worker => WorkerRuntimeStateSchema.parse(worker));
  const checkpoints = (input.checkpoints ?? []).map(checkpoint => CheckpointHardStateSchema.parse(checkpoint));

  return HardStateBundleSchema.parse({
    session: {
      session_id: input.session_id,
      state: input.session_state ?? 'IDLE',
      file_changes: input.file_changes ?? [],
      active_task_ids: tasks.map(task => task.id),
      active_worker_ids: workers.map(worker => worker.id),
      checkpoint_ids: checkpoints.map(checkpoint => checkpoint.checkpoint_id),
    },
    tasks,
    workers,
    checkpoints,
  });
}

export function upsertRuntimeState<T>(
  kind: RuntimeStateKind,
  scopeType: RuntimeStateScope,
  scopeId: string,
  payload: T,
  tenantId = 'default',
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO runtime_state (
      tenant_id,
      state_kind,
      scope_type,
      scope_id,
      payload,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(tenant_id, state_kind, scope_type, scope_id)
    DO UPDATE SET
      payload = excluded.payload,
      updated_at = datetime('now')
  `).run(tenantId, kind, scopeType, scopeId, JSON.stringify(payload));
}

export function getRuntimeState<T>(
  kind: RuntimeStateKind,
  scopeType: RuntimeStateScope,
  scopeId: string,
  schema: z.ZodType<T>,
  tenantId = 'default',
): T | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT payload
    FROM runtime_state
    WHERE tenant_id = ? AND state_kind = ? AND scope_type = ? AND scope_id = ?
    LIMIT 1
  `).get(tenantId, kind, scopeType, scopeId) as RuntimeStateRow | undefined;

  if (!row) return null;
  return schema.parse(JSON.parse(row.payload));
}

export function persistHardStateBundle(bundle: HardStateBundle, tenantId = 'default'): void {
  const db = getDb();
  db.transaction(() => {
    upsertRuntimeState('session_hard_state', 'session', bundle.session.session_id, bundle, tenantId);

    for (const task of bundle.tasks) {
      upsertRuntimeState('task_execution_state', 'task', task.id, task, tenantId);
    }

    for (const worker of bundle.workers) {
      upsertRuntimeState('worker_runtime_state', 'worker', worker.id, worker, tenantId);
    }

    for (const checkpoint of bundle.checkpoints) {
      upsertRuntimeState('checkpoint_state', 'checkpoint', checkpoint.checkpoint_id, checkpoint, tenantId);
    }
  })();
}

export function formatHardStateBundleForPrompt(bundle: HardStateBundle): string {
  const parts: string[] = [];

  parts.push('--- Hard State ---');
  parts.push(`Session: ${bundle.session.session_id} (${bundle.session.state})`);

  if (bundle.tasks.length > 0) {
    parts.push('Tasks:');
    for (const task of bundle.tasks) {
      const progress = task.progress ? ` (${task.progress})` : '';
      parts.push(`  ${task.id}: ${task.title} [${task.status}]${progress}`);
    }
  }

  if (bundle.workers.length > 0) {
    parts.push('Workers:');
    for (const worker of bundle.workers) {
      const taskRef = worker.task_id ? ` -> ${worker.task_id}` : '';
      parts.push(`  ${worker.id}: ${worker.role} [${worker.status}]${taskRef}`);
    }
  }

  if (bundle.checkpoints.length > 0) {
    parts.push('Checkpoints:');
    for (const checkpoint of bundle.checkpoints) {
      parts.push(
        `  ${checkpoint.checkpoint_id}: task=${checkpoint.task_id} step=${checkpoint.step_index} files=${checkpoint.files.length}`,
      );
    }
  }

  if (bundle.session.file_changes.length > 0) {
    parts.push('File Changes:');
    for (const fileChange of bundle.session.file_changes) {
      parts.push(`  ${fileChange}`);
    }
  }

  return parts.join('\n');
}
