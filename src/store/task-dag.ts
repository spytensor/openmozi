/**
 * Task DAG — CRUD + dependency management for task directed acyclic graphs.
 *
 * Tasks can depend on other tasks via `depends_on`. A task becomes "ready"
 * when all its dependencies have completed. Topological sort determines
 * execution order. Dependency failure is handled per-task via `on_dep_failure`.
 */

import { getDb } from './db.js';
import { log as logEvent } from './events.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'mozi:task-dag' });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const TaskStatusEnum = z.enum([
  'pending', 'ready', 'assigned', 'running',
  'blocked', 'completed', 'failed', 'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const DepFailurePolicy = z.enum(['fail_fast', 'continue', 'fallback']);
export type DepFailurePolicyType = z.infer<typeof DepFailurePolicy>;

export const TaskConstraintsSchema = z.object({
  token_budget: z.number().optional(),
  timeout_seconds: z.number().min(10).max(600).optional(),
  max_retries: z.number().default(2),
  permission_level: z.string().default('L1_READ_WRITE'),
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  max_tokens: z.number().int().min(100).max(16000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tool_max_iterations: z.number().int().min(0).max(100).optional(),
  guard_reason: z.string().optional(),
  blocked_by_task_id: z.string().optional(),
  blocked_reason: z.string().optional(),
  retry_window_started_at: z.number().optional(),
  failure_retryable: z.boolean().optional(),
}).default({
  max_retries: 2,
  permission_level: 'L1_READ_WRITE',
  allowed_paths: [],
  forbidden_paths: [],
});

export const CreateTaskInput = z.object({
  tenant_id: z.string().default('default'),
  parent_task_id: z.string().nullable().default(null),
  title: z.string(),
  objective: z.string().default(''),
  done_criteria: z.string().default(''),
  depends_on: z.array(z.string()).default([]),
  constraints: TaskConstraintsSchema,
  priority: z.number().default(0),
  tags: z.array(z.string()).default([]),
  on_dep_failure: DepFailurePolicy.default('fail_fast'),
  agent_type_hint: z.string().default('any'),
});

export type CreateTaskInputType = z.input<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  parent_task_id: z.string().nullable().optional(),
  title: z.string().min(1).optional(),
  objective: z.string().optional(),
  done_criteria: z.string().optional(),
  priority: z.number().optional(),
  tags: z.array(z.string()).optional(),
  constraints: TaskConstraintsSchema.optional(),
  agent_type_hint: z.string().optional(),
});

export type UpdateTaskInputType = z.input<typeof UpdateTaskInput>;

export interface TaskRecord {
  id: string;
  tenant_id: string;
  parent_task_id: string | null;
  title: string;
  objective: string;
  done_criteria: string;
  status: TaskStatus;
  assigned_agent: string | null;
  agent_type_hint: string;
  constraints: z.infer<typeof TaskConstraintsSchema>;
  on_dep_failure: DepFailurePolicyType;
  attempts: number;
  priority: number;
  tags: string[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Ensure DAG columns exist (migration-safe)
// ---------------------------------------------------------------------------

function ensureDagColumns(): void {
  const db = getDb();

  // Add missing columns to tasks table if they don't exist
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));

