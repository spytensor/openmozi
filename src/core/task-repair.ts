import { z } from 'zod';
import { log as logEvent, type EventRecord } from '../store/events.js';
import {
  getById,
  getDependencies,
  getDownstreamTasks,
  listTasks,
  resetAttempts,
  updateStatus,
  type TaskRecord,
} from '../store/task-dag.js';
import { clearCancellationRequest } from './task-cancellation.js';
import { extractMissingEnvKeys } from './recovery-policy.js';
import { getManagedTask, type ManagedTaskSummary, type TaskRelationSummary } from './task-management.js';
import { runManagedTask, type RunManagedTaskOptions, type RunManagedTaskResult } from './task-execution.js';
import { requireDelegationSystemPrompt } from './delegation-prompt.js';
import {
  getLatestExternalWorkerJobForTask,
  type ExternalWorkerFailureCategory,
  type ExternalWorkerJob,
} from '../workers/job-state.js';

export const TaskRepairCategorySchema = z.enum([
  'timed_out',
  'missing_environment',
  'dependency_failed',
  'blocked',
  'cancelled',
  'worker_launch_failed',
  'worker_runtime_error',
  'worker_verify_failed',
  'worker_result_missing',
  'runtime_error',
  'not_failed',
  'unknown',
]);
export type TaskRepairCategory = z.infer<typeof TaskRepairCategorySchema>;

export const TaskRepairActionSchema = z.enum([
  'repair_and_rerun',
  'rerun',
  'fix_dependencies',
  'configure_and_rerun',
  'wait_for_input',
  'investigate',
  'not_applicable',
]);
export type TaskRepairAction = z.infer<typeof TaskRepairActionSchema>;

export interface TaskRepairDiagnosis {
  task: ManagedTaskSummary;
  category: TaskRepairCategory;
  source: 'worker_job' | 'task_event' | 'task_status' | 'unknown';
  repairable: boolean;
  auto_repairable: boolean;
  suggested_action: TaskRepairAction;
  reason_summary: string;
  recent_event_type: string | null;
  worker_failure_category: ExternalWorkerFailureCategory | null;
  missing_env_keys: string[];
  blocked_by: TaskRelationSummary[];
}

export interface TaskRepairResult {
  diagnosis: TaskRepairDiagnosis;
  reset_task_ids: string[];
  rerun: RunManagedTaskResult | null;
  tasks: ManagedTaskSummary[];
}

export interface RepairManagedTaskOptions extends RunManagedTaskOptions {
  reason?: string;
  rerun?: boolean;
}

