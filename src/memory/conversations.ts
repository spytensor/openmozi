import { getDb } from '../store/db.js';
import { invalidateContextCheckpoints } from './context-checkpoints.js';

/** A stored chat message */
export interface ChatMessage {
  id: number;
  chat_id: string;
  role: string;
  content: string;
  model: string | null;
  tokens_used: number;
  session_id: string | null;
  /** JSON blob of per-message extras (e.g. uploaded attachments). Null when none. */
  metadata: string | null;
  created_at: string;
}

export interface DeletedSessionMessage {
  id: number;
  role: string;
  content: string;
  created_at: string;
  /** One-based position among equal role/content rows, for timeline reconciliation. */
  message_occurrence: number;
  /** The first message ID after a deleted user turn, if one exists. */
  next_user_message_id: number | null;
  deleted_conversation_count: number;
}

/** User-scoped chat access for APIs that need multi-user isolation. */
export interface UserChatScope {
  userId: string;
}

/**
 * Save a message to conversation history.
 */
export function saveMessage(
  chatId: string,
  role: string,
  content: string,
  model?: string,
  tokensUsed?: number,
  sessionId?: string,
  tenantId = 'default',
  metadata?: string,
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO conversations (tenant_id, chat_id, role, content, model, tokens_used, session_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, chatId, role, content, model ?? null, tokensUsed ?? 0, sessionId ?? null, metadata ?? null);
  return Number(result.lastInsertRowid);
}

/**
 * Save a message and touch its session atomically within a single SQLite transaction.
 * Prevents inconsistent state if the process crashes between the two operations.
 */
export function saveMessageAndTouchSession(
  chatId: string,
  role: string,
  content: string,
  sessionId: string,
  tenantId = 'default',
  model?: string,
  tokensUsed?: number,
): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO conversations (tenant_id, chat_id, role, content, model, tokens_used, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, chatId, role, content, model ?? null, tokensUsed ?? 0, sessionId);
    db.prepare(`
      UPDATE sessions SET updated_at = datetime('now') WHERE id = ? AND tenant_id = ?
    `).run(sessionId, tenantId);
    return Number(result.lastInsertRowid);
  });
  return tx();
}

/** Resolve the row just persisted by the gateway so transport-owned timeline
 * delivery can store its durable identity instead of reconstructing it later. */
