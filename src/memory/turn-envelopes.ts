/**
 * Turn Envelope persistence (Issue #627).
 *
 * CRUD for the `session_turns` table — the durable, server-authoritative record
 * of each turn's origin, status, and lifetime. Writes are additive: they never
 * touch timeline event rows and never rewrite history. A turn envelope is
 * upserted `active` when the turn starts and transitioned to a terminal status
 * (or `awaiting_approval`) as the runtime learns the truth.
 */

import { getDb } from '../store/db.js';
import {
  isTerminalTurnStatus,
  type TurnEnvelope,
  type TurnOrigin,
  type TurnStatus,
} from '../core/turn-envelope.js';

export interface StartTurnEnvelopeInput {
  tenantId?: string;
  sessionId: string;
  chatId: string;
  turnId: string;
  origin?: TurnOrigin;
  /**
   * Presentation locale for the turn, inferred once from its text on the
   * authoritative path (Issue #628). Optional: omit when there is no reliable
   * language signal — consumers fall back to their own default.
   */
  locale?: string;
  startedAt: number;
}

interface TurnRow {
  tenant_id: string;
  session_id: string;
  chat_id: string;
  turn_id: string;
  origin: string;
  status: string;
  seq_high_water: number;
  locale: string | null;
  started_at: number;
  ended_at: number | null;
}

function rowToEnvelope(row: TurnRow): TurnEnvelope {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    chatId: row.chat_id,
    turnId: row.turn_id,
    origin: row.origin as TurnOrigin,
    status: row.status as TurnStatus,
    seqHighWater: row.seq_high_water,
    locale: row.locale ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  };
}

/**
 * Record (or refresh) the `active` envelope for a starting turn. Idempotent per
 * (tenant, session, turn): re-starting the same id keeps its original
 * `started_at` and never resurrects a `completed`/`failed`/`cancelled` turn.
 *
 * `interrupted` is the one exception: it means "the process died mid-flight",
 * and the durable plan runner resumes exactly that flight under the SAME
 * background turn id at boot. Without resurrection the envelope stays
 * `interrupted` while the resumed run keeps appending rows and later stamps a
 * real terminal status over it (observed live: interrupted → rows kept
 * arriving → failed). Restarting an interrupted turn flips it back to
 * `active` and clears `ended_at`.
 */
export function startTurnEnvelope(input: StartTurnEnvelopeInput): void {
  const db = getDb();
  const tenantId = input.tenantId ?? 'default';
  db.prepare(`
    INSERT INTO session_turns (
      tenant_id, session_id, chat_id, turn_id, origin, status, seq_high_water, locale, started_at
    )
    VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)
    ON CONFLICT(tenant_id, session_id, turn_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      status = CASE WHEN session_turns.status = 'interrupted' THEN 'active' ELSE session_turns.status END,
      ended_at = CASE WHEN session_turns.status = 'interrupted' THEN NULL ELSE session_turns.ended_at END,
      -- Locale is stamped once at turn birth; a re-start keeps the original and
      -- only backfills if the first record had no signal (COALESCE keeps LHS).
      locale = COALESCE(session_turns.locale, excluded.locale),
      updated_at = datetime('now')
  `).run(
    tenantId,
    input.sessionId,
    input.chatId,
    input.turnId,
    input.origin ?? 'user',
    input.locale ?? null,
    input.startedAt,
  );
}

/**
 * Transition a turn envelope's status. Terminal statuses stamp `ended_at`.
 * A missing envelope is a no-op (the turn was never started server-side, e.g.
 * a legacy or non-session path) rather than an error, keeping this safe to call
 * from cleanup handlers.
 */
export function setTurnEnvelopeStatus(input: {
  tenantId?: string;
  sessionId: string;
  turnId: string;
  status: TurnStatus;
  endedAt?: number;
}): void {
  const db = getDb();
  const tenantId = input.tenantId ?? 'default';
  const endedAt = isTerminalTurnStatus(input.status)
    ? input.endedAt ?? Date.now()
    : null;
  db.prepare(`
    UPDATE session_turns
    SET status = ?,
        ended_at = CASE WHEN ? IS NOT NULL THEN ? ELSE ended_at END,
        updated_at = datetime('now')
    WHERE tenant_id = ? AND session_id = ? AND turn_id = ?
  `).run(input.status, endedAt, endedAt, tenantId, input.sessionId, input.turnId);
}

/**
 * Bump the stored per-turn sequence high-water mark. Called by the timeline
 * choke point after it assigns a new sequence, keeping the envelope's view of
 * the sequence consistent with the events. Monotonic: never lowers the mark.
 */
export function recordTurnSeqHighWater(input: {
  tenantId?: string;
  sessionId: string;
  turnId: string;
  seq: number;
}): void {
  if (!Number.isFinite(input.seq) || input.seq <= 0) return;
  const db = getDb();
  const tenantId = input.tenantId ?? 'default';
  db.prepare(`
    UPDATE session_turns
    SET seq_high_water = MAX(seq_high_water, ?),
        updated_at = datetime('now')
    WHERE tenant_id = ? AND session_id = ? AND turn_id = ?
  `).run(input.seq, tenantId, input.sessionId, input.turnId);
}

/** Read one turn envelope, or null when it was never recorded. */
export function getTurnEnvelope(
  sessionId: string,
  turnId: string,
  tenantId = 'default',
): TurnEnvelope | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM session_turns
    WHERE tenant_id = ? AND session_id = ? AND turn_id = ?
  `).get(tenantId, sessionId, turnId) as TurnRow | undefined;
  return row ? rowToEnvelope(row) : null;
}

/**
 * All turn envelopes for a session in start order. Consumed by the timeline
 * restore endpoint so a reconnecting client learns turn grouping and terminal
 * status without re-deriving them from event adjacency.
 */
export function getSessionTurns(sessionId: string, tenantId = 'default'): TurnEnvelope[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM session_turns
    WHERE tenant_id = ? AND session_id = ?
    ORDER BY started_at ASC, turn_id ASC
  `).all(tenantId, sessionId) as TurnRow[];
  return rows.map(rowToEnvelope);
}

/** Latest durable turn that is still open for a session. */
export function getLatestOpenTurnEnvelope(sessionId: string, tenantId = 'default'): TurnEnvelope | null {
  const row = getDb().prepare(`
    SELECT * FROM session_turns
    WHERE tenant_id = ? AND session_id = ?
      AND origin = 'user'
      AND status IN ('active', 'awaiting_approval')
    ORDER BY started_at DESC, turn_id DESC
    LIMIT 1
  `).get(tenantId, sessionId) as TurnRow | undefined;
  return row ? rowToEnvelope(row) : null;
}

/**
 * Terminalize turns left `active` / `awaiting_approval` by a previous process.
 * "Started implies eventually terminal": a crash between start and completion
 * leaves an envelope in flight forever. At startup we flip those to
 * `interrupted` so a reloaded session shows an honest terminal state instead of
 * a zombie in-flight turn. Mirrors `terminalizeStaleRunningArtifacts`.
 *
 * @returns Number of envelopes terminalized.
 */
export function terminalizeStaleActiveTurns(tenantId?: string): number {
  const db = getDb();
  const result = tenantId
    ? db.prepare(`
        UPDATE session_turns
        SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), updated_at = datetime('now')
        WHERE tenant_id = ? AND status IN ('active', 'awaiting_approval')
      `).run(Date.now(), tenantId)
    : db.prepare(`
        UPDATE session_turns
        SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), updated_at = datetime('now')
        WHERE status IN ('active', 'awaiting_approval')
      `).run(Date.now());
  return result.changes;
}
