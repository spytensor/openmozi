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

describe('unified scheduler items', () => {
  it('lists prompts and reminders through one shape, due work first', async () => {
    const session = createSession('user-a', 'Current chat', 'tenant-a');
    updateSessionPermissionLevel(session.id, 'L2_SHELL_EXEC', 'tenant-a');
    const app = appFor('tenant-a', 'user-a', ['operator']);

    await app.inject({
      method: 'POST',
      url: '/api/scheduler/items',
      payload: { kind: 'prompt', body: 'Summarise the week', scheduleKind: 'cron', scheduleValue: '0 9 * * 1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/scheduler/items',
      payload: { kind: 'reminder', body: 'Stand up', scheduleKind: 'at', scheduleValue: new Date(Date.now() + 300_000).toISOString() },
    });

    const items = (await app.inject({ method: 'GET', url: '/api/scheduler/items' })).json().items;
    expect(items).toHaveLength(2);
    // One shape covers both: same keys, only `kind` differs.
    for (const item of items) {
      expect(Object.keys(item)).toEqual(expect.arrayContaining(['id', 'kind', 'body', 'schedule', 'status', 'canPause', 'canRunNow']));
    }
    const reminder = items.find((i: { kind: string }) => i.kind === 'reminder');
    const prompt = items.find((i: { kind: string }) => i.kind === 'prompt');
    expect(reminder.body).toBe('Stand up');
    expect(prompt.body).toBe('Summarise the week');
    // A reminder cannot be paused or fired early, and carries no permission
    // level — claiming one would imply a capability it does not have.
    expect(reminder).toMatchObject({ canPause: false, canRunNow: false, permissionLevel: null });
    expect(prompt).toMatchObject({ canPause: true, canRunNow: true, permissionLevel: 'L2_SHELL_EXEC' });
    await app.close();
  });

  it('refuses to pause or early-fire a reminder rather than silently ignoring it', async () => {
    createSession('user-a', 'Current chat', 'tenant-a');
    const app = appFor('tenant-a', 'user-a', ['operator']);
    const created = await app.inject({
      method: 'POST',
      url: '/api/scheduler/items',
      payload: { kind: 'reminder', body: 'Ping', scheduleKind: 'at', scheduleValue: new Date(Date.now() + 60_000).toISOString() },
    });
    const id = created.json().item.id as string;
    expect(id.startsWith('reminder:')).toBe(true);

    expect((await app.inject({ method: 'PATCH', url: `/api/scheduler/items/${id}`, payload: { enabled: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/scheduler/items/${id}/run-now` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/scheduler/items/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/scheduler/items' })).json().items).toEqual([]);
    await app.close();
  });

  // NOTE: this exercises the handler's own gate only. In the real app
  // `requiredRoleForApiRoute` runs first and already requires `operator` for any
  // non-GET /api/scheduler route, so a true viewer never reaches either branch.
  // The in-handler check is the second line of defence, and it is what keeps a
  // prompt — which runs unattended with real privileges — stricter than a
  // reminder, which only sends a message.
  it('gates a prompt behind operator inside the handler, and lets a reminder through', async () => {
    const session = createSession('user-a', 'Current chat', 'tenant-a');
    updateSessionPermissionLevel(session.id, 'L2_SHELL_EXEC', 'tenant-a');
    const app = appFor('tenant-a', 'user-a', ['viewer']);

    const reminder = await app.inject({
      method: 'POST',
      url: '/api/scheduler/items',
      payload: { kind: 'reminder', body: 'Ping', scheduleKind: 'at', scheduleValue: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(reminder.statusCode).toBe(200);

    // A prompt runs at the session permission level unattended, so it keeps the
    // operator gate the dedicated task route already enforced.
    const prompt = await app.inject({
      method: 'POST',
      url: '/api/scheduler/items',
      payload: { kind: 'prompt', body: 'rm -rf something', scheduleKind: 'cron', scheduleValue: '0 9 * * 1' },
    });
    expect(prompt.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an unparseable item id instead of touching the wrong store', async () => {
    createSession('user-a', 'Current chat', 'tenant-a');
    const app = appFor('tenant-a', 'user-a', ['operator']);
    for (const bad of ['nonsense', 'task:', ':123', 'reminder:not-a-number']) {
      const res = await app.inject({ method: 'DELETE', url: `/api/scheduler/items/${encodeURIComponent(bad)}` });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });
});

