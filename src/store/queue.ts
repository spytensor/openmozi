import { getDb } from './db.js';

/** Enqueue a message into the queue */
export function enqueue(
  channel: string,
  sender: string,
  receiver: string,
  payload: unknown,
  priority = 0,
  tenantId = 'default',
  ttlSeconds?: number
): { id: number } {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO message_queue (tenant_id, channel, sender, receiver, payload, priority, status, created_at, ttl_seconds)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?)
  `);
  const result = stmt.run(tenantId, channel, sender, receiver, JSON.stringify(payload), priority, ttlSeconds ?? null);
  return { id: Number(result.lastInsertRowid) };
}

/** Dequeue the highest-priority pending message for a receiver on a channel */
export function dequeue(
  channel: string,
  receiver: string,
  tenantId = 'default'
): { id: number; channel: string; sender: string; receiver: string; payload: unknown; priority: number; created_at: string } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, channel, sender, receiver, payload, priority, created_at
    FROM message_queue
    WHERE tenant_id = ? AND channel = ? AND receiver = ? AND status = 'pending'
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `).get(tenantId, channel, receiver) as { id: number; channel: string; sender: string; receiver: string; payload: string; priority: number; created_at: string } | undefined;

  if (!row) return null;

  // Mark as processing
  db.prepare(`UPDATE message_queue SET status = 'processing', processed_at = datetime('now') WHERE id = ?`).run(row.id);

  return {
    ...row,
    payload: JSON.parse(row.payload),
  };
}

/** Acknowledge a processed message */
export function ack(messageId: number): void {
  const db = getDb();
  db.prepare(`UPDATE message_queue SET status = 'done' WHERE id = ?`).run(messageId);
}

/** Mark a message as failed */
export function fail(messageId: number): void {
  const db = getDb();
  db.prepare(`UPDATE message_queue SET status = 'failed' WHERE id = ?`).run(messageId);
}
