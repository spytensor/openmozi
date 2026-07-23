/**
 * BackgroundJobRunner — Polls pending tasks and executes handlers.
 *
 * Design decisions:
 * - Single-process execution (no subprocess forking) — simple and reliable
 * - 10-second poll interval — responsive enough for background work
 * - Max 3 concurrent tasks — prevent resource exhaustion
 * - Timeout via AbortController + setTimeout
 * - Retry with exponential backoff
 * - Notify user on completion/failure via proactive-notifier
 */

import pino from 'pino';
import {
  getPendingTasks,
  getRunningTasks,
  claimTaskForRun,
  markRetrying,
  completeTask,
  failTask,
  getTask,
  getPendingDeliveries,
  claimTaskDelivery,
  completeTaskDelivery,
  retryTaskDelivery,
  recoverOrphanedBackgroundTasks,
  sweepOrphanedPlanTasks,
  type BackgroundTask,
} from '../core/background-tasks.js';
import { PermanentBackgroundTaskError, resolveHandler } from './registry.js';
import { deliverScheduledMessage } from '../channels/scheduled-delivery.js';
import {
  completeCronRun,
  failCronRun,
  markCronRunRetrying,
  markCronRunStarted,
  updateCronRunDelivery,
} from '../scheduler/cron-tasks.js';
import { getDb } from '../store/db.js';
import { requestTaskCancellation, TaskCancelledError } from '../core/task-cancellation.js';

const logger = pino({ name: 'mozi:bg-runner' });

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CONCURRENT_TASKS = 3;

