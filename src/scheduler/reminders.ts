import pino from 'pino';
import { getDb } from '../store/db.js';

const logger = pino({ name: 'mozi:scheduler:reminders-db' });

export type ReminderStatus = 'pending' | 'delivering' | 'retrying' | 'delivered' | 'failed';

export interface Reminder {
  id: number;
  tenant_id: string;
  chat_id: string;
  user_id: string | null;
  session_id: string | null;
  channel_type: string | null;
  message: string;
  fire_at: string;
  fired: number;
  status: ReminderStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: string | null;
  last_error: string | null;
  fired_at: string | null;
  created_at: string;
}

export interface AddReminderOptions {
  chatId: string;
  message: string;
  delayMinutes: number;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  channelType?: string;
  maxAttempts?: number;
}

export type ReminderSendFn = (chatId: string, message: string, reminder: Reminder) => void | Promise<void>;

export const REMINDER_RETRY_BASE_MS = 60_000;
export const REMINDER_RETRY_MAX_MS = 60 * 60_000;
const REMINDER_CLAIM_STALE_MINUTES = 10;

const SELECT_COLS = `id, tenant_id, chat_id, user_id, session_id, channel_type, message,
  fire_at, fired, status, attempt_count, max_attempts, next_attempt_at,
  last_attempt_at, last_error, fired_at, created_at`;

function ensureRemindersTable(): void {
  const db = getDb();
  const existingColumns = db.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>;
  const hadStatusColumn = existingColumns.some(column => column.name === 'status');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      user_id TEXT,
      session_id TEXT,
      channel_type TEXT,
      message TEXT NOT NULL,
      fire_at DATETIME NOT NULL,
      fired BOOLEAN NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at INTEGER,
      last_attempt_at DATETIME,
      last_error TEXT,
      fired_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const [column, definition] of [
    ['user_id', 'TEXT'], ['session_id', 'TEXT'], ['channel_type', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['max_attempts', 'INTEGER NOT NULL DEFAULT 5'],
    ['next_attempt_at', 'INTEGER'], ['last_attempt_at', 'DATETIME'],
    ['last_error', 'TEXT'], ['fired_at', 'DATETIME'], ['created_at', 'DATETIME'],
  ] as const) {
    try { db.exec(`ALTER TABLE reminders ADD COLUMN ${column} ${definition}`); } catch { /* exists */ }
  }
  db.exec(`UPDATE reminders SET status = CASE WHEN fired = 1 THEN 'delivered' ELSE 'pending' END${hadStatusColumn ? " WHERE status IS NULL OR status = ''" : ''}`);
  db.exec("UPDATE reminders SET created_at = COALESCE(created_at, fire_at, datetime('now'))");
  db.exec('DROP INDEX IF EXISTS idx_reminders_due');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders(tenant_id, status, fire_at, next_attempt_at)`);
}

export function calculateReminderRetryDelayMs(attemptCount: number): number {
  return Math.min(
    REMINDER_RETRY_BASE_MS * Math.pow(2, Math.max(0, attemptCount - 1)),
    REMINDER_RETRY_MAX_MS,
  );
}

export function addReminder(opts: AddReminderOptions): Reminder;
export function addReminder(
  chatId: string,
  message: string,
  delayMinutes: number,
  tenantId?: string,
  channelType?: string,
): Reminder;
export function addReminder(
  chatIdOrOpts: string | AddReminderOptions,
  message?: string,
  delayMinutes?: number,
  tenantId = 'default',
  channelType?: string,
): Reminder {
  const opts: AddReminderOptions = typeof chatIdOrOpts === 'string'
    ? { chatId: chatIdOrOpts, message: message!, delayMinutes: delayMinutes!, tenantId, channelType }
    : chatIdOrOpts;
  if (!opts.chatId || typeof opts.chatId !== 'string') throw new Error('"chatId" is required');
  if (!opts.message || typeof opts.message !== 'string') throw new Error('"message" is required');
  if (typeof opts.delayMinutes !== 'number' || !Number.isFinite(opts.delayMinutes) || opts.delayMinutes < 0) {
    throw new Error('"delayMinutes" must be a non-negative number');
  }
  const maxAttempts = opts.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error('"maxAttempts" must be an integer between 1 and 20');
  }

  ensureRemindersTable();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO reminders (
      tenant_id, chat_id, user_id, session_id, channel_type, message,
      fire_at, fired, status, max_attempts
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' minutes'), 0, 'pending', ?)
  `).run(
    opts.tenantId ?? 'default', opts.chatId, opts.userId ?? null, opts.sessionId ?? null,
    opts.channelType?.trim() || null, opts.message, opts.delayMinutes, maxAttempts,
  );
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM reminders WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as Reminder | undefined;
  if (!row) throw new Error('Failed to read inserted reminder');
  return row;
}

