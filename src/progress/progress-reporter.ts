/**
 * Progress Reporter — tracks DAG execution state and emits
 * structured progress events for user visibility.
 *
 * Provides human-readable formatting for channel adapters
 * (Telegram, WebSocket, etc.) to relay execution progress.
 */

import { emit, type ProgressEventInput } from './event-bus.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:progress-reporter' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Active DAG execution state for tracking */
interface DagExecutionState {
  dagId: string;
  totalTasks: number;
  completedTasks: number;
  runningTasks: number;
  failedTasks: number;
  startedAt: number;
  chatId?: string;
  tenantId?: string;
  sessionId?: string;
  turnId?: string;
  runningTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activeExecutions = new Map<string, DagExecutionState>();

// ---------------------------------------------------------------------------
// DAG tracking
// ---------------------------------------------------------------------------

/**
 * Start tracking a new DAG execution.
 * Emits a 'dag_created' event.
 */
export function startTracking(
  dagId: string,
  totalTasks: number,
  chatId?: string,
  turnId?: string,
  sessionId?: string,
  tenantId?: string,
): void {
  activeExecutions.set(dagId, {
    dagId,
    totalTasks,
    completedTasks: 0,
    runningTasks: 0,
    failedTasks: 0,
    startedAt: Date.now(),
    chatId,
    tenantId,
    sessionId,
    turnId,
    runningTaskIds: new Set(),
    completedTaskIds: new Set(),
    failedTaskIds: new Set(),
  });

  emit({
    type: 'dag_created',
    taskId: dagId,
    totalTasks,
    completedTasks: 0,
    runningTasks: 0,
    pendingTasks: totalTasks,
    chatId,
    tenantId,
    sessionId,
    turnId,
  });

  logger.info({ dagId, totalTasks }, 'Started tracking DAG execution');
}

/**
 * Report that a task has started executing.
 *
 * `parentTaskId` (Issue #624) is the subtask's owning plan-root/parent task, so
 * the timeline can nest it under the correct group; undefined for a plan root.
 */
export function reportTaskStarted(dagId: string, taskId: string, taskTitle: string, parentTaskId?: string): void {
  const state = activeExecutions.get(dagId);
  if (state) {
    if (!state.completedTaskIds.has(taskId) && !state.failedTaskIds.has(taskId)) {
      state.runningTaskIds.add(taskId);
      state.runningTasks = state.runningTaskIds.size;
    }
  }

  emit({
    type: 'task_started',
    taskId,
    parentTaskId,
    taskTitle,
    totalTasks: state?.totalTasks,
    completedTasks: state?.completedTasks,
    chatId: state?.chatId,
    tenantId: state?.tenantId,
    sessionId: state?.sessionId,
    turnId: state?.turnId,
  });

  logger.debug({ dagId, taskId, taskTitle }, 'Task started');
}

/**
 * Report that a task has completed successfully.
 * Also emits an 'overall_progress' event with current state.
 */
export function reportTaskCompleted(
  dagId: string,
  taskId: string,
  taskTitle: string,
  elapsedMs: number,
  parentTaskId?: string,
  detail?: string,
): void {
  const state = activeExecutions.get(dagId);
  if (state) {
    state.runningTaskIds.delete(taskId);
    state.runningTasks = state.runningTaskIds.size;
    if (!state.completedTaskIds.has(taskId)) {
      state.completedTaskIds.add(taskId);
      state.completedTasks = state.completedTaskIds.size;
    }
  }

  emit({
    type: 'task_completed',
    taskId,
    parentTaskId,
    taskTitle,
    detail,
    elapsed_ms: elapsedMs,
    totalTasks: state?.totalTasks,
    completedTasks: state?.completedTasks,
    chatId: state?.chatId,
    tenantId: state?.tenantId,
    sessionId: state?.sessionId,
    turnId: state?.turnId,
  });

  if (state) {
    emitOverallProgress(state);
  }

  logger.debug({ dagId, taskId, taskTitle, elapsedMs }, 'Task completed');
}

/**
 * Report that a task has failed.
 * Also emits an 'overall_progress' event with current state.
 */
export function reportTaskFailed(
  dagId: string,
  taskId: string,
  taskTitle: string,
  error: string,
  parentTaskId?: string,
): void {
  const state = activeExecutions.get(dagId);
  if (state) {
    state.runningTaskIds.delete(taskId);
    state.runningTasks = state.runningTaskIds.size;
    if (!state.failedTaskIds.has(taskId)) {
      state.failedTaskIds.add(taskId);
      state.failedTasks = state.failedTaskIds.size;
    }
  }

  emit({
    type: 'task_failed',
    taskId,
    parentTaskId,
    taskTitle,
    error,
    totalTasks: state?.totalTasks,
    completedTasks: state?.completedTasks,
    chatId: state?.chatId,
    tenantId: state?.tenantId,
    sessionId: state?.sessionId,
    turnId: state?.turnId,
  });

  if (state) {
    emitOverallProgress(state);
  }

  logger.warn({ dagId, taskId, taskTitle, error }, 'Task failed');
}

/**
 * Report that a task was cancelled.
 * Also emits an 'overall_progress' event with current state.
 */
export function reportTaskCancelled(
  dagId: string,
  taskId: string,
  taskTitle: string,
  error: string,
  parentTaskId?: string,
): void {
  const state = activeExecutions.get(dagId);
  if (state) {
    state.runningTaskIds.delete(taskId);
    state.runningTasks = state.runningTaskIds.size;
    if (!state.failedTaskIds.has(taskId)) {
      state.failedTaskIds.add(taskId);
      state.failedTasks = state.failedTaskIds.size;
    }
  }

  emit({
    type: 'task_cancelled',
    taskId,
    parentTaskId,
    taskTitle,
    error,
    totalTasks: state?.totalTasks,
    completedTasks: state?.completedTasks,
    chatId: state?.chatId,
    tenantId: state?.tenantId,
    sessionId: state?.sessionId,
    turnId: state?.turnId,
  });

  if (state) {
    emitOverallProgress(state);
  }

  logger.info({ dagId, taskId, taskTitle, error }, 'Task cancelled');
}

/** Mark an attempt as no longer running while the task waits for a retry. */
export function reportTaskRetryScheduled(dagId: string, taskId: string): void {
  const state = activeExecutions.get(dagId);
  if (!state) return;
  state.runningTaskIds.delete(taskId);
  state.runningTasks = state.runningTaskIds.size;
  emitOverallProgress(state);
}

/**
 * Stop tracking a DAG execution and clean up state.
 */
export function stopTracking(dagId: string): void {
  activeExecutions.delete(dagId);
  logger.info({ dagId }, 'Stopped tracking DAG execution');
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

/**
 * Format a progress event as human-readable text for channel display.
 */
export function formatProgressText(event: ProgressEventInput): string {
  switch (event.type) {
    case 'turn_state': {
      const phase = event.turnState ?? 'EXECUTING';
      const normalized = phase.toLowerCase().replace(/_/g, ' ');
      const detail = event.detail ? ` - ${event.detail}` : '';
      return `Phase: ${normalized}${detail}`;
    }

    case 'task_started': {
      const prefix = formatTaskPrefix(event.completedTasks, event.totalTasks);
      return `${prefix} Starting: ${event.taskTitle ?? event.taskId ?? 'unknown'}`;
    }

    case 'task_completed': {
      const prefix = formatTaskPrefix(event.completedTasks, event.totalTasks);
      const elapsed = event.elapsed_ms != null ? ` (${formatElapsed(event.elapsed_ms)})` : '';
      return `${prefix} Done: ${event.taskTitle ?? event.taskId ?? 'unknown'}${elapsed}`;
    }

    case 'task_failed': {
      const errorSuffix = event.error ? `: ${event.error}` : '';
      return `[!] Failed: ${event.taskTitle ?? event.taskId ?? 'unknown'}${errorSuffix}`;
    }

    case 'task_cancelled': {
      const errorSuffix = event.error ? `: ${event.error}` : '';
      return `[x] Cancelled: ${event.taskTitle ?? event.taskId ?? 'unknown'}${errorSuffix}`;
    }

    case 'overall_progress': {
      const completed = event.completedTasks ?? 0;
      const total = event.totalTasks ?? 0;
      const running = event.runningTasks ?? 0;
      const pending = event.pendingTasks ?? 0;
      return `Progress: ${completed}/${total} complete, ${running} running, ${pending} pending`;
    }

    case 'agent_spawned':
      return `Agent spawned: ${event.agentRole ?? event.agentId ?? 'unknown'}`;

    case 'agent_completed':
      return `Agent completed: ${event.agentId ?? 'unknown'}${event.summary ? ` - ${event.summary}` : ''}`;

    case 'agent_failed':
      return `Agent failed: ${event.agentId ?? 'unknown'}${event.error ? `: ${event.error}` : ''}`;

    case 'tool_call': {
      const target = event.intent?.trim() || event.toolName || 'tool';
      return `Action: ${target}`;
    }

    case 'tool_result': {
      const target = event.toolName ?? 'tool';
      if (event.error) {
        return `Action failed: ${target} - ${truncateProgressText(event.error, 120)}`;
      }
      const elapsed = event.elapsed_ms != null ? ` (${formatElapsed(event.elapsed_ms)})` : '';
      return `Action done: ${target}${elapsed}`;
    }

    case 'worker_status': {
      const workerName = event.runtimeLabel ?? event.adapterId ?? 'worker';
      const status = formatWorkerStatus(event.workerStatus);
      const elapsed = event.elapsed_ms != null ? ` (${formatElapsed(event.elapsed_ms)})` : '';
      const lane = event.lane ? `, ${event.lane}` : '';
      const sandbox = event.sandboxProfile ? `, ${event.sandboxProfile}` : '';
      const suffix = event.summary
        ? ` - ${truncateProgressText(event.summary, 120)}`
        : '';
      if (event.heartbeat) {
        return `${workerName}: still ${status}${elapsed}${suffix}`;
      }
      return `${workerName}: ${status}${elapsed}${lane}${sandbox}${suffix}`;
    }

    case 'budget_warning':
      return `Token budget: ${event.level ?? 'unknown'} (${event.usagePercent ?? 0}%)`;

    default:
      return event.type;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit an overall_progress event from current DAG state */
function emitOverallProgress(state: DagExecutionState): void {
  const pending = state.totalTasks - state.completedTasks - state.runningTasks - state.failedTasks;

  emit({
    type: 'overall_progress',
    taskId: state.dagId,
    totalTasks: state.totalTasks,
    completedTasks: state.completedTasks,
    runningTasks: state.runningTasks,
    pendingTasks: pending,
    chatId: state.chatId,
    tenantId: state.tenantId,
    sessionId: state.sessionId,
    turnId: state.turnId,
  });
}

/** Format task count prefix like [3/7] */
function formatTaskPrefix(completed?: number, total?: number): string {
  if (completed != null && total != null) {
    return `[${completed}/${total}]`;
  }
  return '[?]';
}

/** Format elapsed milliseconds as a human-readable string */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m${remaining}s`;
}

function formatWorkerStatus(status?: string): string {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'launching':
      return 'launching';
    case 'running':
      return 'running';
    case 'completed_pending_verify':
      return 'awaiting verification';
    case 'succeeded':
      return 'verified complete';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed out';
    case 'cancelled':
      return 'cancelled';
    default:
      return status ?? 'working';
  }
}

function truncateProgressText(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * Get current execution state for a DAG. Exposed for testing.
 */
export function _getExecutionState(dagId: string): DagExecutionState | undefined {
  return activeExecutions.get(dagId);
}

/**
 * Clear all active executions. Exposed for testing.
 */
export function _clearAllState(): void {
  activeExecutions.clear();
}
