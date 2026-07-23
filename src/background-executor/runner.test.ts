import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackgroundJobRunner, cascadeCancelCronTask } from './runner.js';
import { PermanentBackgroundTaskError, registerHandler, clearHandlers } from './registry.js';
import { shellBackgroundHandler } from './handlers/shell-background.js';
import {
  addBackgroundTask,
  BACKGROUND_TASK_RETRY_BASE_MS,
  BACKGROUND_TASK_RETRY_MAX_MS,
  calculateRetryDelayMs,
  getTask,
  markRunning,
  resetBackgroundTaskTableFlag,
} from '../core/background-tasks.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { deliverScheduledMessage } from '../channels/scheduled-delivery.js';
import { create, getById, updateStatus } from '../store/task-dag.js';
import { getDb } from '../store/db.js';
import { executeDag } from '../core/dag-executor.js';
import type { LLMClient } from '../core/llm.js';
import { resetTaskCancellationRegistry } from '../core/task-cancellation.js';

// Mock proactive-notifier to avoid real Telegram calls
vi.mock('../channels/proactive-notifier.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../channels/scheduled-delivery.js', () => ({
  deliverScheduledMessage: vi.fn().mockResolvedValue({ persisted: true, liveRecipients: 0 }),
}));

describe('BackgroundJobRunner', () => {
  let runner: BackgroundJobRunner;

  beforeEach(() => {
    setupTestDb();
    resetBackgroundTaskTableFlag();
    clearHandlers();
    resetTaskCancellationRegistry();
    vi.mocked(deliverScheduledMessage).mockReset().mockResolvedValue({ persisted: true, liveRecipients: 0 });
    runner = new BackgroundJobRunner({ pollIntervalMs: 50, tenantId: 'default' });
  });

  afterEach(async () => {
    runner.stop();
    await runner.waitForIdle();
    teardownTestDb();
  });

  it('picks up pending task and executes handler', async () => {
    registerHandler('test_handler', async (_task, _signal) => {
      return 'done!';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Test task',
      handlerType: 'test_handler',
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(1);
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
    expect(task!.result).toBe('done!');
    expect(task!.delivery_status).toBe('delivered');
  });

  it('executes an enqueued task through the shell handler registry path', async () => {
    registerHandler('shell_background', shellBackgroundHandler);

    const created = addBackgroundTask({
      chatId: 'chat1',
      objective: 'Echo from shell',
      handlerType: 'shell_background',
      handlerParams: { command: 'printf shell-ok' },
      timeoutMs: 5_000,
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(created.id);
    expect(task!.status).toBe('completed');
    expect(task!.result).toBe('shell-ok');
    expect(task!.last_error).toBeNull();
    expect(task!.running_since).toBeNull();
  });

  it('marks task as failed when handler throws', async () => {
    registerHandler('fail_handler', async () => {
      throw new Error('Something broke');
    });

    const created = addBackgroundTask({
      chatId: 'chat1',
      objective: 'Failing task',
      handlerType: 'fail_handler',
      maxRetries: 0, // No retries
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(created.id);
    expect(task!.status).toBe('failed');
    expect(task!.result).toContain('Something broke');
  });

  it('does not retry a permanently invalid managed task', async () => {
    let attempts = 0;
    registerHandler('permanent_handler', async () => {
      attempts += 1;
      throw new PermanentBackgroundTaskError('Missing persisted scheduler identity');
    });
    const created = addBackgroundTask({
      chatId: 'chat1', objective: 'Invalid managed task', handlerType: 'permanent_handler', maxRetries: 3,
    });

    await runner.tick();
    await runner.waitForIdle();

    expect(getTask(created.id)).toMatchObject({
      status: 'failed', retry_count: 0, last_error: 'Missing persisted scheduler identity',
    });
    expect(attempts).toBe(1);
  });

  it('recovers a task stranded in running state when the runner starts', async () => {
    registerHandler('recovered_handler', async () => 'recovered');
    const created = addBackgroundTask({ chatId: 'chat1', objective: 'Recover me', handlerType: 'recovered_handler' });
    markRunning(created.id);
    expect(getTask(created.id)?.status).toBe('running');

    runner.start();
    const deadline = Date.now() + 2_000;
    while (getTask(created.id)?.status !== 'completed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await runner.waitForIdle();

    expect(getTask(created.id)).toMatchObject({ status: 'completed', result: 'recovered' });
  });

  it('retries result delivery without rerunning the handler', async () => {
    let handlerCalls = 0;
    registerHandler('deliver_once', async () => {
      handlerCalls += 1;
      return 'durable result';
    });
    vi.mocked(deliverScheduledMessage).mockRejectedValueOnce(new Error('channel offline'));
    const created = addBackgroundTask({ chatId: 'chat1', objective: 'Delivery retry', handlerType: 'deliver_once' });

    await runner.tick();
    await runner.waitForIdle();
    const afterFailure = getTask(created.id)!;
    expect(afterFailure.status).toBe('completed');
    expect(afterFailure.delivery_status).toBe('retrying');
    expect(handlerCalls).toBe(1);

    // Make the persisted delivery due without touching task execution state.
    const { getDb } = await import('../store/db.js');
    getDb().prepare('UPDATE background_tasks SET delivery_after = ? WHERE id = ?').run(Date.now() - 1, created.id);
    await runner.tick();
    expect(getTask(created.id)?.delivery_status).toBe('delivered');
    expect(handlerCalls).toBe(1);
  });

  it('retries task on failure only after exponential backoff delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      let attempts = 0;
      registerHandler('retry_handler', async () => {
        attempts++;
        if (attempts < 2) throw new Error('Temporary failure');
        return 'succeeded on retry';
      });

      addBackgroundTask({
        chatId: 'chat1',
        objective: 'Retry task',
        handlerType: 'retry_handler',
        maxRetries: 3,
      });

      await runner.tick();
      await runner.waitForIdle();

      let task = getTask(1);
      expect(task!.status).toBe('retrying');
      expect(task!.retry_count).toBe(1);
      expect(task!.retry_after).toBe(Date.now() + BACKGROUND_TASK_RETRY_BASE_MS);

      await runner.tick();
      await runner.waitForIdle();
      expect(attempts).toBe(1);
      expect(getTask(1)!.status).toBe('retrying');

      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_RETRY_BASE_MS);
      await runner.tick();
      await runner.waitForIdle();

      task = getTask(1);
      expect(task!.status).toBe('completed');
      expect(task!.result).toBe('succeeded on retry');
      expect(task!.retry_after).toBeNull();
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calculates capped exponential retry delays', () => {
    expect(calculateRetryDelayMs(1)).toBe(BACKGROUND_TASK_RETRY_BASE_MS);
    expect(calculateRetryDelayMs(2)).toBe(BACKGROUND_TASK_RETRY_BASE_MS * 2);
    expect(calculateRetryDelayMs(3)).toBe(BACKGROUND_TASK_RETRY_BASE_MS * 4);
    expect(calculateRetryDelayMs(10)).toBe(BACKGROUND_TASK_RETRY_MAX_MS);
  });

  it('fails task when no handler is registered', async () => {
    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Unknown type task',
      handlerType: 'nonexistent_handler',
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(1);
    expect(task!.status).toBe('failed');
    expect(task!.result).toContain('No handler registered');
  });

  it('respects max concurrent task limit', async () => {
    let running = 0;
    let maxConcurrent = 0;

    registerHandler('slow_handler', async (_task, signal) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { running--; resolve(); }, 200);
        signal.addEventListener('abort', () => { clearTimeout(timer); running--; reject(new Error('abort')); }, { once: true });
      });
      return 'done';
    });

    // Create 5 tasks
    for (let i = 0; i < 5; i++) {
      addBackgroundTask({
        chatId: 'chat1',
        objective: `Task ${i}`,
        handlerType: 'slow_handler',
      });
    }

    await runner.tick();
    await new Promise(r => setTimeout(r, 50));

    // Should have at most 3 running (MAX_CONCURRENT_TASKS)
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('aborts task on timeout', async () => {
    registerHandler('timeout_handler', async (_task, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10000); // Would take 10s
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
      });
      return 'should not reach';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Timeout task',
      handlerType: 'timeout_handler',
      timeoutMs: 100, // 100ms timeout
      maxRetries: 0,
    });

    await runner.tick();
    await runner.waitForIdle();

    const task = getTask(1);
    expect(task!.status).toBe('failed');
    expect(task!.result).toContain('Timeout');
  });

  it('does not pick up already running tasks', async () => {
    let callCount = 0;
    registerHandler('count_handler', async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 200));
      return 'done';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Single exec task',
      handlerType: 'count_handler',
    });

    // Tick twice quickly
    await runner.tick();
    await runner.tick();
    await runner.waitForIdle();

    expect(callCount).toBe(1); // Only executed once
  });

  it('tracks active count correctly', async () => {
    registerHandler('active_handler', async (_task, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('abort')); }, { once: true });
      });
      return 'done';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Active task',
      handlerType: 'active_handler',
    });

    expect(runner.activeCount).toBe(0);
    await runner.tick();
    await new Promise(r => setTimeout(r, 20));
    expect(runner.activeCount).toBe(1);
    await runner.waitForIdle();
    expect(runner.activeCount).toBe(0);
  });

  it('handles empty pending queue gracefully', async () => {
    await runner.tick(); // No tasks — should not throw
    expect(runner.activeCount).toBe(0);
  });

  it('stop aborts running tasks', async () => {
    let aborted = false;
    registerHandler('long_handler', async (_task, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        signal.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(new Error('abort')); }, { once: true });
      });
      return 'done';
    });

    addBackgroundTask({
      chatId: 'chat1',
      objective: 'Long task',
      handlerType: 'long_handler',
    });

    await runner.tick();
    await new Promise(r => setTimeout(r, 50));
    expect(runner.activeCount).toBe(1);

    runner.stop();
    await runner.waitForIdle();
    expect(aborted).toBe(true);
    expect(runner.activeCount).toBe(0);
  });

  it('cascade-cancels pending, retrying, and running cron work without retry or failure delivery', async () => {
    const cronId = 'cron-cascade';
    const root = create({ tenant_id: 'default', title: 'Plan root', objective: 'Cancel this plan' });
    const runningStep = create({
      tenant_id: 'default', parent_task_id: root.id, title: 'Long step', objective: 'Wait until cancelled',
    });
    const blockedStep = create({
      tenant_id: 'default', parent_task_id: root.id, title: 'Blocked step', objective: 'Must never run',
      depends_on: [runningStep.id],
    });
    updateStatus(root.id, 'running', 'default');

    let stepStarted!: () => void;
    const started = new Promise<void>(resolve => { stepStarted = resolve; });
    const client: LLMClient = {
      provider: 'test',
      model: 'test',
      chat: async (_messages, options) => new Promise((_resolve, reject) => {
        stepStarted();
        options?.abort_signal?.addEventListener('abort', () => {
          reject(options.abort_signal?.reason);
        }, { once: true });
      }),
      stream: async function* () {},
    };
    registerHandler('cascade_plan', async () => executeDag(
      [runningStep, blockedStep], 'Delegation prompt', 'chat1', undefined, client,
    ));
    const running = addBackgroundTask({
      chatId: 'chat1', objective: 'Running plan', handlerType: 'cascade_plan',
      sourceCronTaskId: cronId, handlerParams: { managed_plan_root_id: root.id }, maxRetries: 3,
    });
    await runner.tick();
    await started;

    const pending = addBackgroundTask({
      chatId: 'chat1', objective: 'Queued run', handlerType: 'cascade_plan', sourceCronTaskId: cronId,
    });
    const retrying = addBackgroundTask({
      chatId: 'chat1', objective: 'Retrying run', handlerType: 'cascade_plan', sourceCronTaskId: cronId,
    });
    getDb().prepare("UPDATE background_tasks SET status = 'retrying', retry_after = ? WHERE id = ?")
      .run(Date.now() + 60_000, retrying.id);

    const retryCountBefore = getTask(running.id)?.retry_count;
    await cascadeCancelCronTask(cronId, 'default');
    await runner.waitForIdle();
    await runner.tick();

    for (const task of [running, pending, retrying]) {
      expect(getTask(task.id)).toMatchObject({
        status: 'cancelled', retry_after: null, delivery_status: 'none',
      });
    }
    expect(getTask(running.id)?.retry_count).toBe(retryCountBefore);
    expect(getById(root.id, 'default')?.status).toBe('cancelled');
    expect(getById(runningStep.id, 'default')?.status).toBe('cancelled');
    expect(getById(blockedStep.id, 'default')?.status).toBe('cancelled');
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM event_log WHERE event_type IN ('dag_tool_loop_guard', 'task_retry_scheduled')")
      .get()).toEqual({ count: 0 });
    expect(deliverScheduledMessage).not.toHaveBeenCalled();
  });
});
