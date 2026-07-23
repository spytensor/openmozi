import { z } from 'zod';
import type { EventRecord } from '../store/events.js';
import { query as queryTaskEvents } from '../store/events.js';
import {
  CreateTaskInput,
  TaskConstraintsSchema,
  TaskStatusEnum,
  assign,
  cancel,
  complete,
  create,
  fail,
  getById,
  getDependencies,
  getDownstreamTasks,
  listTasks,
  updateStatus,
  updateTask,
  type CreateTaskInputType,
  type TaskRecord,
  type TaskStatus,
  type UpdateTaskInputType,
} from '../store/task-dag.js';

export interface TaskRelationSummary {
  id: string;
  title: string;
  status: TaskStatus;
  assigned_agent: string | null;
  updated_at: string;
}

export interface ManagedTaskSummary extends TaskRecord {
  dependency_ids: string[];
  dependency_count: number;
  dependent_count: number;
  child_count: number;
  blocked_by: TaskRelationSummary[];
  last_event_type: string | null;
  last_event_at: string | null;
}

export interface ManagedTaskDetail {
  task: ManagedTaskSummary;
  dependencies: TaskRelationSummary[];
  dependents: TaskRelationSummary[];
  children: TaskRelationSummary[];
  recent_events: EventRecord[];
}

export interface TaskMutationResult {
  task: ManagedTaskDetail;
  newly_ready_tasks: TaskRelationSummary[];
}

export const TaskListFiltersSchema = z.object({
  tenant_id: z.string().default('default'),
  status: z.union([TaskStatusEnum, z.array(TaskStatusEnum)]).optional(),
  parent_task_id: z.string().nullable().optional(),
  tag: z.string().optional(),
  assigned_agent: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export type TaskListFiltersInput = z.input<typeof TaskListFiltersSchema>;

export const TaskPatchSchema = z.object({
  parent_task_id: z.string().nullable().optional(),
  title: z.string().min(1).optional(),
  objective: z.string().optional(),
  done_criteria: z.string().optional(),
  priority: z.number().optional(),
  tags: z.array(z.string()).optional(),
  constraints: TaskConstraintsSchema.optional(),
  agent_type_hint: z.string().optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  'patch must contain at least one editable field',
);

export type TaskPatchInput = z.input<typeof TaskPatchSchema>;

export const UpdateManagedTaskInputSchema = z.object({
  tenant_id: z.string().default('default'),
  task_id: z.string().min(1),
  patch: TaskPatchSchema.optional(),
  status: TaskStatusEnum.optional(),
  assigned_agent: z.string().min(1).optional(),
  reason: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.assigned_agent && value.status && value.status !== 'assigned') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assigned_agent can only be combined with status="assigned"',
      path: ['assigned_agent'],
    });
  }
  if (value.status === 'assigned' && !value.assigned_agent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assigned_agent is required when status="assigned"',
      path: ['assigned_agent'],
    });
  }
  if ((value.status === 'failed' || value.status === 'blocked') && !value.reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reason is required when status is "failed" or "blocked"',
      path: ['reason'],
    });
  }
  if (!value.patch && !value.status && !value.assigned_agent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'at least one of patch, status, or assigned_agent is required',
      path: [],
    });
  }
});

export type UpdateManagedTaskInput = z.input<typeof UpdateManagedTaskInputSchema>;

function toRelation(task: TaskRecord): TaskRelationSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assigned_agent: task.assigned_agent,
    updated_at: task.updated_at,
  };
}

function getChildren(taskId: string, tenantId: string): TaskRecord[] {
  return listTasks({ tenant_id: tenantId, parent_task_id: taskId });
}

function buildTaskSummary(task: TaskRecord, tenantId: string): ManagedTaskSummary {
  const dependencyIds = getDependencies(task.id, tenantId);
  const dependencies = dependencyIds
    .map((depId) => getById(depId, tenantId))
    .filter((dep): dep is TaskRecord => dep !== null);
  const dependents = getDownstreamTasks(task.id, tenantId);
  const children = getChildren(task.id, tenantId);
  const recentEvents = queryTaskEvents('task', task.id, tenantId);
  const lastEvent = recentEvents.at(-1) ?? null;

  return {
    ...task,
    dependency_ids: dependencyIds,
    dependency_count: dependencyIds.length,
    dependent_count: dependents.length,
    child_count: children.length,
    blocked_by: dependencies
      .filter((dep) => dep.status !== 'completed')
      .map(toRelation),
    last_event_type: lastEvent?.event_type ?? null,
    last_event_at: lastEvent?.created_at ?? null,
  };
}

