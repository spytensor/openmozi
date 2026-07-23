import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createSession, updateSessionPermissionLevel } from '../memory/sessions.js';
import { resetCronTaskTableFlag } from '../scheduler/cron-tasks.js';
import { registerSchedulerRoutes } from './scheduler-routes.js';
import { addCronTask } from '../scheduler/cron-tasks.js';
import { addBackgroundTask, getTask } from '../core/background-tasks.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

function appFor(tenantId: string, userId: string, roles = ['viewer']) {
  const app = Fastify();
  app.addHook('preHandler', async request => {
    (request as unknown as { tenantContext: { tenant_id: string; user_id: string; roles: string[] } }).tenantContext = {
      tenant_id: tenantId,
      user_id: userId,
      roles,
    };
  });
  registerSchedulerRoutes(app);
  return app;
}

beforeEach(() => {
  const setup = setupTestDb();
  tmpDir = setup.tmpDir;
  resetCronTaskTableFlag();
});

afterEach(() => teardownTestDb(tmpDir));

describe('scheduler routes', () => {
  it('persists the creating session permission level on API-created tasks', async () => {
    const session = createSession('user-a', 'Current chat', 'tenant-a');
    updateSessionPermissionLevel(session.id, 'L2_SHELL_EXEC', 'tenant-a');
    const app = appFor('tenant-a', 'user-a', ['operator']);

    const created = await app.inject({
      method: 'POST',
      url: '/api/scheduler/tasks',
      payload: {
        chatId: `user-a:${session.id}`,
        scheduleKind: 'at',
        scheduleValue: new Date(Date.now() + 60_000).toISOString(),
        handlerType: 'managed_brain',
        handlerParams: { prompt: 'Run later' },
        description: 'Permission-bound task',
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().task.permission_level).toBe('L2_SHELL_EXEC');
    await app.close();
  });

  it('resolves the authenticated owner latest session and supports reminder deletion', async () => {
    const session = createSession('user-a', 'Current chat', 'tenant-a');
    const app = appFor('tenant-a', 'user-a');
    const created = await app.inject({
      method: 'POST',
      url: '/api/scheduler/reminders',
      payload: { message: 'Stand up', delayMinutes: 5 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().reminder).toMatchObject({
      user_id: 'user-a',
      session_id: session.id,
      channel_type: 'websocket',
      chat_id: `user-a:${session.id}`,
    });
    const id = created.json().reminder.id as number;
    expect((await app.inject({ method: 'DELETE', url: `/api/scheduler/reminders/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/scheduler/reminders' })).json().reminders).toEqual([]);
    await app.close();
  });

  it('rejects arbitrary shell handlers and past one-shot schedules', async () => {
    const session = createSession('user-a', 'Current chat', 'tenant-a');
    const app = appFor('tenant-a', 'user-a');
    const common = {
      chatId: `user-a:${session.id}`,
      scheduleKind: 'at',
      scheduleValue: new Date(Date.now() + 60_000).toISOString(),
      description: 'Unsafe delayed shell',
    };
    const shell = await app.inject({
      method: 'POST', url: '/api/scheduler/tasks',
      payload: { ...common, handlerType: 'shell_background' },
    });
    expect(shell.statusCode).toBe(400);

    const past = await app.inject({
      method: 'POST', url: '/api/scheduler/tasks',
      payload: { ...common, scheduleValue: new Date(Date.now() - 60_000).toISOString(), handlerType: 'notify' },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toMatch(/non-future/);
    await app.close();
  });

  it('cascade-cancels derived background work before deleting a cron task', async () => {
    const session = createSession('user-a', 'Scheduled chat', 'tenant-a');
    const cron = addCronTask({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: session.id,
      chatId: `user-a:${session.id}`, channelType: 'websocket',
      scheduleKind: 'at', scheduleValue: new Date(Date.now() + 60_000).toISOString(),
      handlerType: 'managed_brain', handlerParams: { prompt: 'Run later' }, description: 'Run later',
    });
    const background = addBackgroundTask({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: session.id,
      chatId: `user-a:${session.id}`, handlerType: 'managed_brain', objective: 'Queued work',
      sourceCronTaskId: cron.id,
    });
    const app = appFor('tenant-a', 'user-a');

    expect((await app.inject({ method: 'DELETE', url: `/api/scheduler/tasks/${cron.id}` })).statusCode).toBe(200);
    expect(getTask(background.id)?.status).toBe('cancelled');
    await app.close();
  });

  it('returns the latest ten complete run rows and exposes the enabled state flow', async () => {
    const creation = createSession('user-a', 'Scheduled chat', 'tenant-a');
    const runSession = createSession('user-a', 'Daily report · 2026-07-22', 'tenant-a');
    const cron = addCronTask({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: creation.id,
      chatId: `user-a:${creation.id}`, channelType: 'websocket',
      scheduleKind: 'every', scheduleValue: '60000',
      handlerType: 'managed_brain', handlerParams: { prompt: 'Run report' }, description: 'Daily report',
    });
    for (let index = 0; index < 11; index += 1) {
      getDb().prepare(`INSERT INTO cron_task_runs (
        id, cron_task_id, session_id, trigger_origin, tenant_id, scheduled_for, status,
        delivery_status, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, 'manual', 'tenant-a', datetime('now'), 'completed', 'delivered',
        datetime('now', ?), datetime('now', ?), datetime('now', ?))`)
        .run(`run-visible-${index}`, cron.id, runSession.id, `-${index} seconds`, `-${index + 2} seconds`, `-${index} seconds`);
    }
    const app = appFor('tenant-a', 'user-a');

    const listed = (await app.inject({ method: 'GET', url: '/api/scheduler/tasks' })).json();
    expect(listed.tasks[0].runs).toHaveLength(10);
    expect(listed.tasks[0].runs[0]).toMatchObject({
      id: 'run-visible-0', session_id: runSession.id, trigger_origin: 'manual', status: 'completed',
      started_at: expect.any(String), completed_at: expect.any(String),
    });
    expect((await app.inject({
      method: 'PATCH', url: `/api/scheduler/tasks/${cron.id}`, payload: { enabled: false },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/scheduler/tasks' })).json().tasks[0])
      .toMatchObject({ enabled: 0, next_run_at: null });
    expect((await app.inject({
      method: 'PATCH', url: `/api/scheduler/tasks/${cron.id}`, payload: { enabled: true },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/scheduler/tasks' })).json().tasks[0].next_run_at).toBeTruthy();
    await app.close();
  });

  it('runs a paused task without changing its schedule and rejects overlap', async () => {
    const session = createSession('user-a', 'Scheduled chat', 'tenant-a');
    const cron = addCronTask({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: session.id,
      chatId: `user-a:${session.id}`, channelType: 'websocket',
      scheduleKind: 'every', scheduleValue: '60000', handlerType: 'notify',
      handlerParams: { message: 'Run once' }, description: 'Paused manual run',
    });
    getDb().prepare('UPDATE cron_tasks SET enabled = 0 WHERE id = ?').run(cron.id);
    const before = getDb().prepare(`SELECT enabled, next_run_at, schedule_value, timezone
      FROM cron_tasks WHERE id = ?`).get(cron.id);
    const app = appFor('tenant-a', 'user-a');

    const first = await app.inject({ method: 'POST', url: `/api/scheduler/tasks/${cron.id}/run-now` });
    expect(first.statusCode).toBe(200);
    expect(first.json().run).toMatchObject({ cron_task_id: cron.id, trigger_origin: 'manual', status: 'queued' });
    expect(getDb().prepare(`SELECT enabled, next_run_at, schedule_value, timezone
      FROM cron_tasks WHERE id = ?`).get(cron.id)).toEqual(before);

    const overlap = await app.inject({ method: 'POST', url: `/api/scheduler/tasks/${cron.id}/run-now` });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error).toMatch(/active run/);
    await app.close();
  });
});