export function listReminders(tenantId = 'default'): Reminder[] {
  ensureRemindersTable();
  return getDb().prepare(`SELECT ${SELECT_COLS} FROM reminders WHERE tenant_id = ? ORDER BY fire_at DESC`)
    .all(tenantId) as Reminder[];
}

export function cancelReminder(id: number, tenantId = 'default'): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  ensureRemindersTable();
  return getDb().prepare('DELETE FROM reminders WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes === 1;
}

/** Atomically claim, deliver and terminalize due reminders with bounded retry. */
export async function checkAndFireReminders(
  sendFn: ReminderSendFn,
  tenantId = 'default',
): Promise<number> {
  ensureRemindersTable();
  const db = getDb();
  // A process can die after claiming. Reclaim only stale rows, never a live send.
  db.prepare(`
    UPDATE reminders SET status = 'retrying', next_attempt_at = ?, last_error = COALESCE(last_error, 'stale delivery claim')
    WHERE tenant_id = ? AND status = 'delivering'
      AND last_attempt_at <= datetime('now', '-' || ? || ' minutes')
  `).run(Date.now(), tenantId, REMINDER_CLAIM_STALE_MINUTES);

  const due = db.prepare(`
    SELECT ${SELECT_COLS} FROM reminders
    WHERE tenant_id = ? AND fired = 0
      AND status IN ('pending', 'retrying')
      AND fire_at <= datetime('now')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY fire_at ASC, id ASC
  `).all(tenantId, Date.now()) as Reminder[];

  let firedCount = 0;
  for (const reminder of due) {
    const claimed = db.prepare(`
      UPDATE reminders SET status = 'delivering', attempt_count = attempt_count + 1,
        last_attempt_at = datetime('now'), next_attempt_at = NULL
      WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).run(reminder.id, tenantId, Date.now()).changes === 1;
    if (!claimed) continue;
    const claimedReminder = db.prepare(`SELECT ${SELECT_COLS} FROM reminders WHERE id = ?`)
      .get(reminder.id) as Reminder;
    try {
      await Promise.resolve(sendFn(claimedReminder.chat_id, claimedReminder.message, claimedReminder));
      db.prepare(`UPDATE reminders SET fired = 1, status = 'delivered', fired_at = datetime('now'),
        last_error = NULL, next_attempt_at = NULL WHERE id = ?`).run(reminder.id);
      firedCount += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const terminal = claimedReminder.attempt_count >= claimedReminder.max_attempts;
      const nextAttemptAt = terminal
        ? null
        : Date.now() + calculateReminderRetryDelayMs(claimedReminder.attempt_count);
      db.prepare(`UPDATE reminders SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
        .run(terminal ? 'failed' : 'retrying', error, nextAttemptAt, reminder.id);
      logger.error({ reminderId: reminder.id, chatId: reminder.chat_id, terminal, err: error }, 'Failed to deliver reminder');
    }
  }
  return firedCount;
}
