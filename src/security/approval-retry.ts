/**
 * Approval Retry Queue — saves tool execution context when an approval request
 * is created, so it can be auto-retried after the user approves.
 */

import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:approval-retry' });

// ---------------------------------------------------------------------------
// Table setup
// ---------------------------------------------------------------------------

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_retry_queue (
      approval_request_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tableEnsured = true;
}

/** Reset table-ensured flag (for tests). */
export function resetTableFlag(): void {
  tableEnsured = false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryContext {
  approvalRequestId: string;
  tenantId: string;
  chatId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  sessionId: string | null;
}

export interface SaveRetryInput {
  approvalRequestId: string;
  tenantId: string;
  chatId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save tool execution context for auto-retry after approval.
 */
export function savePendingRetry(input: SaveRetryInput): void {
  ensureTable();
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO approval_retry_queue
      (approval_request_id, tenant_id, chat_id, tool_name, tool_args, tool_call_id, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.approvalRequestId,
    input.tenantId,
    input.chatId,
    input.toolName,
    JSON.stringify(input.toolArgs),
    input.toolCallId,
    input.sessionId ?? null,
  );
  logger.info({ approvalRequestId: input.approvalRequestId, toolName: input.toolName }, 'Saved pending retry context');
}

/**
 * Consume (get + delete) retry context for an approved request.
 * Returns null if no retry context exists for the given request.
 */
export function consumePendingRetry(approvalRequestId: string): RetryContext | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM approval_retry_queue WHERE approval_request_id = ?'
  ).get(approvalRequestId) as Record<string, unknown> | undefined;

  if (!row) return null;

  db.prepare('DELETE FROM approval_retry_queue WHERE approval_request_id = ?').run(approvalRequestId);

  return {
    approvalRequestId: row.approval_request_id as string,
    tenantId: row.tenant_id as string,
    chatId: row.chat_id as string,
    toolName: row.tool_name as string,
    toolArgs: JSON.parse(row.tool_args as string) as Record<string, unknown>,
    toolCallId: row.tool_call_id as string,
    sessionId: (row.session_id as string) ?? null,
  };
}

/**
 * Remove expired retry contexts older than the specified TTL.
 */
export function cleanExpiredRetries(ttlMinutes = 30): number {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM approval_retry_queue
    WHERE created_at < datetime('now', ? || ' minutes')
  `).run(`-${ttlMinutes}`);
  const deleted = result.changes;
  if (deleted > 0) {
    logger.info({ deleted, ttlMinutes }, 'Cleaned expired retry contexts');
  }
  return deleted;
}