export function getLatestSessionMessageId(
  sessionId: string,
  role: string,
  content: string,
  tenantId = 'default',
): number | null {
  const row = getDb().prepare(`
    SELECT id FROM conversations
    WHERE tenant_id = ? AND session_id = ? AND role = ? AND content = ?
    ORDER BY id DESC LIMIT 1
  `).get(tenantId, sessionId, role, content) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Get recent messages for a chat, ordered oldest-first.
 * When sessionId is provided, filters by session_id instead of chat_id.
 */
export function getHistory(
  chatId: string,
  limit = 20,
  tenantId = 'default',
  sessionId?: string,
  scope?: UserChatScope,
): ChatMessage[] {
  const db = getDb();

  if (sessionId) {
    const rows = db.prepare(`
      SELECT id, chat_id, role, content, model, tokens_used, session_id, metadata, created_at
      FROM conversations
      WHERE tenant_id = ? AND session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, sessionId, limit) as ChatMessage[];
    return rows.reverse();
  }

  if (scope?.userId) {
    const rows = db.prepare(`
      SELECT id, chat_id, role, content, model, tokens_used, session_id, metadata, created_at
      FROM conversations c
      WHERE c.tenant_id = ?
        AND c.chat_id = ?
        AND (
          c.chat_id = ?
          OR EXISTS (
            SELECT 1
            FROM sessions s
            WHERE s.tenant_id = c.tenant_id
              AND s.id = c.session_id
              AND s.user_id = ?
          )
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, chatId, scope.userId, scope.userId, limit) as ChatMessage[];
    return rows.reverse();
  }

  const rows = db.prepare(`
    SELECT id, chat_id, role, content, model, tokens_used, session_id, metadata, created_at
    FROM conversations
    WHERE tenant_id = ? AND chat_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(tenantId, chatId, limit) as ChatMessage[];

  // Reverse so oldest messages come first
  return rows.reverse();
}

/**
 * Return chat IDs that have persisted data tied to sessions owned by a user.
 * Includes the user ID itself for legacy WebSocket/local-user chats that stored
 * rows before session_id was consistently populated.
 */
export function getAccessibleChatIdsForUser(
  userId: string,
  tenantId = 'default',
): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT c.chat_id AS chat_id
    FROM conversations c
    INNER JOIN sessions s
      ON s.tenant_id = c.tenant_id
     AND s.id = c.session_id
    WHERE c.tenant_id = ?
      AND s.user_id = ?
    UNION
    SELECT DISTINCT e.chat_id AS chat_id
    FROM session_timeline_events e
    INNER JOIN sessions s
      ON s.tenant_id = e.tenant_id
     AND s.id = e.session_id
    WHERE e.tenant_id = ?
      AND s.user_id = ?
  `).all(tenantId, userId, tenantId, userId) as Array<{ chat_id: string }>;

  return [...new Set([userId, ...rows.map(row => row.chat_id)])];
}

/**
 * Get recent messages for a session, ordered oldest-first.
 */
export function getSessionHistory(sessionId: string, limit = 50, tenantId = 'default'): ChatMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, chat_id, role, content, model, tokens_used, session_id, metadata, created_at
    FROM conversations
    WHERE tenant_id = ? AND session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(tenantId, sessionId, limit) as ChatMessage[];
  return rows.reverse();
}

/** Load persisted session messages after a durable context cursor. */
export function getSessionHistoryAfter(
  sessionId: string,
  afterMessageId = 0,
  tenantId = 'default',
  limit = 5000,
): ChatMessage[] {
  return getDb().prepare(`
    SELECT id, chat_id, role, content, model, tokens_used, session_id, metadata, created_at
    FROM conversations
    WHERE tenant_id = ? AND session_id = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(tenantId, sessionId, afterMessageId, limit) as ChatMessage[];
}

/**
 * Delete one displayed message from a session. Removing a user prompt removes
 * its complete turn through (but not including) the following user prompt, so
 * no orphaned assistant/tool context remains in model history.
 */
export function deleteSessionMessage(
  sessionId: string,
  messageId: number,
  tenantId = 'default',
): DeletedSessionMessage | null {
  const db = getDb();
  const tx = db.transaction(() => {
    const target = db.prepare(`
      SELECT id, role, content, created_at
      FROM conversations
      WHERE tenant_id = ? AND session_id = ? AND id = ?
    `).get(tenantId, sessionId, messageId) as Pick<ChatMessage, 'id' | 'role' | 'content' | 'created_at'> | undefined;
    if (!target) return null;

    const nextUser = target.role === 'user'
      ? db.prepare(`
          SELECT id
          FROM conversations
          WHERE tenant_id = ? AND session_id = ? AND role = 'user' AND id > ?
          ORDER BY id ASC
          LIMIT 1
        `).get(tenantId, sessionId, target.id) as { id: number } | undefined
      : undefined;
    const occurrence = db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversations
      WHERE tenant_id = ? AND session_id = ? AND role = ? AND content = ? AND id <= ?
    `).get(tenantId, sessionId, target.role, target.content, target.id) as { count: number };

    const deletion = target.role === 'user'
      ? nextUser
        ? db.prepare(`
            DELETE FROM conversations
            WHERE tenant_id = ? AND session_id = ? AND id >= ? AND id < ?
          `).run(tenantId, sessionId, target.id, nextUser.id)
        : db.prepare(`
            DELETE FROM conversations
            WHERE tenant_id = ? AND session_id = ? AND id >= ?
          `).run(tenantId, sessionId, target.id)
      : db.prepare(`
          DELETE FROM conversations
          WHERE tenant_id = ? AND session_id = ? AND id = ?
        `).run(tenantId, sessionId, target.id);

    // Any destructive history edit invalidates the derived summary projection.
    invalidateContextCheckpoints(sessionId, tenantId);

    db.prepare(`
      UPDATE sessions SET updated_at = datetime('now') WHERE tenant_id = ? AND id = ?
    `).run(tenantId, sessionId);

    return {
      ...target,
      message_occurrence: Number(occurrence.count),
      next_user_message_id: nextUser?.id ?? null,
      deleted_conversation_count: deletion.changes,
    } satisfies DeletedSessionMessage;
  });
  return tx();
}

/**
 * Clear history for a chat.
 */
export function clearHistory(chatId: string, tenantId = 'default'): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM conversations WHERE tenant_id = ? AND chat_id = ?
  `).run(tenantId, chatId);
}
