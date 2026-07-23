import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { Cron } from 'croner';
import { getDb } from '../store/db.js';
import { addBackgroundTask, type BackgroundTask } from '../core/background-tasks.js';
import { createSession } from '../memory/sessions.js';

const logger = pino({ name: 'mozi:cron-tasks' });

export type CronScheduleKind = 'at' | 'every' | 'cron';
export const MIN_CRON_INTERVAL_MS = 60_000;
export const SCHEDULED_HANDLER_TYPES = ['notify', 'daily_summary', 'managed_brain', 'llm_background', 'poll_url'] as const;
export type ScheduledHandlerType = (typeof SCHEDULED_HANDLER_TYPES)[number];

export interface CronTask {
  id: string;
  tenant_id: string;
  chat_id: string;
  user_id: string | null;
  session_id: string | null;
  channel_type: string | null;
  permission_level: string | null;
  schedule_kind: CronScheduleKind;
  schedule_value: string;
  timezone: string | null;
  handler_type: string;
  handler_params: string | null;
  description: string;
  enabled: number;
  delete_after_run: number;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

export interface CronTaskRun {
  id: string;
  cron_task_id: string | null;
  background_task_id: number | null;
  session_id: string | null;
  trigger_origin: 'schedule' | 'manual';
  tenant_id: string;
  scheduled_for: string;
  status: string;
  result: string | null;
  error: string | null;
  delivery_status: string;
  delivery_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

let tableEnsured = false;

function ensureCronTasksTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_tasks (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', chat_id TEXT NOT NULL,
      user_id TEXT, session_id TEXT, channel_type TEXT, permission_level TEXT,
      schedule_kind TEXT NOT NULL DEFAULT 'cron', schedule_value TEXT NOT NULL, timezone TEXT,
      handler_type TEXT NOT NULL, handler_params TEXT, description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, delete_after_run INTEGER NOT NULL DEFAULT 0,
      last_run_at DATETIME, next_run_at DATETIME, run_count INTEGER NOT NULL DEFAULT 0,
      last_status TEXT, last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS cron_task_runs (
      id TEXT PRIMARY KEY, cron_task_id TEXT, background_task_id INTEGER,
      session_id TEXT,
      trigger_origin TEXT NOT NULL DEFAULT 'schedule',
      tenant_id TEXT NOT NULL DEFAULT 'default', scheduled_for DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending', delivery_error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at DATETIME, completed_at DATETIME
    );
  `);
  for (const [column, definition] of [
    ['schedule_kind', "TEXT NOT NULL DEFAULT 'cron'"], ['schedule_value', "TEXT NOT NULL DEFAULT ''"],
    ['timezone', 'TEXT'], ['delete_after_run', 'INTEGER NOT NULL DEFAULT 0'],
    ['run_count', 'INTEGER NOT NULL DEFAULT 0'], ['last_status', 'TEXT'], ['last_error', 'TEXT'],
    ['user_id', 'TEXT'], ['session_id', 'TEXT'], ['channel_type', 'TEXT'], ['permission_level', 'TEXT'],
  ] as const) {
    try { db.exec(`ALTER TABLE cron_tasks ADD COLUMN ${column} ${definition}`); } catch { /* exists */ }
  }
  try {
    db.exec("UPDATE cron_tasks SET schedule_value = cron_expression, schedule_kind = 'cron' WHERE schedule_value = '' AND cron_expression IS NOT NULL");
  } catch { /* legacy column absent */ }
  try { db.exec('ALTER TABLE cron_task_runs ADD COLUMN session_id TEXT'); } catch { /* exists */ }
  try { db.exec("ALTER TABLE cron_task_runs ADD COLUMN trigger_origin TEXT NOT NULL DEFAULT 'schedule'"); } catch { /* exists */ }
  db.exec('DROP INDEX IF EXISTS idx_cron_tasks_tenant');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cron_tasks_tenant ON cron_tasks(tenant_id, enabled, next_run_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cron_task_runs_task ON cron_task_runs(tenant_id, cron_task_id, created_at DESC)');
  tableEnsured = true;
}

export function isScheduledHandlerType(value: string): value is ScheduledHandlerType {
  return (SCHEDULED_HANDLER_TYPES as readonly string[]).includes(value);
}

export function computeNextRunAtMs(
  kind: CronScheduleKind,
  value: string,
  nowMs: number,
  timezone?: string | null,
): number | undefined {
  if (kind === 'at') {
    const atMs = new Date(value).getTime();
    return Number.isFinite(atMs) && atMs > nowMs ? atMs : undefined;
  }
  if (kind === 'every') {
    if (!/^\d+$/.test(value)) return undefined;
    const everyMs = Number(value);
    return Number.isSafeInteger(everyMs) && everyMs >= MIN_CRON_INTERVAL_MS ? nowMs + everyMs : undefined;
  }
  if (kind !== 'cron') return undefined;
  try {
    const tz = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const job = new Cron(value, { timezone: tz });
    const next = job.nextRun(new Date(nowMs));
    const nextMs = next?.getTime();
    return nextMs && Number.isFinite(nextMs) && nextMs > nowMs ? nextMs : undefined;
  } catch (err) {
    logger.warn({ kind, value, timezone, err: err instanceof Error ? err.message : String(err) }, 'Invalid schedule');
    return undefined;
  }
}

export function isValidSchedule(
  kind: CronScheduleKind,
  value: string,
  timezone?: string | null,
  nowMs = Date.now(),
): boolean {
  if (!value || typeof value !== 'string') return false;
  return computeNextRunAtMs(kind, value, nowMs, timezone) !== undefined;
}

export interface AddCronTaskOptions {
  chatId: string;
  userId?: string;
  sessionId?: string;
  channelType?: string;
  permissionLevel?: string;
  scheduleKind: CronScheduleKind;
  scheduleValue: string;
  timezone?: string;
  handlerType: string;
  handlerParams?: Record<string, unknown>;
  description: string;
  deleteAfterRun?: boolean;
  tenantId?: string;
}

export function addCronTask(opts: AddCronTaskOptions): CronTask {
  if (!opts.chatId?.trim()) throw new Error('"chatId" is required');
  if (!opts.description?.trim()) throw new Error('"description" is required');
  if (!isScheduledHandlerType(opts.handlerType)) {
    throw new Error(`Handler "${opts.handlerType}" is not allowed for scheduled execution`);
  }
  if (!isValidSchedule(opts.scheduleKind, opts.scheduleValue, opts.timezone)) {
    throw new Error(`Invalid or non-future schedule: ${opts.scheduleKind} "${opts.scheduleValue}"`);
  }
  ensureCronTasksTable();
  const db = getDb();
  const id = `cron_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const nextRunAtMs = computeNextRunAtMs(opts.scheduleKind, opts.scheduleValue, Date.now(), opts.timezone);
  if (!nextRunAtMs) throw new Error('Schedule no longer has a future run time');
  db.prepare(`
    INSERT INTO cron_tasks (
      id, tenant_id, chat_id, user_id, session_id, channel_type, permission_level,
      schedule_kind, schedule_value, timezone, handler_type, handler_params,
      description, delete_after_run, next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.tenantId ?? 'default', opts.chatId, opts.userId ?? null, opts.sessionId ?? null,
    opts.channelType?.trim() || null, opts.permissionLevel ?? null, opts.scheduleKind,
    opts.scheduleValue, opts.timezone?.trim() || null, opts.handlerType,
    opts.handlerParams ? JSON.stringify(opts.handlerParams) : null, opts.description,
    opts.deleteAfterRun ? 1 : 0, new Date(nextRunAtMs).toISOString(),
  );
  logger.info({ cronId: id, nextRunAt: new Date(nextRunAtMs).toISOString() }, 'Scheduled task created');
  return db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(id) as CronTask;
}

export function listCronTasks(tenantId = 'default'): CronTask[] {
  ensureCronTasksTable();
  return getDb().prepare('SELECT * FROM cron_tasks WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as CronTask[];
}

export function listCronTaskRuns(tenantId = 'default', cronTaskId?: string): CronTaskRun[] {
  ensureCronTasksTable();
  return (cronTaskId
    ? getDb().prepare('SELECT * FROM cron_task_runs WHERE tenant_id = ? AND cron_task_id = ? ORDER BY created_at DESC').all(tenantId, cronTaskId)
    : getDb().prepare('SELECT * FROM cron_task_runs WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId)) as CronTaskRun[];
}

function runDate(timezone: string | null): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Create or reuse the session owned by one durable cron run. */
export function openCronRunSession(task: BackgroundTask): {
  sessionId: string;
  userId: string;
  channelType: string;
  chatId: string;
  permissionLevel: string | null;
} {
  if (!task.cron_run_id || !task.source_cron_task_id) {
    throw new Error('Managed scheduled execution requires cron run identity.');
  }
  ensureCronTasksTable();
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT runs.session_id AS run_session_id, cron.*
      FROM cron_task_runs runs JOIN cron_tasks cron ON cron.id = runs.cron_task_id
      WHERE runs.id = ? AND runs.tenant_id = ? AND cron.id = ?`)
      .get(task.cron_run_id, task.tenant_id, task.source_cron_task_id) as (CronTask & { run_session_id: string | null }) | undefined;
    if (!row) throw new Error(`Scheduled run not found: ${task.cron_run_id}`);
    if (!row.user_id || !row.channel_type) {
      throw new Error('Managed scheduled execution requires persisted user and channel identity.');
    }
    const sessionId = row.run_session_id ?? createSession(
      row.user_id,
      `${row.description} · ${runDate(row.timezone)}`,
      row.tenant_id,
    ).id;
    db.prepare('UPDATE cron_task_runs SET session_id = ? WHERE id = ? AND tenant_id = ? AND session_id IS NULL')
      .run(sessionId, task.cron_run_id, task.tenant_id);
    db.prepare('UPDATE background_tasks SET session_id = ? WHERE id = ? AND tenant_id = ? AND cron_run_id = ?')
      .run(sessionId, task.id, task.tenant_id, task.cron_run_id);
    return {
      sessionId,
      userId: row.user_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      permissionLevel: row.permission_level,
    };
  })();
}