  if (!colNames.has('on_dep_failure')) {
    db.exec("ALTER TABLE tasks ADD COLUMN on_dep_failure TEXT NOT NULL DEFAULT 'fail_fast'");
  }
  if (!colNames.has('agent_type_hint')) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_type_hint TEXT NOT NULL DEFAULT 'any'");
  }
  if (!colNames.has('constraints')) {
    db.exec("ALTER TABLE tasks ADD COLUMN constraints JSON DEFAULT '{}'");
  }
  if (!colNames.has('attempts')) {
    db.exec("ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  }
}

let columnsEnsured = false;

function ensureColumns(): void {
  if (!columnsEnsured) {
    ensureDagColumns();
    columnsEnsured = true;
  }
}

/** Reset the column-ensured flag (for testing) */
export function resetColumnsEnsured(): void {
  columnsEnsured = false;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Create a new task with optional dependencies */
export function create(input: CreateTaskInputType): TaskRecord {
  ensureColumns();
  const parsed = CreateTaskInput.parse(input);
  const id = randomUUID();
  const db = getDb();

  // Validate depends_on references exist
  for (const depId of parsed.depends_on) {
    const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(depId);
    if (!exists) {
      throw new Error(`Dependency task not found: ${depId}`);
    }
  }

  // Detect cycle before inserting
  if (parsed.depends_on.length > 0) {
    detectCycleBeforeInsert(id, parsed.depends_on, parsed.tenant_id);
  }

  // Determine initial status
  const status: TaskStatus = parsed.depends_on.length === 0 ? 'ready' : 'pending';

  db.prepare(`
    INSERT INTO tasks (id, tenant_id, parent_task_id, title, objective, done_criteria,
      status, priority, tags, on_dep_failure, agent_type_hint, constraints, attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id, parsed.tenant_id, parsed.parent_task_id, parsed.title,
    parsed.objective, parsed.done_criteria, status, parsed.priority,
    JSON.stringify(parsed.tags), parsed.on_dep_failure, parsed.agent_type_hint,
    JSON.stringify(parsed.constraints),
  );

  // Insert dependencies
  for (const depId of parsed.depends_on) {
    db.prepare(`
      INSERT INTO task_dependencies (tenant_id, task_id, depends_on_task_id)
      VALUES (?, ?, ?)
    `).run(parsed.tenant_id, id, depId);
  }

  logEvent('task_created', 'task', id, { title: parsed.title, depends_on: parsed.depends_on }, parsed.tenant_id);
  logger.info({ task_id: id, title: parsed.title, status }, 'Task created');

  return getById(id, parsed.tenant_id)!;
}

/** Get a task by ID */
export function getById(id: string, tenantId = 'default'): TaskRecord | null {
  ensureColumns();
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return deserializeRow(row);
}

/** List tasks with optional filters */
export function listTasks(
  filters: { tenant_id?: string; status?: TaskStatus; parent_task_id?: string | null } = {}
): TaskRecord[] {
  ensureColumns();
  const db = getDb();
  const tenantId = filters.tenant_id ?? 'default';
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.parent_task_id !== undefined) {
    if (filters.parent_task_id === null) {
      conditions.push('parent_task_id IS NULL');
    } else {
      conditions.push('parent_task_id = ?');
      params.push(filters.parent_task_id);
    }
  }

  const rows = db.prepare(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY priority ASC, created_at ASC`
  ).all(...params) as Record<string, unknown>[];

  return rows.map(deserializeRow);
}

/** Get all tasks with status "ready", sorted by priority */
export function getReady(tenantId = 'default'): TaskRecord[] {
  return listTasks({ tenant_id: tenantId, status: 'ready' });
}

/** Tag that marks a task row as a plan root (decompose_task grouping node). */
export const PLAN_ROOT_TAG = 'plan:root';

/**
 * List plan root tasks (decompose_task grouping nodes), newest first.
 * Optionally filter to non-terminal roots only.
 */
export function listPlanRootTasks(
  tenantId = 'default',
  options: { activeOnly?: boolean; limit?: number } = {},
): TaskRecord[] {
  ensureColumns();
  const db = getDb();
  const conditions = ['tenant_id = ?', 'parent_task_id IS NULL', 'tags LIKE ?'];
  const params: unknown[] = [tenantId, `%"${PLAN_ROOT_TAG}"%`];
  if (options.activeOnly) {
    conditions.push("status NOT IN ('completed', 'failed', 'cancelled')");
  }
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`
  ).all(...params) as Record<string, unknown>[];
  return rows.map(deserializeRow);
}

/** Update task status */
export function updateStatus(
  id: string,
  status: TaskStatus,
  tenantId = 'default',
  metadata: Record<string, unknown> = {},
): TaskRecord | null {
  ensureColumns();
  const db = getDb();
  db.prepare(`
    UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?
  `).run(status, id, tenantId);

  logEvent('task_status_changed', 'task', id, { status, ...metadata }, tenantId);
  return getById(id, tenantId);
}

/** Update task metadata without changing execution status. */
export function updateTask(
  id: string,
  updates: UpdateTaskInputType,
  tenantId = 'default',
): TaskRecord | null {
  ensureColumns();
  const parsed = UpdateTaskInput.parse(updates);
  const current = getById(id, tenantId);
  if (!current) return null;

  if (parsed.parent_task_id === id) {
    throw new Error('Task cannot be its own parent');
  }
  if (parsed.parent_task_id && !getById(parsed.parent_task_id, tenantId)) {
    throw new Error(`Parent task not found: ${parsed.parent_task_id}`);
  }

  const db = getDb();
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];
  const changed: Record<string, unknown> = {};

  if (parsed.parent_task_id !== undefined) {
    setClauses.push('parent_task_id = ?');
    params.push(parsed.parent_task_id);
    changed.parent_task_id = parsed.parent_task_id;
  }
  if (parsed.title !== undefined) {
    setClauses.push('title = ?');
    params.push(parsed.title);
    changed.title = parsed.title;
  }
  if (parsed.objective !== undefined) {
    setClauses.push('objective = ?');
    params.push(parsed.objective);
    changed.objective = parsed.objective;
  }
  if (parsed.done_criteria !== undefined) {
    setClauses.push('done_criteria = ?');
    params.push(parsed.done_criteria);
    changed.done_criteria = parsed.done_criteria;
  }
  if (parsed.priority !== undefined) {
    setClauses.push('priority = ?');
    params.push(parsed.priority);
    changed.priority = parsed.priority;
  }
  if (parsed.tags !== undefined) {
    setClauses.push('tags = ?');
    params.push(JSON.stringify(parsed.tags));
    changed.tags = parsed.tags;
  }
  if (parsed.constraints !== undefined) {
    setClauses.push('constraints = ?');
    params.push(JSON.stringify(parsed.constraints));
    changed.constraints = parsed.constraints;
  }
  if (parsed.agent_type_hint !== undefined) {
    setClauses.push('agent_type_hint = ?');
    params.push(parsed.agent_type_hint);
    changed.agent_type_hint = parsed.agent_type_hint;
  }

  if (Object.keys(changed).length === 0) {
    return current;
  }

  params.push(id, tenantId);
  db.prepare(`
    UPDATE tasks SET ${setClauses.join(', ')}
    WHERE id = ? AND tenant_id = ?
  `).run(...params);

  logEvent('task_updated', 'task', id, { changed }, tenantId);
  return getById(id, tenantId);
}

/** Assign a task to an agent */
export function assign(id: string, agentId: string, tenantId = 'default'): TaskRecord | null {
  ensureColumns();
  const db = getDb();
  db.prepare(`
    UPDATE tasks SET status = 'assigned', assigned_agent = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(agentId, id, tenantId);

  logEvent('task_assigned', 'task', id, { agent_id: agentId }, tenantId);
  return getById(id, tenantId);
}

/**
 * Mark a task as completed and propagate readiness to downstream tasks.
 * Returns the list of tasks that became ready as a result.
 */
export function complete(id: string, tenantId = 'default'): TaskRecord[] {
  ensureColumns();
  const db = getDb();

  db.prepare(`
    UPDATE tasks SET status = 'completed', updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);

  logEvent('task_completed', 'task', id, {}, tenantId);
  logger.info({ task_id: id }, 'Task completed');

  // Find downstream tasks that depend on this one
  return propagateReadiness(id, tenantId);
}

/**
 * Mark a task as failed and handle downstream tasks based on dep failure policy.
 */
export function fail(id: string, reason: string, tenantId = 'default'): void {
  ensureColumns();
  const db = getDb();

  db.prepare(`
    UPDATE tasks SET status = 'failed', updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);

  logEvent('task_failed', 'task', id, { reason }, tenantId);
  logger.info({ task_id: id, reason }, 'Task failed');

  // Handle downstream tasks based on their dep failure policy
  propagateFailure(id, tenantId);
}

/** Cancel a task and all its pending/ready downstream tasks */
export function cancel(id: string, tenantId = 'default', reason?: string): void {
  ensureColumns();
  const db = getDb();

  db.prepare(`
    UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);

  logEvent('task_cancelled', 'task', id, reason ? { reason } : {}, tenantId);

  // Cancel downstream pending/ready tasks
  const downstream = getDownstreamTasks(id, tenantId);
  for (const task of downstream) {
    if (task.status === 'pending' || task.status === 'ready') {
      cancel(task.id, tenantId, reason ? `Upstream task ${id} cancelled: ${reason}` : undefined);
    }
  }
}

/** Increment the attempt count for a task */
export function incrementAttempts(id: string, tenantId = 'default'): void {
  ensureColumns();
  const db = getDb();
  db.prepare(`
    UPDATE tasks SET attempts = attempts + 1, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
}

/**
 * Start a fresh, explicitly approved execution budget for a repaired task.
 * Automatic crash recovery must never call this: resumed runs retain attempts.
 */
export function resetAttempts(id: string, tenantId = 'default'): number {
  ensureColumns();
  const db = getDb();
  const row = db.prepare(`
    SELECT attempts FROM tasks WHERE id = ? AND tenant_id = ?
  `).get(id, tenantId) as { attempts: number } | undefined;
  if (!row) return 0;
  db.prepare(`
    UPDATE tasks SET attempts = 0, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
  return row.attempts;
}

/** Get dependencies of a task */
export function getDependencies(taskId: string, tenantId = 'default'): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT depends_on_task_id FROM task_dependencies
    WHERE task_id = ? AND tenant_id = ?
  `).all(taskId, tenantId) as Array<{ depends_on_task_id: string }>;
  return rows.map(r => r.depends_on_task_id);
}

/** Get tasks that depend on the given task */
export function getDownstreamTasks(taskId: string, tenantId = 'default'): TaskRecord[] {
  ensureColumns();
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.* FROM tasks t
    JOIN task_dependencies d ON d.task_id = t.id AND d.tenant_id = t.tenant_id
    WHERE d.depends_on_task_id = ? AND d.tenant_id = ?
  `).all(taskId, tenantId) as Record<string, unknown>[];
  return rows.map(deserializeRow);
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/**
 * Return all tasks in topological order (dependencies first).
 * Throws if a cycle is detected.
 */
export function topologicalSort(tenantId = 'default'): TaskRecord[] {
  ensureColumns();
  const db = getDb();
  const allTasks = listTasks({ tenant_id: tenantId });
  const taskMap = new Map(allTasks.map(t => [t.id, t]));

  // Build adjacency list
  const deps = db.prepare(`
    SELECT task_id, depends_on_task_id FROM task_dependencies WHERE tenant_id = ?
  `).all(tenantId) as Array<{ task_id: string; depends_on_task_id: string }>;

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of allTasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }

  for (const dep of deps) {
    if (!adj.has(dep.depends_on_task_id)) continue;
    adj.get(dep.depends_on_task_id)!.push(dep.task_id);
    inDegree.set(dep.task_id, (inDegree.get(dep.task_id) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: TaskRecord[] = [];
  while (queue.length > 0) {
    // Sort queue by priority for deterministic order
    queue.sort((a, b) => (taskMap.get(a)!.priority - taskMap.get(b)!.priority));
    const id = queue.shift()!;
    sorted.push(taskMap.get(id)!);

    for (const next of adj.get(id) ?? []) {
      const newDegree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDegree);
      if (newDegree === 0) queue.push(next);
    }
  }

  if (sorted.length !== allTasks.length) {
    throw new Error('Cycle detected in task DAG');
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * After a task completes, check all downstream tasks to see if they become ready.
 */
function propagateReadiness(completedId: string, tenantId: string): TaskRecord[] {
  const db = getDb();
  const newlyReady: TaskRecord[] = [];

  // Find tasks that depend on the completed task
  const downstream = getDownstreamTasks(completedId, tenantId);

  for (const task of downstream) {
    if (task.status !== 'pending') continue;

    // Check if ALL dependencies are completed
    const depIds = getDependencies(task.id, tenantId);
    const allDone = depIds.every(depId => {
      const depTask = getById(depId, tenantId);
      return depTask?.status === 'completed';
    });

    if (allDone) {
      updateStatus(task.id, 'ready', tenantId);
      const updated = getById(task.id, tenantId)!;
      newlyReady.push(updated);
      logger.info({ task_id: task.id, title: task.title }, 'Task became ready');
    }
  }

  return newlyReady;
}

/**
 * Handle downstream tasks when a dependency fails.
 */
function propagateFailure(failedId: string, tenantId: string): void {
  const downstream = getDownstreamTasks(failedId, tenantId);

  for (const task of downstream) {
    if (task.status !== 'pending' && task.status !== 'ready') continue;

    switch (task.on_dep_failure) {
      case 'fail_fast':
        fail(task.id, `Dependency ${failedId} failed`, tenantId);
        break;
      case 'continue':
        // Skip this task, mark as cancelled, but don't cascade
        updateStatus(task.id, 'cancelled', tenantId);
        logEvent('task_cancelled', 'task', task.id, { reason: `Dependency ${failedId} failed (continue policy)` }, tenantId);
        break;
      case 'fallback':
        // Mark as ready anyway — the task should handle missing dep data
        updateStatus(task.id, 'ready', tenantId);
        logEvent('task_dep_fallback', 'task', task.id, { failed_dep: failedId }, tenantId);
        break;
    }
  }
}

/**
 * Detect cycle before inserting a new task with dependencies.
 * Checks if any of depIds would create a cycle with the new taskId.
 */
function detectCycleBeforeInsert(newTaskId: string, depIds: string[], tenantId: string): void {
  const db = getDb();

  // Build graph of existing dependencies
  const allDeps = db.prepare(`
    SELECT task_id, depends_on_task_id FROM task_dependencies WHERE tenant_id = ?
  `).all(tenantId) as Array<{ task_id: string; depends_on_task_id: string }>;

  // Add proposed edges
  const adj = new Map<string, Set<string>>();
  for (const dep of allDeps) {
    if (!adj.has(dep.depends_on_task_id)) adj.set(dep.depends_on_task_id, new Set());
    adj.get(dep.depends_on_task_id)!.add(dep.task_id);
  }

  // Add proposed: depId -> newTaskId (newTaskId depends on depId)
  // This means edges FROM depId TO newTaskId in the dependency DAG
  // A cycle exists if newTaskId can reach any depId via existing edges
  for (const depId of depIds) {
    // BFS from depId's ancestors - check if newTaskId is an ancestor of depId
    // Actually: check if depId is reachable from newTaskId via existing edges
    // But newTaskId doesn't exist yet, so no cycle possible at insert time
    // The only cycle: if depId depends (transitively) on... but newTaskId doesn't exist yet
    // So no cycle can be formed when inserting a brand new task
  }
  // Since newTaskId is brand new, it can't be in anyone's dependency chain yet.
  // Cycles would only happen if we add deps to existing tasks. Skip check for new tasks.
}

function deserializeRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    parent_task_id: row.parent_task_id as string | null,
    title: row.title as string,
    objective: (row.objective as string) ?? '',
    done_criteria: (row.done_criteria as string) ?? '',
    status: (row.status as TaskStatus) ?? 'pending',
    assigned_agent: row.assigned_agent as string | null,
    agent_type_hint: (row.agent_type_hint as string) ?? 'any',
    constraints: row.constraints ? JSON.parse(row.constraints as string) : {},
    on_dep_failure: (row.on_dep_failure as DepFailurePolicyType) ?? 'fail_fast',
    attempts: (row.attempts as number) ?? 0,
    priority: (row.priority as number) ?? 0,
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
