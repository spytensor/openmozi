import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { addReminder, cancelReminder, checkAndFireReminders } from './reminders.js';

let tmpDir: string;

describe('scheduler/reminders', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('addReminder inserts a pending reminder', () => {
    const reminder = addReminder('chat-1', 'Stand up and stretch', 5, 'tenant-a', 'websocket');

    expect(reminder.id).toBeGreaterThan(0);
    expect(reminder.tenant_id).toBe('tenant-a');
    expect(reminder.chat_id).toBe('chat-1');
    expect(reminder.channel_type).toBe('websocket');
    expect(reminder.message).toBe('Stand up and stretch');
    expect(reminder.fired).toBe(0);
    expect(reminder.status).toBe('pending');
  });

  it('checkAndFireReminders sends due reminders and marks them fired', async () => {
    addReminder('chat-due', 'Due now', 0);
    addReminder('chat-later', 'Not due yet', 10);

    const sent: string[] = [];
    const firedCount = await checkAndFireReminders(async (chatId, message) => {
      sent.push(`${chatId}:${message}`);
    });

    expect(firedCount).toBe(1);
    expect(sent).toEqual(['chat-due:Due now']);

    const db = getDb();
    const rows = db.prepare(`
      SELECT chat_id, channel_type, message, fired
      FROM reminders
      ORDER BY id ASC
    `).all() as Array<{ chat_id: string; channel_type: string | null; message: string; fired: number }>;

    expect(rows).toEqual([
      { chat_id: 'chat-due', channel_type: null, message: 'Due now', fired: 1 },
      { chat_id: 'chat-later', channel_type: null, message: 'Not due yet', fired: 0 },
    ]);
  });

  it('does not fire the same reminder twice', async () => {
    addReminder('chat-repeat', 'Only once', 0);

    const sendFn = vi.fn(async () => {});
    await checkAndFireReminders(sendFn);
    await checkAndFireReminders(sendFn);

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does not mark reminder as fired when sendFn fails', async () => {
    addReminder('chat-fail', 'Will retry', 0);

    const sendFn = vi.fn(async () => {
      throw new Error('network failure');
    });

    const firedCount = await checkAndFireReminders(sendFn);
    expect(firedCount).toBe(0);

    const row = getDb().prepare(`
      SELECT fired, status, attempt_count, next_attempt_at
      FROM reminders
      WHERE chat_id = 'chat-fail'
    `).get() as { fired: number; status: string; attempt_count: number; next_attempt_at: number | null } | undefined;

    expect(row?.fired).toBe(0);
    expect(row?.status).toBe('retrying');
    expect(row?.attempt_count).toBe(1);
    expect(row?.next_attempt_at).toBeGreaterThan(Date.now());
  });

  it('moves to failed after bounded attempts and can be cancelled', async () => {
    const reminder = addReminder({ chatId: 'chat-dead', message: 'bounded', delayMinutes: 0, maxAttempts: 1 });
    await checkAndFireReminders(async () => { throw new Error('offline'); });
    const row = getDb().prepare('SELECT status FROM reminders WHERE id = ?').get(reminder.id) as { status: string };
    expect(row.status).toBe('failed');
    expect(cancelReminder(reminder.id)).toBe(true);
    expect(cancelReminder(reminder.id)).toBe(false);
  });
});
