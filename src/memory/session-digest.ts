/**
 * Episodic Memory — Session Digests
 *
 * When a session goes stale (24h timeout), generates an LLM-powered digest
 * summarizing what happened. Digests are searchable locally with lexical matching.
 */

import { getDb } from '../store/db.js';
import { getSessionHistory } from './conversations.js';
import type { LLMClient } from '../core/llm.js';
import pino from 'pino';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';

const logger = pino({ name: 'mozi:session-digest' });

const MIN_MESSAGES_FOR_DIGEST = 4;

export interface SessionDigest {
  id: number;
  tenant_id: string;
  session_id: string;
  user_id: string;
  digest: string;
  topics: string[];
  open_threads: string[];
  message_count: number;
  session_start: string | null;
  session_end: string | null;
  created_at: string;
}

interface DigestRow {
  id: number;
  tenant_id: string;
  session_id: string;
  user_id: string;
  digest: string;
  topics: string | null;
  open_threads: string | null;
  message_count: number;
  session_start: string | null;
  session_end: string | null;
  created_at: string;
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function rowToDigest(row: DigestRow): SessionDigest {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    user_id: row.user_id,
    digest: row.digest,
    topics: parseJsonArray(row.topics),
    open_threads: parseJsonArray(row.open_threads),
    message_count: row.message_count,
    session_start: row.session_start,
    session_end: row.session_end,
    created_at: row.created_at,
  };
}

/** Check if a digest already exists for this session */
export function hasDigest(sessionId: string, tenantId = 'default'): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM session_digests WHERE tenant_id = ? AND session_id = ? LIMIT 1',
  ).get(tenantId, sessionId);
  return Boolean(row);
}

/**
 * Generate and save a digest for a completed session.
 * Idempotent — skips if digest already exists or session has too few messages.
 */
export async function generateAndSaveDigest(
  sessionId: string,
  client: LLMClient,
  tenantId = 'default',
): Promise<void> {
  if (hasDigest(sessionId, tenantId)) {
    logger.debug({ sessionId }, 'Digest already exists, skipping');
    return;
  }

  const messages = getSessionHistory(sessionId, 200, tenantId);
  if (messages.length < MIN_MESSAGES_FOR_DIGEST) {
    logger.debug({ sessionId, count: messages.length }, 'Too few messages for digest');
    return;
  }

  // Get user_id from session record
  const db = getDb();
  const sessionRow = db.prepare(
    'SELECT user_id FROM sessions WHERE id = ? AND tenant_id = ?',
  ).get(sessionId, tenantId) as { user_id: string } | undefined;

  if (!sessionRow) {
    logger.warn({ sessionId }, 'Session not found for digest generation');
    return;
  }

  // Build conversation text for LLM (truncate to avoid excessive cost)
  const conversationText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
    .join('\n')
    .slice(0, 8000);

  const prompt = [
    {
      role: 'system' as const,
      content: `Summarize this conversation session. Output JSON only:
{"digest":"2-4 sentence narrative of what happened","topics":["topic1",...],"open_threads":["unresolved item",...]}
Focus on WHAT HAPPENED (events, discussions, conclusions), not just facts.
Include emotional context if relevant. Be concise.`,
    },
    { role: 'user' as const, content: conversationText },
  ];

  try {
    const resp = await client.chat(prompt, { max_tokens: 300, temperature: 0.3 });
    const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ sessionId }, 'Digest LLM response did not contain JSON');
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      digest?: string;
      topics?: string[];
      open_threads?: string[];
    };

    if (!parsed.digest || typeof parsed.digest !== 'string') {
      logger.warn({ sessionId }, 'Digest LLM response missing digest field');
      return;
    }

    const digest = parsed.digest;
    const topics = Array.isArray(parsed.topics) ? parsed.topics.filter((t): t is string => typeof t === 'string') : [];
    const openThreads = Array.isArray(parsed.open_threads) ? parsed.open_threads.filter((t): t is string => typeof t === 'string') : [];

    // Determine session time range
    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];
    const sessionStart = (firstMsg as unknown as Record<string, unknown>).created_at as string | undefined;
    const sessionEnd = (lastMsg as unknown as Record<string, unknown>).created_at as string | undefined;

    db.prepare(`
      INSERT INTO session_digests (tenant_id, session_id, user_id, digest, topics, open_threads, message_count, session_start, session_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, session_id) DO NOTHING
    `).run(
      tenantId,
      sessionId,
      sessionRow.user_id,
      digest,
      JSON.stringify(topics),
      JSON.stringify(openThreads),
      messages.length,
      sessionStart ?? null,
      sessionEnd ?? null,
    );

    logger.info({ sessionId, topics, messageCount: messages.length }, 'Session digest saved');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId, err: errMsg }, 'Session digest generation failed');
  }
}

