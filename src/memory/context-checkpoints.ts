import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db.js';

export const CONTEXT_REDUCER_VERSION = 'session-reducer-v1';
export type ContextCheckpointStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ContextCheckpointStage = 'preparing' | 'summarizing' | 'saving' | 'completed' | 'failed';

export interface ContextCheckpoint {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  chat_id: string;
  reducer_version: string;
  source_message_id: number;
  retained_from_message_id: number | null;
  summary: string | null;
  source_token_count: number;
  summary_token_count: number;
  model_context_window: number;
  threshold: number;
  status: ContextCheckpointStatus;
  stage: ContextCheckpointStage;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function getLatestContextCheckpoint(
  sessionId: string,
  tenantId = 'default',
  status?: ContextCheckpointStatus,
): ContextCheckpoint | null {
  const whereStatus = status ? ' AND status = ?' : '';
  const params = status ? [tenantId, sessionId, status] : [tenantId, sessionId];
  return (getDb().prepare(`
    SELECT * FROM context_checkpoints
    WHERE tenant_id = ? AND session_id = ?${whereStatus}
    ORDER BY source_message_id DESC, updated_at DESC LIMIT 1
  `).get(...params) as ContextCheckpoint | undefined) ?? null;
}

export function beginContextCheckpoint(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  chatId: string;
  sourceMessageId: number;
  retainedFromMessageId: number | null;
  sourceTokenCount: number;
  modelContextWindow: number;
  threshold: number;
}): ContextCheckpoint {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM context_checkpoints
    WHERE tenant_id = ? AND session_id = ? AND reducer_version = ? AND source_message_id = ?
  `).get(input.tenantId, input.sessionId, CONTEXT_REDUCER_VERSION, input.sourceMessageId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  db.prepare(`
    INSERT INTO context_checkpoints (
      id, tenant_id, user_id, session_id, chat_id, reducer_version,
      source_message_id, retained_from_message_id, source_token_count,
      model_context_window, threshold, status, stage, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'preparing', NULL)
    ON CONFLICT(tenant_id, session_id, reducer_version, source_message_id) DO UPDATE SET
      user_id = excluded.user_id,
      chat_id = excluded.chat_id,
      retained_from_message_id = excluded.retained_from_message_id,
      source_token_count = excluded.source_token_count,
      model_context_window = excluded.model_context_window,
      threshold = excluded.threshold,
      status = 'running', stage = 'preparing', error = NULL, updated_at = datetime('now')
  `).run(
    id, input.tenantId, input.userId, input.sessionId, input.chatId, CONTEXT_REDUCER_VERSION,
    input.sourceMessageId, input.retainedFromMessageId, input.sourceTokenCount,
    input.modelContextWindow, input.threshold,
  );
  return db.prepare('SELECT * FROM context_checkpoints WHERE id = ?').get(id) as ContextCheckpoint;
}

export function updateContextCheckpointStage(id: string, stage: ContextCheckpointStage): void {
  getDb().prepare(`UPDATE context_checkpoints SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, id);
}

export function completeContextCheckpoint(id: string, summary: string, summaryTokenCount: number): ContextCheckpoint {
  const db = getDb();
  db.prepare(`
    UPDATE context_checkpoints
    SET summary = ?, summary_token_count = ?, status = 'completed', stage = 'completed', error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(summary, summaryTokenCount, id);
  return db.prepare('SELECT * FROM context_checkpoints WHERE id = ?').get(id) as ContextCheckpoint;
}

export function failContextCheckpoint(id: string, error: string): ContextCheckpoint {
  const db = getDb();
  db.prepare(`
    UPDATE context_checkpoints SET status = 'failed', stage = 'failed', error = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(error.slice(0, 2000), id);
  return db.prepare('SELECT * FROM context_checkpoints WHERE id = ?').get(id) as ContextCheckpoint;
}

export function invalidateContextCheckpoints(sessionId: string, tenantId = 'default'): number {
  return getDb().prepare('DELETE FROM context_checkpoints WHERE tenant_id = ? AND session_id = ?')
    .run(tenantId, sessionId).changes;
}
