import type { FastifyInstance } from 'fastify';
import { getAccessibleChatIdsForUser, getHistory } from '../memory/conversations.js';
import { getSession, listSessions } from '../memory/sessions.js';
import { addCronTask, cancelCronTask, isScheduledHandlerType, listCronTaskRuns, listCronTasks, runCronTaskNow, setCronTaskEnabled } from '../scheduler/cron-tasks.js';
import { addReminder, cancelReminder, listReminders } from '../scheduler/reminders.js';

type TenantContext = { tenant_id: string; user_id: string; roles: string[] };

function context(request: unknown): TenantContext | undefined {
  return (request as { tenantContext?: TenantContext }).tenantContext;
}

function canAccessChat(tenant: TenantContext | undefined, chatId: string): boolean {
  if (!tenant?.user_id) return true;
  if (chatId.startsWith(`${tenant.user_id}:`)) {
    const sessionId = chatId.slice(tenant.user_id.length + 1);
    if (getSession(sessionId, tenant.tenant_id)?.user_id === tenant.user_id) return true;
  }
  return getAccessibleChatIdsForUser(tenant.user_id, tenant.tenant_id).includes(chatId);
}

function resolveWebDeliveryTarget(tenant: TenantContext | undefined, requestedChatId?: string): {
  chatId: string;
  userId?: string;
  sessionId?: string;
  channelType?: string;
} | null {
  const requested = requestedChatId?.trim() || '';
  if (!tenant?.user_id) return requested ? { chatId: requested } : null;
  if (requested && !canAccessChat(tenant, requested)) return null;

  let sessionId: string | undefined;
  if (requested) {
    const latest = getHistory(requested, 1, tenant.tenant_id, undefined, { userId: tenant.user_id }).at(-1);
    sessionId = latest?.session_id ?? undefined;
    if (!sessionId && requested.startsWith(`${tenant.user_id}:`)) {
      const candidate = requested.slice(tenant.user_id.length + 1);
      if (getSession(candidate, tenant.tenant_id)?.user_id === tenant.user_id) sessionId = candidate;
    }
  }
  sessionId ??= listSessions(tenant.user_id, { tenantId: tenant.tenant_id, limit: 1 })[0]?.id;
  if (!sessionId) return null;
  return {
    chatId: requested || `${tenant.user_id}:${sessionId}`,
    userId: tenant.user_id,
    sessionId,
    channelType: 'websocket',
  };
}

export function registerSchedulerRoutes(app: FastifyInstance): void {
  app.get('/api/scheduler/tasks', async (request, reply) => {
    const tenant = context(request);
    const tasks = listCronTasks(tenant?.tenant_id ?? 'default').filter(task => canAccessChat(tenant, task.chat_id));
    return reply.send({ tasks: tasks.map(task => ({
      ...task,
      runs: listCronTaskRuns(task.tenant_id, task.id).slice(0, 10),
    })) });
  });

  app.post('/api/scheduler/tasks', async (request, reply) => {
    const body = request.body as {
      chatId: string;
      scheduleKind: 'at' | 'every' | 'cron';
      scheduleValue: string;
      handlerType: string;
      handlerParams?: Record<string, unknown>;
      description: string;
      deleteAfterRun?: boolean;
      timezone?: string;
    };
    if (!body.chatId || !body.scheduleKind || !body.scheduleValue || !body.handlerType || !body.description) {
      return reply.code(400).send({ error: 'Missing required fields: chatId, scheduleKind, scheduleValue, handlerType, description' });
    }
    const tenant = context(request);
    if (!isScheduledHandlerType(body.handlerType)) return reply.code(400).send({ error: 'Unsupported scheduled handler' });
    if (body.handlerType !== 'notify' && tenant && !tenant.roles.some(role => role === 'admin' || role === 'operator')) {
      return reply.code(403).send({ error: 'Operator role required for executable scheduled handlers' });
    }
    const target = resolveWebDeliveryTarget(tenant, body.chatId);
    if (!target) return reply.code(404).send({ error: 'Chat or session not found' });
    const creatingSession = target.sessionId
      ? getSession(target.sessionId, tenant?.tenant_id ?? 'default')
      : null;
    if (!creatingSession?.permission_level) {
      return reply.code(400).send({ error: 'Scheduled tasks require a creating session permission level' });
    }
    try {
      return reply.send({ task: addCronTask({
        ...body,
        ...target,
        permissionLevel: creatingSession.permission_level,
        tenantId: tenant?.tenant_id ?? 'default',
      }) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/scheduler/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: '"enabled" must be boolean' });
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const task = listCronTasks(tenantId).find(entry => entry.id === id && canAccessChat(tenant, entry.chat_id));
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    try {
      setCronTaskEnabled(id, body.enabled, tenantId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/scheduler/tasks/:id/run-now', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const task = listCronTasks(tenantId).find(entry => entry.id === id && canAccessChat(tenant, entry.chat_id));
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const run = runCronTaskNow(id, tenantId);
    if (!run) return reply.code(409).send({ error: 'This task already has an active run' });
    return reply.send({ run });
  });

  app.delete('/api/scheduler/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const task = listCronTasks(tenantId).find(entry => entry.id === id && canAccessChat(tenant, entry.chat_id));
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const { cascadeCancelCronTask } = await import('../background-executor/runner.js');
    await cascadeCancelCronTask(id, tenantId);
    cancelCronTask(id, tenantId);
    return reply.send({ ok: true });
  });

  app.get('/api/scheduler/reminders', async (request, reply) => {
    const tenant = context(request);
    const reminders = listReminders(tenant?.tenant_id ?? 'default').filter(reminder => canAccessChat(tenant, reminder.chat_id));
    return reply.send({ reminders });
  });

  app.post('/api/scheduler/reminders', async (request, reply) => {
    const body = request.body as { chatId?: string; message: string; delayMinutes: number };
    if (!body.message || typeof body.delayMinutes !== 'number' || !Number.isFinite(body.delayMinutes) || body.delayMinutes < 0) {
      return reply.code(400).send({ error: 'Missing or invalid fields: message, delayMinutes' });
    }
    const tenant = context(request);
    const target = resolveWebDeliveryTarget(tenant, body.chatId);
    if (!target) return reply.code(400).send({ error: 'Unable to resolve an owned session for this reminder' });
    return reply.send({ reminder: addReminder({
      ...target,
      message: body.message,
      delayMinutes: body.delayMinutes,
      tenantId: tenant?.tenant_id ?? 'default',
    }) });
  });

  app.delete('/api/scheduler/reminders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const reminderId = Number(id);
    if (!Number.isInteger(reminderId) || reminderId <= 0) return reply.code(400).send({ error: 'Invalid reminder ID' });
    const tenant = context(request);
    const tenantId = tenant?.tenant_id ?? 'default';
    const reminder = listReminders(tenantId).find(entry => entry.id === reminderId && canAccessChat(tenant, entry.chat_id));
    if (!reminder) return reply.code(404).send({ error: 'Reminder not found' });
    cancelReminder(reminderId, tenantId);
    return reply.send({ ok: true });
  });
}