function getTaskOrThrow(taskId: string, tenantId: string): TaskRecord {
  const task = getById(taskId, tenantId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

function extractReason(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['reason', 'error', 'summary', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildChildren(taskId: string, tenantId: string): TaskRecord[] {
  return listTasks({ tenant_id: tenantId, parent_task_id: taskId });
}

function collectRepairScope(task: TaskRecord, bucket: Map<string, TaskRecord>): void {
  if (bucket.has(task.id)) return;
  bucket.set(task.id, task);

  for (const child of buildChildren(task.id, task.tenant_id)) {
    collectRepairScope(child, bucket);
  }
  for (const dependent of getDownstreamTasks(task.id, task.tenant_id)) {
    collectRepairScope(dependent, bucket);
  }
}

function inferReasonFromEvents(events: EventRecord[]): { event: EventRecord | null; reason: string } {
  const latest = [...events].reverse().find((event) => {
    return event.event_type === 'task_failed'
      || event.event_type === 'task_cancelled'
      || event.event_type === 'task_status_changed';
  }) ?? null;

  return {
    event: latest,
    reason: latest ? extractReason(latest.payload) : '',
  };
}

function classifyWorkerFailure(job: ExternalWorkerJob): {
  category: TaskRepairCategory;
  reason: string;
  repairable: boolean;
  autoRepairable: boolean;
  suggestedAction: TaskRepairAction;
} {
  const reason = job.last_error
    || job.verify_report?.summary
    || job.result_envelope?.summary
    || 'Managed worker failed without a detailed reason.';

  switch (job.failure_category) {
    case 'timed_out':
    case 'stalled':
      return {
        category: 'timed_out',
        reason,
        repairable: true,
        autoRepairable: true,
        suggestedAction: 'repair_and_rerun',
      };
    case 'launch_failed':
      return {
        category: 'worker_launch_failed',
        reason,
        repairable: true,
        autoRepairable: true,
        suggestedAction: 'repair_and_rerun',
      };
    case 'runtime_error':
      return {
        category: 'worker_runtime_error',
        reason,
        repairable: true,
        autoRepairable: true,
        suggestedAction: 'repair_and_rerun',
      };
    case 'result_missing':
      return {
        category: 'worker_result_missing',
        reason,
        repairable: true,
        autoRepairable: true,
        suggestedAction: 'repair_and_rerun',
      };
    case 'verify_failed':
      return {
        category: 'worker_verify_failed',
        reason,
        repairable: false,
        autoRepairable: false,
        suggestedAction: 'investigate',
      };
    default:
      return {
        category: 'unknown',
        reason,
        repairable: false,
        autoRepairable: false,
        suggestedAction: 'investigate',
      };
  }
}

function classifyTaskFailure(
  task: ManagedTaskSummary,
  workerJob: ExternalWorkerJob | null,
  events: EventRecord[],
): TaskRepairDiagnosis {
  if (workerJob && (workerJob.status === 'failed' || workerJob.status === 'timed_out')) {
    const classified = classifyWorkerFailure(workerJob);
    return {
      task,
      category: classified.category,
      source: 'worker_job',
      repairable: classified.repairable,
      auto_repairable: classified.autoRepairable,
      suggested_action: classified.suggestedAction,
      reason_summary: classified.reason,
      recent_event_type: events.at(-1)?.event_type ?? null,
      worker_failure_category: workerJob.failure_category,
      missing_env_keys: extractMissingEnvKeys([classified.reason]),
      blocked_by: task.blocked_by,
    };
  }

  const { event, reason } = inferReasonFromEvents(events);
  const latestReason = reason || '';
  const missingEnvKeys = extractMissingEnvKeys([latestReason]);

  if (task.status === 'completed') {
    return {
      task,
      category: 'not_failed',
      source: 'task_status',
      repairable: false,
      auto_repairable: false,
      suggested_action: 'not_applicable',
      reason_summary: 'Task is already completed.',
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: [],
      blocked_by: task.blocked_by,
    };
  }

  if (task.status === 'blocked' && missingEnvKeys.length > 0) {
    return {
      task,
      category: 'missing_environment',
      source: event ? 'task_event' : 'task_status',
      repairable: false,
      auto_repairable: false,
      suggested_action: 'configure_and_rerun',
      reason_summary: latestReason || `Missing environment variables: ${missingEnvKeys.join(', ')}`,
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: missingEnvKeys,
      blocked_by: task.blocked_by,
    };
  }

  if (/dependency .*failed|dependency failed/i.test(latestReason)) {
    return {
      task,
      category: 'dependency_failed',
      source: event ? 'task_event' : 'task_status',
      repairable: false,
      auto_repairable: false,
      suggested_action: 'fix_dependencies',
      reason_summary: latestReason || 'An upstream dependency failed.',
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: [],
      blocked_by: task.blocked_by,
    };
  }

  if (/timed out|timeout|超时/i.test(latestReason)) {
    return {
      task,
      category: 'timed_out',
      source: event ? 'task_event' : 'task_status',
      repairable: true,
      auto_repairable: true,
      suggested_action: 'repair_and_rerun',
      reason_summary: latestReason || 'The task timed out.',
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: [],
      blocked_by: task.blocked_by,
    };
  }

  if (task.status === 'blocked') {
    return {
      task,
      category: 'blocked',
      source: event ? 'task_event' : 'task_status',
      repairable: false,
      auto_repairable: false,
      suggested_action: 'wait_for_input',
      reason_summary: latestReason || 'Task is blocked and requires intervention.',
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: [],
      blocked_by: task.blocked_by,
    };
  }

  if (task.status === 'cancelled') {
    return {
      task,
      category: 'cancelled',
      source: event ? 'task_event' : 'task_status',
      repairable: true,
      auto_repairable: false,
      suggested_action: 'rerun',
      reason_summary: latestReason || 'Task was cancelled.',
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: [],
      blocked_by: task.blocked_by,
    };
  }

  if (task.status === 'failed') {
    return {
      task,
      category: 'runtime_error',
      source: event ? 'task_event' : 'task_status',
      repairable: true,
      auto_repairable: true,
      suggested_action: 'repair_and_rerun',
      reason_summary: latestReason || 'Task failed with a runtime error.',
      recent_event_type: event?.event_type ?? null,
      worker_failure_category: null,
      missing_env_keys: [],
      blocked_by: task.blocked_by,
    };
  }

  return {
    task,
    category: 'not_failed',
    source: 'task_status',
    repairable: false,
    auto_repairable: false,
    suggested_action: 'not_applicable',
    reason_summary: `Task is ${task.status} and does not need repair.`,
    recent_event_type: event?.event_type ?? null,
    worker_failure_category: null,
    missing_env_keys: [],
    blocked_by: task.blocked_by,
  };
}

function collectResettableTasks(rootTask: TaskRecord): TaskRecord[] {
  const bucket = new Map<string, TaskRecord>();
  collectRepairScope(rootTask, bucket);
  return [...bucket.values()];
}

function resetTasksForRepair(tasks: TaskRecord[], tenantId: string, reason: string): string[] {
  if (tasks.some((task) => task.status === 'running')) {
    throw new Error('Cannot repair tasks while they are still running.');
  }

  // Explicit repair starts a new execution budget for every unfinished task in
  // scope, including stranded ready/pending/assigned descendants. Automatic
  // resume never reaches this path and therefore retains its persisted budget.
  const previousAttemptsByTask = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === 'completed') continue;
    const previousAttempts = resetAttempts(task.id, tenantId);
    previousAttemptsByTask.set(task.id, previousAttempts);
    if (previousAttempts > 0) {
      logEvent('task_repair_budget_reset', 'task', task.id, {
        repair_reason: reason,
        previous_attempts: previousAttempts,
        next_attempts: 0,
      }, tenantId);
    }
  }

  const resettable = tasks.filter((task) => {
    return task.status === 'failed'
      || task.status === 'cancelled'
      || task.status === 'blocked';
  });

  const resetIds = resettable.map((task) => task.id);

  for (const task of resettable) {
    clearCancellationRequest(task.id, tenantId);
    const previousAttempts = previousAttemptsByTask.get(task.id) ?? 0;
    updateStatus(task.id, 'pending', tenantId, {
      repair_reason: reason,
      repair_stage: 'reset_pending',
      previous_attempts: previousAttempts,
    });
    logEvent('task_repair_reset', 'task', task.id, {
      repair_reason: reason,
      next_status: 'pending',
      previous_attempts: previousAttempts,
      next_attempts: 0,
    }, tenantId);
  }

  for (const taskId of resetIds) {
    const task = getTaskOrThrow(taskId, tenantId);
    const dependencyIds = getDependencies(task.id, tenantId);
    const allCompleted = dependencyIds.every((dependencyId) => getTaskOrThrow(dependencyId, tenantId).status === 'completed');
    if (allCompleted) {
      updateStatus(task.id, 'ready', tenantId, {
        repair_reason: reason,
        repair_stage: 'promoted_ready',
      });
    }
  }

  return resetIds;
}

/**
 * Diagnose a task failure/block and determine whether the runtime can repair it.
 */
export function diagnoseManagedTaskRepair(taskId: string, tenantId = 'default'): TaskRepairDiagnosis {
  const detail = getManagedTask(taskId, tenantId);
  if (!detail) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const workerJob = getLatestExternalWorkerJobForTask(taskId, tenantId);
  return classifyTaskFailure(detail.task, workerJob, detail.recent_events);
}

/**
 * Reset a failed/blocked task scope and optionally rerun it through the runtime.
 */
export async function repairManagedTask(
  taskId: string,
  options: RepairManagedTaskOptions = {},
): Promise<TaskRepairResult> {
  if (options.rerun) {
    requireDelegationSystemPrompt(options.systemPrompt);
  }
  const tenantId = options.tenantId ?? 'default';
  const diagnosis = diagnoseManagedTaskRepair(taskId, tenantId);

  if (!diagnosis.repairable) {
    throw new Error(`Task ${taskId} is not repairable: ${diagnosis.reason_summary}`);
  }

  const rootTask = getTaskOrThrow(taskId, tenantId);
  const scope = collectResettableTasks(rootTask);
  const resetReason = options.reason?.trim() || diagnosis.reason_summary;
  const resetTaskIds = resetTasksForRepair(scope, tenantId, resetReason);

  const rerun = options.rerun
    ? await runManagedTask(taskId, {
      tenantId,
      chatId: options.chatId,
      turnId: options.turnId,
      systemPrompt: options.systemPrompt,
      fallbackClient: options.fallbackClient,
      useSubAgents: options.useSubAgents,
      subagentRuntimeSource: options.subagentRuntimeSource,
      subagentSessionKey: options.subagentSessionKey,
      includeSubtasks: options.includeSubtasks,
    })
    : null;

  const tasks = scope
    .map((task) => getManagedTask(task.id, tenantId)?.task)
    .filter((task): task is ManagedTaskSummary => task !== null)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));

  return {
    diagnosis,
    reset_task_ids: resetTaskIds,
    rerun,
    tasks,
  };
}