function getTaskOrThrow(taskId: string, tenantId: string): TaskRecord {
  const task = getById(taskId, tenantId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

/**
 * Create a persistent runtime task and return the fully-expanded detail view.
 */
export function createManagedTask(input: CreateTaskInputType): ManagedTaskDetail {
  const created = create(CreateTaskInput.parse(input));
  return getManagedTask(created.id, created.tenant_id)!;
}

/**
 * Return a task detail view with dependency, child, and recent event context.
 */
export function getManagedTask(taskId: string, tenantId = 'default'): ManagedTaskDetail | null {
  const task = getById(taskId, tenantId);
  if (!task) return null;

  const dependencies = getDependencies(task.id, tenantId)
    .map((depId) => getById(depId, tenantId))
    .filter((dep): dep is TaskRecord => dep !== null)
    .map(toRelation);
  const dependents = getDownstreamTasks(task.id, tenantId).map(toRelation);
  const children = getChildren(task.id, tenantId).map(toRelation);
  const recentEvents = queryTaskEvents('task', task.id, tenantId).slice(-20);

  return {
    task: buildTaskSummary(task, tenantId),
    dependencies,
    dependents,
    children,
    recent_events: recentEvents,
  };
}

/**
 * List tasks with lightweight management metadata for planning and follow-up.
 */
export function listManagedTasks(input: TaskListFiltersInput = {}): ManagedTaskSummary[] {
  const filters = TaskListFiltersSchema.parse(input);
  const requestedStatuses = filters.status
    ? Array.isArray(filters.status)
      ? filters.status
      : [filters.status]
    : null;
  const search = filters.search?.trim().toLowerCase() ?? '';

  let tasks = listTasks({
    tenant_id: filters.tenant_id,
    parent_task_id: filters.parent_task_id,
  });

  if (requestedStatuses) {
    const allowed = new Set(requestedStatuses);
    tasks = tasks.filter((task) => allowed.has(task.status));
  }
  if (filters.tag) {
    tasks = tasks.filter((task) => task.tags.includes(filters.tag!));
  }
  if (filters.assigned_agent) {
    tasks = tasks.filter((task) => task.assigned_agent === filters.assigned_agent);
  }
  if (search) {
    tasks = tasks.filter((task) => {
      const haystack = `${task.title}\n${task.objective}\n${task.done_criteria}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  return tasks
    .slice(0, filters.limit)
    .map((task) => buildTaskSummary(task, filters.tenant_id));
}

/**
 * Patch task metadata and/or transition task state through the task manager.
 */
export function updateManagedTask(input: UpdateManagedTaskInput): TaskMutationResult {
  const parsed = UpdateManagedTaskInputSchema.parse(input);
  const tenantId = parsed.tenant_id;
  const taskId = parsed.task_id;

  getTaskOrThrow(taskId, tenantId);

  if (parsed.patch) {
    updateTask(taskId, parsed.patch as UpdateTaskInputType, tenantId);
  }

  let newlyReadyTasks: TaskRecord[] = [];

  if (parsed.assigned_agent) {
    assign(taskId, parsed.assigned_agent, tenantId);
  } else if (parsed.status) {
    switch (parsed.status) {
      case 'completed':
        newlyReadyTasks = complete(taskId, tenantId);
        break;
      case 'failed':
        fail(taskId, parsed.reason!.trim(), tenantId);
        break;
      case 'cancelled':
        cancel(taskId, tenantId, parsed.reason?.trim());
        break;
      case 'blocked':
        updateStatus(taskId, 'blocked', tenantId, { reason: parsed.reason!.trim() });
        break;
      case 'assigned':
        // Validation guarantees assigned_agent is present when status=assigned.
        assign(taskId, parsed.assigned_agent!, tenantId);
        break;
      default:
        updateStatus(taskId, parsed.status, tenantId, parsed.reason?.trim() ? { reason: parsed.reason.trim() } : {});
        break;
    }
  }

  const task = getManagedTask(taskId, tenantId);
  if (!task) {
    throw new Error(`Task not found after update: ${taskId}`);
  }

  return {
    task,
    newly_ready_tasks: newlyReadyTasks.map(toRelation),
  };
}