/** Get recent digests for a user, ordered by most recent first */
export function getRecentDigests(
  userId: string,
  tenantId = 'default',
  days = 14,
  limit = 10,
): SessionDigest[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, tenant_id, session_id, user_id, digest, topics, open_threads,
           message_count, session_start, session_end, created_at
    FROM session_digests
    WHERE tenant_id = ? AND user_id = ? AND created_at > datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(tenantId, userId, days, limit) as DigestRow[];

  return rows.map(rowToDigest);
}

/** Local lexical search over session digests. */
export function searchDigests(
  userId: string,
  query: string,
  tenantId = 'default',
  topK = 5,
): Array<SessionDigest & { score: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, tenant_id, session_id, user_id, digest, topics, open_threads,
           message_count, session_start, session_end, created_at
    FROM session_digests
    WHERE tenant_id = ? AND user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(tenantId, userId) as DigestRow[];

  const queryTerms = tokenizeText(query)
    .filter(term => !isHanToken(term) || hanTokenLength(term) >= 2);
  const scored: Array<SessionDigest & { score: number }> = [];

  for (const row of rows) {
    const haystack = `${row.digest} ${parseJsonArray(row.topics).join(' ')} ${parseJsonArray(row.open_threads).join(' ')}`.toLowerCase();
    const matches = queryTerms.filter(term => haystack.includes(term)).length;
    const score = queryTerms.length > 0 ? matches / queryTerms.length : 0;
    if (score > 0) {
      scored.push({ ...rowToDigest(row), score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Sweep sessions that went idle without ever being digested and backfill their
 * digests.
 *
 * The only other write path (gateway stale-session replacement) fires solely
 * when a message arrives WITHOUT a sessionId and the user's latest session is
 * >24h old — a shape Web/App traffic (which always pins sessionId) never
 * produces. Confirmed live: 45 sessions, 0 digest rows. This sweep is the
 * channel-agnostic writer: any session idle for `idleHours` with no digest row
 * becomes a candidate; `generateAndSaveDigest` keeps its own idempotency
 * (hasDigest) and minimum-message guards, so re-sweeping is safe.
 *
 * @param resolveClient - Called once per sweep that has candidates; lets the
 *                        caller route to a cheap summary-tier model lazily.
 * @param options.idleHours - Idle threshold before a session is digestable.
 * @param options.maxPerSweep - LLM-call cap per sweep so a large backlog
 *                              drains over several runs instead of bursting.
 * @returns Number of sessions for which digest generation was attempted.
 */
export async function sweepStaleSessionDigests(
  resolveClient: () => LLMClient,
  options?: { idleHours?: number; maxPerSweep?: number },
): Promise<number> {
  const idleHours = options?.idleHours ?? 24;
  const maxPerSweep = options?.maxPerSweep ?? 5;
  const db = getDb();

  const candidates = db.prepare(`
    SELECT s.id, s.tenant_id
    FROM sessions s
    LEFT JOIN session_digests d
      ON d.session_id = s.id AND d.tenant_id = s.tenant_id
    WHERE d.id IS NULL
      AND s.updated_at < datetime('now', ?)
      -- Sessions below the digest floor never get a digest row; without this
      -- filter they would occupy the LIMIT slots on every sweep and starve
      -- older real candidates.
      AND (
        SELECT COUNT(*) FROM conversations c
        WHERE c.session_id = s.id AND c.tenant_id = s.tenant_id
          AND c.role IN ('user', 'assistant')
      ) >= ${MIN_MESSAGES_FOR_DIGEST}
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(`-${idleHours} hours`, maxPerSweep) as Array<{ id: string; tenant_id: string }>;

  if (candidates.length === 0) return 0;

  const client = resolveClient();
  let attempted = 0;
  for (const candidate of candidates) {
    try {
      await generateAndSaveDigest(candidate.id, client, candidate.tenant_id);
      attempted++;
    } catch (err) {
      logger.warn(
        { sessionId: candidate.id, err: err instanceof Error ? err.message : String(err) },
        'Digest sweep failed for session',
      );
    }
  }

  logger.info({ candidates: candidates.length, attempted }, 'Session digest sweep completed');
  return attempted;
}