interface RunningHandler {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

const activeHandlers = new Map<string, RunningHandler>();

function handlerKey(taskId: number, tenantId: string): string {
  return `${tenantId}:${taskId}`;
}

/**
 * Terminally cancel every live run derived from one cron task.
 * Persistence is committed before abort signals fire, so late handlers cannot
 * make cancelled work retryable again.
 */
export async function cascadeCancelCronTask(
  cronTaskId: string,
  tenantId = 'default',
): Promise<{ backgroundTasks: number; planTasks: number }> {
  const db = getDb();
  const rows = db.prepare(`SELECT id, handler_params FROM background_tasks
    WHERE tenant_id = ? AND source_cron_task_id = ?
      AND status NOT IN ('completed', 'failed', 'cancelled')`)
    .all(tenantId, cronTaskId) as Array<{ id: number; handler_params: string | null }>;
  const planRootIds = rows.flatMap((row) => {
    if (!row.handler_params) return [];
    let params: { managed_plan_root_id?: unknown };
    try {
      params = JSON.parse(row.handler_params) as { managed_plan_root_id?: unknown };
    } catch {
      return [];
    }
    return typeof params.managed_plan_root_id === 'string' && params.managed_plan_root_id
      ? [params.managed_plan_root_id]
      : [];
  });

  const cancel = db.transaction(() => {
    const backgroundTasks = db.prepare(`UPDATE background_tasks
      SET status = 'cancelled', running_since = NULL, retry_after = NULL,
        delivery_status = 'none', delivery_after = NULL, completed_at = datetime('now'),
        last_error = 'User requested cancellation'
      WHERE tenant_id = ? AND source_cron_task_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled')`)
      .run(tenantId, cronTaskId).changes;
    let planTasks = 0;
    for (const rootTaskId of planRootIds) {
      planTasks += db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
        WHERE tenant_id = ? AND (id = ? OR parent_task_id = ?)
          AND status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(tenantId, rootTaskId, rootTaskId).changes;
    }
    if (rows.length > 0) {
      const ids = rows.map(() => '?').join(', ');
      db.prepare(`UPDATE cron_task_runs SET status = 'cancelled', error = NULL,
        delivery_status = 'none', delivery_error = NULL, completed_at = datetime('now')
        WHERE tenant_id = ? AND background_task_id IN (${ids})
          AND status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(tenantId, ...rows.map(row => row.id));
    }
    return { backgroundTasks, planTasks };
  });
  const cancelled = cancel();

  for (const row of rows) {
    const active = activeHandlers.get(handlerKey(row.id, tenantId));
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new TaskCancelledError(String(row.id), 'User requested cancellation'));
    }
  }
  for (const rootTaskId of planRootIds) {
    const taskIds = db.prepare(`SELECT id FROM tasks
      WHERE tenant_id = ? AND (id = ? OR parent_task_id = ?)`)
      .all(tenantId, rootTaskId, rootTaskId) as Array<{ id: string }>;
    for (const { id } of taskIds) {
      await requestTaskCancellation(id, {
        tenantId,
        requestedBy: 'scheduler',
        reason: 'User requested cancellation',
      });
    }
  }
  return cancelled;
}

export class BackgroundJobRunner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = new Map<number, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  private executions = new Set<Promise<void>>();
  private pollIntervalMs: number;
  private tenantId: string;
  private stopped = false;
  private ticking = false; // Prevent concurrent tick() execution

  constructor(options?: { pollIntervalMs?: number; tenantId?: string }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.tenantId = options?.tenantId ?? 'default';
  }

  /**
   * Start polling for pending tasks.
   */
  start(): void {
    if (this.interval) return;
    this.stopped = false;
    const recovered = recoverOrphanedBackgroundTasks(this.tenantId);
    if (recovered > 0) logger.warn({ recovered, tenantId: this.tenantId }, 'Recovered orphaned background tasks');
    const swept = sweepOrphanedPlanTasks(this.tenantId);
    if (swept > 0) logger.warn({ swept, tenantId: this.tenantId }, 'Cancelled orphaned plan tasks');

    logger.info({ pollIntervalMs: this.pollIntervalMs, tenantId: this.tenantId }, 'BackgroundJobRunner started');

    // Run immediately on start
    void this.tick();

    this.interval = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.interval.unref(); // Don't prevent process exit
  }

  /**
   * Stop polling and abort all running tasks.
   */
  stop(): void {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Abort all running tasks
    for (const [taskId, { controller, timer }] of this.running) {
      clearTimeout(timer);
      controller.abort();
      activeHandlers.delete(handlerKey(taskId, this.tenantId));
      logger.info({ taskId }, 'Running task aborted on shutdown');
    }
    this.running.clear();

    logger.info('BackgroundJobRunner stopped');
  }

  /**
   * Wait for currently executing task promises to settle.
   *
   * stop() stays synchronous for existing callers, while tests and shutdown
   * paths that need a clean teardown can await this to avoid dangling work.
   */
  async waitForIdle(): Promise<void> {
    while (this.executions.size > 0) {
      await Promise.allSettled([...this.executions]);
    }
  }

  /**
   * Number of currently executing tasks.
   */
  get activeCount(): number {
    return this.running.size;
  }

  /**
   * Single poll tick: check pending tasks, check timeouts, execute new tasks.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) return; // Prevent concurrent tick overlap
    this.ticking = true;

    try {
      // 1. Check running tasks for timeouts
      this.checkTimeouts();

      // 2. Get pending tasks
      const pending = getPendingTasks(this.tenantId);

      // Terminal task delivery has its own persisted retry lifecycle. A failed
      // channel must never rerun the handler just to resend its result.
      for (const task of getPendingDeliveries(this.tenantId).slice(0, MAX_CONCURRENT_TASKS)) {
        await this.deliverTaskResult(task);
      }
      if (pending.length === 0) return;

      // 3. Execute up to MAX_CONCURRENT minus currently running
      const slotsAvailable = MAX_CONCURRENT_TASKS - this.running.size;
      if (slotsAvailable <= 0) return;

      const toExecute = pending.slice(0, slotsAvailable);
      for (const task of toExecute) {
        if (this.running.has(task.id)) continue; // Already running
        this.startTask(task);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Tick error');
    } finally {
      this.ticking = false;
    }
  }

  private startTask(task: BackgroundTask): void {
    const execution = this.executeTask(task).catch((err) => {
      logger.error(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'Unhandled background task execution error',
      );
    });
    this.executions.add(execution);
    void execution.finally(() => {
      this.executions.delete(execution);
    });
  }

  /**
   * Execute a single task with timeout and retry.
   */
  private async executeTask(task: BackgroundTask): Promise<void> {
    if (!claimTaskForRun(task.id, task.tenant_id)) {
      logger.debug({ taskId: task.id, tenantId: task.tenant_id }, 'Background task already claimed or terminal');
      return;
    }
    markCronRunStarted(task);

    const handler = resolveHandler(task.handler_type);
    if (!handler) {
      // No handler registered — try a generic fallback or fail
      const msg = `No handler registered for type: ${task.handler_type ?? '(none)'}`;
      logger.warn({ taskId: task.id, handlerType: task.handler_type }, msg);
      failTask(task.id, msg);
      failCronRun(task, msg);
      const failed = getTask(task.id);
      if (failed) await this.deliverTaskResult(failed);
      return;
    }

    // Setup abort controller with timeout BEFORE markRunning to avoid leaks
    const controller = new AbortController();
    const timeoutMs = task.timeout_ms > 0 ? task.timeout_ms : 300_000;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    logger.info({ taskId: task.id, objective: task.objective.slice(0, 100), handlerType: task.handler_type }, 'Task started');
    this.running.set(task.id, { controller, timer });
    activeHandlers.set(handlerKey(task.id, task.tenant_id), { controller, timer });

    try {
      const result = await handler(task, controller.signal);

      // Clear timeout
      clearTimeout(timer);
      this.running.delete(task.id);
      activeHandlers.delete(handlerKey(task.id, task.tenant_id));

      if (controller.signal.reason instanceof TaskCancelledError) return;

      // Mark completed
      completeTask(task.id, result);
      completeCronRun(task, result);
      logger.info({ taskId: task.id, resultLen: result.length }, 'Task completed');
      const completed = getTask(task.id);
      if (completed) await this.deliverTaskResult(completed);
    } catch (err) {
      // Clear timeout
      clearTimeout(timer);
      this.running.delete(task.id);
      activeHandlers.delete(handlerKey(task.id, task.tenant_id));

      const errorMsg = err instanceof Error ? err.message : String(err);
      const isAbort = controller.signal.aborted;
      const permanent = err instanceof PermanentBackgroundTaskError;

      if (controller.signal.reason instanceof TaskCancelledError) {
        logger.info({ taskId: task.id }, 'Background task cancelled by user');
        return;
      }

      if (isAbort) {
        logger.warn({ taskId: task.id, timeoutMs }, 'Task timed out');
      } else {
        logger.error({ taskId: task.id, err: errorMsg }, 'Task failed');
      }

      // Retry if under limit
      const refreshed = getTask(task.id);
      const retryCount = refreshed?.retry_count ?? task.retry_count;
      const maxRetries = refreshed?.max_retries ?? task.max_retries;

      if (!permanent && retryCount < maxRetries) {
        const retry = markRetrying(task.id, isAbort ? `Timeout after ${timeoutMs}ms` : errorMsg);
        markCronRunRetrying(task, isAbort ? `Timeout after ${timeoutMs}ms` : errorMsg);
        logger.info({
          taskId: task.id,
          retryCount: retry.retry_count,
          maxRetries,
          delayMs: retry.delay_ms,
          retryAfter: retry.retry_after,
        }, 'Task scheduled for retry');
      } else {
        failTask(task.id, isAbort ? `Timeout after ${timeoutMs}ms (max retries exhausted)` : errorMsg);
        failCronRun(task, isAbort ? `Timeout after ${timeoutMs}ms (max retries exhausted)` : errorMsg);
        logger.warn({ taskId: task.id, retryCount, maxRetries }, 'Task failed permanently');
        const failed = getTask(task.id);
        if (failed) await this.deliverTaskResult(failed);
      }
    }
  }

  /**
   * Check running tasks for timeout (belt-and-suspenders, main timeout is AbortController).
   */
  private checkTimeouts(): void {
    const runningTasks = getRunningTasks(this.tenantId);
    for (const task of runningTasks) {
      if (!task.running_since) continue;
      const elapsed = Date.now() - new Date(task.running_since + 'Z').getTime();
      const timeoutMs = task.timeout_ms > 0 ? task.timeout_ms : 300_000;

      if (elapsed > timeoutMs * 1.5) {
        // Stale running task — process may have crashed
        const entry = this.running.get(task.id);
        if (entry) {
          clearTimeout(entry.timer);
          entry.controller.abort();
          this.running.delete(task.id);
          activeHandlers.delete(handlerKey(task.id, task.tenant_id));
        }
        failTask(task.id, `Stale task: running for ${Math.round(elapsed / 1000)}s without completing`);
        failCronRun(task, `Stale task: running for ${Math.round(elapsed / 1000)}s without completing`);
        logger.warn({ taskId: task.id, elapsed }, 'Stale running task force-failed');
      }
    }
  }

  /**
   * Notify user about task completion/failure.
   */
  private async deliverTaskResult(task: BackgroundTask): Promise<void> {
    if (!claimTaskDelivery(task.id, task.tenant_id)) return;
    try {
      const refreshed = getTask(task.id) ?? task;
      const status = refreshed.status === 'completed' ? 'completed' : 'failed';
      const detail = refreshed.result ?? refreshed.last_error ?? '(no result)';
      const truncated = detail.length > 500 ? detail.slice(0, 497) + '...' : detail;
      const message = refreshed.handler_type === 'notify' && status === 'completed'
        ? truncated
        : `Background task ${status}:\n${refreshed.objective}\n\n${truncated}`;
      await deliverScheduledMessage({
        tenantId: refreshed.tenant_id,
        chatId: refreshed.chat_id,
        userId: refreshed.user_id,
        sessionId: refreshed.session_id,
        channelType: refreshed.channel_type,
      }, message);
      completeTaskDelivery(refreshed.id);
      updateCronRunDelivery(refreshed, 'delivered');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const retry = retryTaskDelivery(task.id, error);
      updateCronRunDelivery(task, retry.terminal ? 'failed' : 'retrying', error);
      logger.warn({ taskId: task.id, terminal: retry.terminal, err: error }, 'Failed to deliver background task result');
    }
  }
}
