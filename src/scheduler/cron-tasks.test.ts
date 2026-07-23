import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { BackgroundJobRunner } from '../background-executor/runner.js';
import { clearHandlers, registerHandler } from '../background-executor/registry.js';
import {
  getPendingTasks,
  getTask,
  resetBackgroundTaskTableFlag,
} from '../core/background-tasks.js';
import {
  addCronTask,
  checkAndFireCronTasks,
  cronTaskRunQueue,
  listCronTaskRuns,
  listCronTasks,
  openCronRunSession,
  resetCronTaskTableFlag,
  runCronTaskNow,
  setCronTaskEnabled,
} from './cron-tasks.js';
import { createSession, getSession, listSessions } from '../memory/sessions.js';

vi.mock('../channels/proactive-notifier.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

let tmpDir: string;
let runner: BackgroundJobRunner;

describe('scheduler/cron-tasks background execution', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetBackgroundTaskTableFlag();
    resetCronTaskTableFlag();
    clearHandlers();
    runner = new BackgroundJobRunner({ pollIntervalMs: 50, tenantId: 'default' });
  });

  afterEach(async () => {
    vi.useRealTimers();
    runner.stop();
    await runner.waitForIdle();
    clearHandlers();
    teardownTestDb(tmpDir);
  });

  it('fires a due cron task, enqueues it, and the background runner executes it', async () => {
    registerHandler('notify', async (task) => {
      const params = task.handler_params ? JSON.parse(task.handler_params) as { message?: string } : {};
      return `cron:${params.message ?? 'missing'}`;
    });

    const cron = addCronTask({
      chatId: 'chat-cron',
      scheduleKind: 'at',
      scheduleValue: new Date(Date.now() + 60_000).toISOString(),
      handlerType: 'notify',
      handlerParams: { message: 'ok' },
      description: 'Cron execution test',
    });

    getDb().prepare(`
      UPDATE cron_tasks
      SET next_run_at = datetime('now', '-1 second')
      WHERE id = ?
    `).run(cron.id);

    const fired = checkAndFireCronTasks('default');
    expect(fired).toBe(1);

    const pending = getPendingTasks('default');
    expect(pending).toHaveLength(1);
    expect(pending[0].handler_type).toBe('notify');
    expect(listCronTaskRuns('default', cron.id)[0]?.status).toBe('queued');
    expect((getDb().prepare('SELECT last_status FROM cron_tasks WHERE id = ?').get(cron.id) as { last_status: string }).last_status).toBe('queued');

    await runner.tick();
    await runner.waitForIdle();

    const executed = getTask(pending[0].id);
    expect(executed?.status).toBe('completed');
    expect(executed?.result).toBe('cron:ok');
    expect(listCronTaskRuns('default', cron.id)[0]?.status).toBe('completed');
    const truth = getDb().prepare('SELECT last_status, run_count FROM cron_tasks WHERE id = ?').get(cron.id) as { last_status: string; run_count: number };
    expect(truth).toEqual({ last_status: 'completed', run_count: 1 });
  });

  it('rejects dormant and unsafe schedules', () => {
    expect(() => addCronTask({
      chatId: 'chat-cron', scheduleKind: 'at',
      scheduleValue: new Date(Date.now() - 60_000).toISOString(),
      handlerType: 'notify', description: 'past',
    })).toThrow(/Invalid or non-future schedule/);
    expect(() => addCronTask({
      chatId: 'chat-cron', scheduleKind: 'every', scheduleValue: '60000junk',
      handlerType: 'notify', description: 'bad interval',
    })).toThrow(/Invalid or non-future schedule/);
    expect(() => addCronTask({
      chatId: 'chat-cron', scheduleKind: 'every', scheduleValue: '60000',
      handlerType: 'shell_background', description: 'unsafe',
    })).toThrow(/not allowed/);
  });

  it('enqueues managed Brain work with persisted identity and bounded execution time', () => {
    const cron = addCronTask({
      chatId: 'local-user:sess-market',
      userId: 'local-user',
      sessionId: 'sess-market',
      channelType: 'websocket',
      permissionLevel: 'L2_WRITE',
      scheduleKind: 'cron',
      scheduleValue: '15 15 * * 1-5',
      timezone: 'Asia/Shanghai',
      handlerType: 'managed_brain',
      handlerParams: { prompt: 'Generate the market close dashboard.', timeout_minutes: 75 },
      description: 'Market close dashboard',
    });
    getDb().prepare("UPDATE cron_tasks SET next_run_at = datetime('now', '-1 second') WHERE id = ?").run(cron.id);

    expect(checkAndFireCronTasks('default')).toBe(1);
    const [pending] = getPendingTasks('default');
    expect(pending).toMatchObject({
      chat_id: 'local-user:sess-market',
      user_id: 'local-user',
      session_id: 'sess-market',
      channel_type: 'websocket',
      permission_level: 'L2_WRITE',
      handler_type: 'managed_brain',
      timeout_ms: 75 * 60_000,
      source_cron_task_id: cron.id,
    });
  });

  it('routes scheduled and manual origins through the same durable enqueue path', () => {
    const enqueue = vi.spyOn(cronTaskRunQueue, 'enqueue');
    const cron = addCronTask({
      chatId: 'chat-shared', userId: 'user-shared', sessionId: 'session-shared',
      channelType: 'websocket', permissionLevel: 'L2_WRITE',
      scheduleKind: 'every', scheduleValue: '60000', handlerType: 'notify',
      handlerParams: { message: 'shared' }, description: 'Shared enqueue',
    });
    getDb().prepare("UPDATE cron_tasks SET next_run_at = datetime('now', '-1 second') WHERE id = ?").run(cron.id);

    expect(checkAndFireCronTasks()).toBe(1);
    const scheduled = listCronTaskRuns('default', cron.id)[0];
    const scheduledBackground = getTask(scheduled.background_task_id!);
    expect(scheduled).toMatchObject({ trigger_origin: 'schedule', status: 'queued' });
    getDb().prepare("UPDATE background_tasks SET status = 'completed' WHERE id = ?").run(scheduled.background_task_id);
    getDb().prepare("UPDATE cron_task_runs SET status = 'completed' WHERE id = ?").run(scheduled.id);

    const manual = runCronTaskNow(cron.id);
    const manualBackground = getTask(manual!.background_task_id!);
    expect(manual).toMatchObject({ trigger_origin: 'manual', status: 'queued' });
    expect(manualBackground).toMatchObject({
      chat_id: scheduledBackground?.chat_id,
      user_id: scheduledBackground?.user_id,
      channel_type: scheduledBackground?.channel_type,
      permission_level: scheduledBackground?.permission_level,
      handler_type: scheduledBackground?.handler_type,
      handler_params: scheduledBackground?.handler_params,
      source_cron_task_id: cron.id,
    });
    expect(enqueue.mock.calls.map(call => call[2])).toEqual(['schedule', 'manual']);
  });

  it('creates one correctly owned session per run and reuses it on retry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T04:30:00.000Z'));
    const creation = createSession('local-user', 'Creation chat');
    const cron = addCronTask({
      chatId: `local-user:${creation.id}`, userId: 'local-user', sessionId: creation.id,
      channelType: 'websocket', permissionLevel: 'L2_WRITE',
      scheduleKind: 'cron', scheduleValue: '0 9 * * *', timezone: 'Asia/Shanghai',
      handlerType: 'managed_brain', handlerParams: { prompt: 'Run report' },
      description: 'Morning report',
    });
    getDb().prepare("UPDATE cron_tasks SET next_run_at = '2026-07-22T04:29:00.000Z' WHERE id = ?").run(cron.id);
    expect(checkAndFireCronTasks()).toBe(1);
    const [background] = getPendingTasks('default');

    const first = openCronRunSession(background);
    const second = openCronRunSession(background);

    expect(second.sessionId).toBe(first.sessionId);
    expect(getSession(first.sessionId)).toMatchObject({
      title: 'Morning report · 2026-07-22', user_id: 'local-user', tenant_id: 'default',
    });
    expect(listSessions('local-user')).toHaveLength(2);
    expect(listCronTaskRuns('default', cron.id)[0]?.session_id).toBe(first.sessionId);
    expect(getTask(background.id)?.session_id).toBe(first.sessionId);
    expect(getSession(creation.id)?.message_count).toBe(0);
  });

  it('suppresses the next run while paused and schedules again on resume', () => {
    const cron = addCronTask({
      chatId: 'chat-cron', scheduleKind: 'every', scheduleValue: '60000',
      handlerType: 'notify', description: 'Pause flow',
    });
    expect(setCronTaskEnabled(cron.id, false)).toBe(true);
    expect(listCronTasks('default')[0]).toMatchObject({ enabled: 0, next_run_at: null });
    expect(checkAndFireCronTasks()).toBe(0);
    expect(setCronTaskEnabled(cron.id, true)).toBe(true);
    expect(listCronTasks('default')[0]?.enabled).toBe(1);
    expect(listCronTasks('default')[0]?.next_run_at).not.toBeNull();
  });

  it('deletes a one-shot parent only after successful execution', async () => {
    registerHandler('notify', async () => 'done');
    const cron = addCronTask({
      chatId: 'chat-cron', scheduleKind: 'at',
      scheduleValue: new Date(Date.now() + 60_000).toISOString(),
      handlerType: 'notify', description: 'one shot', deleteAfterRun: true,
    });
    getDb().prepare("UPDATE cron_tasks SET next_run_at = datetime('now', '-1 second') WHERE id = ?").run(cron.id);
    expect(checkAndFireCronTasks()).toBe(1);
    expect(getDb().prepare('SELECT id FROM cron_tasks WHERE id = ?').get(cron.id)).toBeTruthy();
    await runner.tick();
    await runner.waitForIdle();
    expect(getDb().prepare('SELECT id FROM cron_tasks WHERE id = ?').get(cron.id)).toBeUndefined();
    expect(listCronTaskRuns('default', cron.id)[0]?.status).toBe('completed');
  });
});
