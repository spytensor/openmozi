import pino from 'pino';
import { cancel as cancelTaskDag, getById } from '../store/task-dag.js';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:task-cancellation' });

function taskKey(taskId: string, tenantId: string): string {
  return `${tenantId}:${taskId}`;
}

function safeLogEvent(
  eventType: string,
  objectId: string,
  payload: Record<string, unknown>,
  tenantId: string,
): void {
  try {
    logEvent(eventType, 'task', objectId, payload, tenantId);
  } catch (err) {
    logger.debug({
      eventType,
      taskId: objectId,
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist task cancellation event');
  }
}

export class TaskCancelledError extends Error {
  public readonly taskId: string;

  constructor(taskId: string, reason = 'Task cancelled') {
    super(reason);
    this.name = 'TaskCancelledError';
    this.taskId = taskId;
  }
}

interface CancellationRequest {
  taskId: string;
  tenantId: string;
  requestedBy: string;
  reason: string;
  requestedAt: number;
  chatId?: string;
  turnId?: string;
}

interface ActiveTaskCancellation {
  taskId: string;
  tenantId: string;
  chatId?: string;
  turnId?: string;
  taskTitle?: string;
  controller: AbortController;
  startedAt: number;
  onCancel: Set<() => void | Promise<void>>;
}

const activeTasks = new Map<string, ActiveTaskCancellation>();
const pendingRequests = new Map<string, CancellationRequest>();

export interface RegisterRunningTaskInput {
  taskId: string;
  tenantId: string;
  chatId?: string;
  turnId?: string;
  taskTitle?: string;
}

export function registerRunningTask(input: RegisterRunningTaskInput): AbortSignal {
  const key = taskKey(input.taskId, input.tenantId);
  const controller = new AbortController();

  activeTasks.set(key, {
    taskId: input.taskId,
    tenantId: input.tenantId,
    chatId: input.chatId,
    turnId: input.turnId,
    taskTitle: input.taskTitle,
    controller,
    startedAt: Date.now(),
    onCancel: new Set(),
  });

  const pending = pendingRequests.get(key);
  if (pending) {
    controller.abort(new TaskCancelledError(input.taskId, pending.reason));
  }

  return controller.signal;
}

export function finishRunningTask(taskId: string, tenantId = 'default'): void {
  activeTasks.delete(taskKey(taskId, tenantId));
}

export function clearCancellationRequest(taskId: string, tenantId = 'default'): void {
  pendingRequests.delete(taskKey(taskId, tenantId));
}

export function isTaskCancellationRequested(taskId: string, tenantId = 'default'): boolean {
  const key = taskKey(taskId, tenantId);
  const active = activeTasks.get(key);
  if (active?.controller.signal.aborted) return true;
  return pendingRequests.has(key);
}

export function throwIfTaskCancelled(signal: AbortSignal | undefined, taskId: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof TaskCancelledError) throw reason;
  if (reason instanceof Error) {
    throw new TaskCancelledError(taskId, reason.message || 'Task cancelled');
  }
  if (typeof reason === 'string' && reason.trim().length > 0) {
    throw new TaskCancelledError(taskId, reason.trim());
  }
  throw new TaskCancelledError(taskId);
}

export function registerTaskCancelHook(
  taskId: string,
  handler: () => void | Promise<void>,
  tenantId = 'default',
): () => void {
  const active = activeTasks.get(taskKey(taskId, tenantId));
  if (!active) {
    return () => {};
  }
  active.onCancel.add(handler);
  return () => active.onCancel.delete(handler);
}

export interface CancelTaskOptions {
  tenantId?: string;
  requestedBy?: string;
  reason?: string;
  chatId?: string;
  turnId?: string;
}

export interface CancelTaskResult {
  ok: boolean;
  status: 'cancelled' | 'already_cancelled' | 'not_found' | 'failed';
  message: string;
  taskId: string;
  tenantId: string;
}

export async function requestTaskCancellation(
  taskIdRaw: string,
  options: CancelTaskOptions = {},
): Promise<CancelTaskResult> {
  const taskId = taskIdRaw.trim();
  const tenantId = options.tenantId ?? 'default';
  const requestedBy = options.requestedBy ?? 'system';
  const reason = options.reason ?? 'User requested cancellation';
  const key = taskKey(taskId, tenantId);

  if (!taskId) {
    return {
      ok: false,
      status: 'failed',
      message: 'Task ID is required',
      taskId,
      tenantId,
    };
  }

  const existing = getById(taskId, tenantId);
  if (!existing) {
    safeLogEvent('task_cancel_failed', taskId, {
      reason: 'task_not_found',
      requested_by: requestedBy,
      cancel_reason: reason,
    }, tenantId);
    return {
      ok: false,
      status: 'not_found',
      message: `Task not found: ${taskId}`,
      taskId,
      tenantId,
    };
  }

  const req: CancellationRequest = {
    taskId,
    tenantId,
    requestedBy,
    reason,
    requestedAt: Date.now(),
    chatId: options.chatId,
    turnId: options.turnId,
  };
  pendingRequests.set(key, req);

  safeLogEvent('task_cancel_requested', taskId, {
    requested_by: requestedBy,
    cancel_reason: reason,
    chat_id: options.chatId,
    turn_id: options.turnId,
    status_before: existing.status,
  }, tenantId);

  try {
    cancelTaskDag(taskId, tenantId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    safeLogEvent('task_cancel_failed', taskId, {
      reason: 'task_dag_cancel_failed',
      requested_by: requestedBy,
      cancel_reason: reason,
      error: message,
    }, tenantId);
    return {
      ok: false,
      status: 'failed',
      message: `Failed to mark task cancelled: ${message}`,
      taskId,
      tenantId,
    };
  }

  const active = activeTasks.get(key);
  if (!active) {
    safeLogEvent('task_cancelled', taskId, {
      requested_by: requestedBy,
      cancel_reason: reason,
      running: false,
    }, tenantId);
    return {
      ok: true,
      status: 'cancelled',
      message: `Task cancelled: ${taskId}`,
      taskId,
      tenantId,
    };
  }

  if (active.controller.signal.aborted) {
    return {
      ok: true,
      status: 'already_cancelled',
      message: `Task already cancelling: ${taskId}`,
      taskId,
      tenantId,
    };
  }

  active.controller.abort(new TaskCancelledError(taskId, reason));
  const hookErrors: string[] = [];
  for (const hook of active.onCancel) {
    try {
      await hook();
    } catch (err) {
      hookErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (hookErrors.length > 0) {
    logger.warn({ taskId, tenantId, errors: hookErrors }, 'One or more task cancel hooks failed');
    safeLogEvent('task_cancel_failed', taskId, {
      reason: 'cancel_hook_failed',
      requested_by: requestedBy,
      cancel_reason: reason,
      errors: hookErrors,
    }, tenantId);
  }

  safeLogEvent('task_cancelled', taskId, {
    requested_by: requestedBy,
    cancel_reason: reason,
    running: true,
    cancel_hook_errors: hookErrors.length,
  }, tenantId);

  return {
    ok: true,
    status: 'cancelled',
    message: `Task cancelled: ${taskId}`,
    taskId,
    tenantId,
  };
}

export function resetTaskCancellationRegistry(): void {
  activeTasks.clear();
  pendingRequests.clear();
}
