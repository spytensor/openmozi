import type { LLMClient } from './llm.js';
import { executeDag } from './dag-executor.js';
import { getDependencies, getById, listTasks, type TaskRecord } from '../store/task-dag.js';
import { getManagedTask, type ManagedTaskSummary } from './task-management.js';
import { requireDelegationSystemPrompt } from './delegation-prompt.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_BLOCKING_STATUSES = new Set(['running', 'blocked']);
const RUNNABLE_STATUSES = new Set(['pending', 'ready', 'assigned']);

export interface RunManagedTaskOptions {
  tenantId?: string;
  chatId?: string;
  turnId?: string;
  systemPrompt?: string;
  fallbackClient?: LLMClient;
  useSubAgents?: boolean;
  subagentRuntimeSource?: string;
  subagentSessionKey?: string;
  includeSubtasks?: boolean;
}

export interface RunManagedTaskResult {
  root_task_id: string;
  scope_task_ids: string[];
  scope_task_count: number;
  summary: string;
  tasks: ManagedTaskSummary[];
}

function getTaskOrThrow(taskId: string, tenantId: string): TaskRecord {
  const task = getById(taskId, tenantId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

function collectSubtreeTasks(
  task: TaskRecord,
  tenantId: string,
  bucket: Map<string, TaskRecord>,
): void {
  if (bucket.has(task.id)) return;
  bucket.set(task.id, task);

  const children = listTasks({ tenant_id: tenantId, parent_task_id: task.id });
  for (const child of children) {
    collectSubtreeTasks(child, tenantId, bucket);
  }
}

function collectUnresolvedDependencies(
  task: TaskRecord,
  tenantId: string,
  bucket: Map<string, TaskRecord>,
): void {
  const dependencyIds = getDependencies(task.id, tenantId);
  for (const dependencyId of dependencyIds) {
    const dependency = getTaskOrThrow(dependencyId, tenantId);
    if (dependency.status === 'completed') continue;
    if (!bucket.has(dependency.id)) {
      bucket.set(dependency.id, dependency);
    }
    collectUnresolvedDependencies(dependency, tenantId, bucket);
  }
}

function validateExecutionScope(rootTask: TaskRecord, tasks: TaskRecord[]): void {
  const rootStatus = rootTask.status;
  if (TERMINAL_STATUSES.has(rootStatus)) {
    throw new Error(`Task ${rootTask.id} is already ${rootStatus}`);
  }
  if (ACTIVE_BLOCKING_STATUSES.has(rootStatus)) {
    throw new Error(`Task ${rootTask.id} is ${rootStatus} and cannot be executed directly`);
  }

  for (const task of tasks) {
    if (task.id === rootTask.id) continue;
    if (task.status === 'completed') continue;
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Execution scope includes terminal dependency ${task.id} (${task.status})`);
    }
    if (ACTIVE_BLOCKING_STATUSES.has(task.status)) {
      throw new Error(`Execution scope includes ${task.status} task ${task.id}`);
    }
    if (!RUNNABLE_STATUSES.has(task.status)) {
      throw new Error(`Task ${task.id} is in unsupported status ${task.status}`);
    }
  }
}

function buildExecutionScope(
  rootTaskId: string,
  tenantId: string,
  includeSubtasks: boolean,
): TaskRecord[] {
  const rootTask = getTaskOrThrow(rootTaskId, tenantId);
  const bucket = new Map<string, TaskRecord>();

  if (includeSubtasks) {
    collectSubtreeTasks(rootTask, tenantId, bucket);
  } else {
    bucket.set(rootTask.id, rootTask);
  }

  for (const task of [...bucket.values()]) {
    collectUnresolvedDependencies(task, tenantId, bucket);
  }

  const tasks = [...bucket.values()].filter((task) => task.status !== 'completed');
  validateExecutionScope(rootTask, tasks);
  return tasks;
}

/**
 * Execute a persistent task (and optionally its subtree) through the existing DAG runtime.
 */
export async function runManagedTask(
  taskId: string,
  options: RunManagedTaskOptions = {},
): Promise<RunManagedTaskResult> {
  const tenantId = options.tenantId ?? 'default';
  const includeSubtasks = options.includeSubtasks !== false;
  const rootTask = getTaskOrThrow(taskId, tenantId);
  const executionScope = buildExecutionScope(taskId, tenantId, includeSubtasks);
  const systemPrompt = requireDelegationSystemPrompt(options.systemPrompt);
  const chatId = options.chatId ?? `task:${tenantId}:${taskId}`;
  const summary = await executeDag(
    executionScope,
    systemPrompt,
    chatId,
    undefined,
    options.fallbackClient,
    options.turnId,
    {
      useSubAgents: options.useSubAgents === true,
      subagentRuntimeSource: options.subagentRuntimeSource,
      subagentSessionKey: options.subagentSessionKey,
    },
  );

  const latestTasks = executionScope
    .map((task) => getManagedTask(task.id, tenantId)?.task)
    .filter((task): task is ManagedTaskSummary => task !== null)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));

  return {
    root_task_id: rootTask.id,
    scope_task_ids: executionScope.map((task) => task.id),
    scope_task_count: executionScope.length,
    summary,
    tasks: latestTasks,
  };
}