export function cancelCronTask(id: string, tenantId = 'default'): boolean {
  ensureCronTasksTable();
  return getDb().prepare('DELETE FROM cron_tasks WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes === 1;
}

export function setCronTaskEnabled(id: string, enabled: boolean, tenantId = 'default'): boolean {
  ensureCronTasksTable();
  const db = getDb();
  const task = db.prepare('SELECT * FROM cron_tasks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as CronTask | undefined;
  if (!task) return false;
  let nextRunAt = task.next_run_at;
  if (enabled) {
    const next = computeNextRunAtMs(task.schedule_kind, task.schedule_value, Date.now(), task.timezone);
    if (!next) throw new Error('Task schedule has no future run time');
    nextRunAt = new Date(next).toISOString();
  }
  db.prepare('UPDATE cron_tasks SET enabled = ?, next_run_at = ? WHERE id = ? AND tenant_id = ?')
    .run(enabled ? 1 : 0, enabled ? nextRunAt : null, id, tenantId);
  return true;
}

function nextAfterTrigger(task: CronTask, scheduledForMs: number, nowMs: number): number | undefined {
  if (task.schedule_kind === 'at') return undefined;
  if (task.schedule_kind === 'every') {
    const interval = Number(task.schedule_value);
    let next = scheduledForMs + interval;
    while (next <= nowMs) next += interval;
    return next;
  }
  return computeNextRunAtMs('cron', task.schedule_value, nowMs, task.timezone);
}

export const cronTaskRunQueue = {
  enqueue(
    task: CronTask,
    scheduledFor: string,
    triggerOrigin: CronTaskRun['trigger_origin'],
  ): CronTaskRun {
    const db = getDb();
    const runId = `cronrun_${randomUUID()}`;
    const params = task.handler_params ? JSON.parse(task.handler_params) as Record<string, unknown> : {};
    const requestedTimeoutMinutes = Number(params.timeout_minutes);
    const timeoutMs = task.handler_type === 'managed_brain'
      ? (Number.isFinite(requestedTimeoutMinutes) ? Math.min(120, Math.max(10, requestedTimeoutMinutes)) : 60) * 60_000
      : undefined;
    const background = addBackgroundTask({
      chatId: task.chat_id, userId: task.user_id ?? undefined,
      sessionId: task.session_id ?? undefined, channelType: task.channel_type ?? undefined,
      permissionLevel: task.permission_level ?? undefined,
      objective: task.description || `Scheduled ${task.schedule_kind} ${task.schedule_value}`,
      tenantId: task.tenant_id, handlerType: task.handler_type, handlerParams: params,
      timeoutMs,
      sourceCronTaskId: task.id, cronRunId: runId,
    });
    db.prepare(`INSERT INTO cron_task_runs (
      id, cron_task_id, background_task_id, tenant_id, scheduled_for, trigger_origin, status, delivery_status
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'pending')`)
      .run(runId, task.id, background.id, task.tenant_id, scheduledFor, triggerOrigin);
    return db.prepare('SELECT * FROM cron_task_runs WHERE id = ? AND tenant_id = ?')
      .get(runId, task.tenant_id) as CronTaskRun;
  },
};

/** Queue one explicit run without changing the task's schedule or enabled state. */
export function runCronTaskNow(id: string, tenantId = 'default'): CronTaskRun | null {
  ensureCronTasksTable();
  const db = getDb();
  return db.transaction(() => {
    const task = db.prepare('SELECT * FROM cron_tasks WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as CronTask | undefined;
    if (!task) throw new Error('Task not found');
    const active = db.prepare(`SELECT 1 FROM background_tasks
      WHERE tenant_id = ? AND source_cron_task_id = ?
        AND status IN ('pending', 'running', 'retrying') LIMIT 1`)
      .get(tenantId, id);
    if (active) return null;
    const run = cronTaskRunQueue.enqueue(task, new Date().toISOString(), 'manual');
    db.prepare("UPDATE cron_tasks SET last_status = 'queued', last_error = NULL WHERE id = ? AND tenant_id = ?")
      .run(id, tenantId);
    return run;
  })();
}

/** Queue due jobs and record only queued truth; handlers own terminal status. */
export function checkAndFireCronTasks(tenantId = 'default'): number {
  ensureCronTasksTable();
  const db = getDb();
  const nowMs = Date.now();
  const tasks = db.prepare(`SELECT * FROM cron_tasks
    WHERE tenant_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC`).all(tenantId, new Date(nowMs).toISOString()) as CronTask[];
  let queued = 0;

  for (const task of tasks) {
    try {
      const scheduledForMs = new Date(task.next_run_at!).getTime();
      if (!Number.isFinite(scheduledForMs) || scheduledForMs > nowMs) continue;
      const nextMs = nextAfterTrigger(task, scheduledForMs, nowMs);
      const enqueue = db.transaction(() => {
        // Conditional claim prevents two overlapping ticks from queuing one run.
        const claimed = db.prepare(`UPDATE cron_tasks SET next_run_at = ?, enabled = ?,
          last_status = 'queued', last_error = NULL
          WHERE id = ? AND tenant_id = ? AND enabled = 1 AND next_run_at = ?`)
          .run(nextMs ? new Date(nextMs).toISOString() : null, task.schedule_kind === 'at' ? 0 : 1,
            task.id, task.tenant_id, task.next_run_at).changes === 1;
        if (!claimed) return false;
        cronTaskRunQueue.enqueue(task, task.next_run_at!, 'schedule');
        return true;
      });
      if (enqueue()) {
        queued += 1;
        logger.info({ cronId: task.id, nextRunAt: nextMs ? new Date(nextMs).toISOString() : null }, 'Scheduled run queued');
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE cron_tasks SET last_status = 'failed', last_error = ? WHERE id = ? AND tenant_id = ?")
        .run(error, task.id, task.tenant_id);
      logger.warn({ cronId: task.id, err: error }, 'Scheduled dispatch failed');
    }
  }
  return queued;
}

export function markCronRunStarted(task: BackgroundTask): void {
  if (!task.cron_run_id) return;
  ensureCronTasksTable();
  const db = getDb();
  db.prepare("UPDATE cron_task_runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ? AND tenant_id = ?")
    .run(task.cron_run_id, task.tenant_id);
  if (task.source_cron_task_id) {
    db.prepare("UPDATE cron_tasks SET last_status = 'running' WHERE id = ? AND tenant_id = ?")
      .run(task.source_cron_task_id, task.tenant_id);
  }
}

export function markCronRunRetrying(task: BackgroundTask, error: string): void {
  if (!task.cron_run_id) return;
  ensureCronTasksTable();
  const db = getDb();
  db.prepare("UPDATE cron_task_runs SET status = 'retrying', error = ? WHERE id = ? AND tenant_id = ?")
    .run(error, task.cron_run_id, task.tenant_id);
  if (task.source_cron_task_id) {
    db.prepare("UPDATE cron_tasks SET last_status = 'retrying', last_error = ? WHERE id = ? AND tenant_id = ?")
      .run(error, task.source_cron_task_id, task.tenant_id);
  }
}

export function completeCronRun(task: BackgroundTask, result: string): void {
  if (!task.cron_run_id) return;
  ensureCronTasksTable();
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE cron_task_runs SET status = 'completed', result = ?, error = NULL, completed_at = datetime('now') WHERE id = ? AND tenant_id = ?")
      .run(result, task.cron_run_id, task.tenant_id);
    if (!task.source_cron_task_id) return;
    const parent = db.prepare('SELECT delete_after_run FROM cron_tasks WHERE id = ? AND tenant_id = ?')
      .get(task.source_cron_task_id, task.tenant_id) as { delete_after_run: number } | undefined;
    db.prepare("UPDATE cron_tasks SET last_status = 'completed', last_error = NULL, last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ? AND tenant_id = ?")
      .run(task.source_cron_task_id, task.tenant_id);
    if (parent?.delete_after_run) {
      db.prepare('DELETE FROM cron_tasks WHERE id = ? AND tenant_id = ?').run(task.source_cron_task_id, task.tenant_id);
    }
  })();
}

export function failCronRun(task: BackgroundTask, error: string): void {
  if (!task.cron_run_id) return;
  ensureCronTasksTable();
  const db = getDb();
  db.prepare("UPDATE cron_task_runs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ? AND tenant_id = ?")
    .run(error, task.cron_run_id, task.tenant_id);
  if (task.source_cron_task_id) {
    db.prepare("UPDATE cron_tasks SET last_status = 'failed', last_error = ?, last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ? AND tenant_id = ?")
      .run(error, task.source_cron_task_id, task.tenant_id);
  }
}

export function updateCronRunDelivery(task: BackgroundTask, status: string, error?: string): void {
  if (!task.cron_run_id) return;
  ensureCronTasksTable();
  getDb().prepare('UPDATE cron_task_runs SET delivery_status = ?, delivery_error = ? WHERE id = ? AND tenant_id = ?')
    .run(status, error ?? null, task.cron_run_id, task.tenant_id);
}

export function isValidCronExpression(expr: string): boolean { return isValidSchedule('cron', expr); }
export function resetCronTaskTableFlag(): void { tableEnsured = false; }
