/**
 * Turn Envelope — server-authoritative vocabulary for one user turn.
 * -----------------------------------------------------------------
 * Issue #627 (Phase 0). This module is the single source of truth for the
 * Turn Envelope lifecycle: the origin of a turn, its status transitions, and
 * the versioned timeline capability advertised to compatible clients.
 *
 * It is deliberately pure data + guards — no I/O. Persistence lives in
 * `src/memory/turn-envelopes.ts`; the durable per-turn sequence is assigned at
 * the timeline choke point (`saveTimelineItem`).
 */

/** Where a turn originated. Interactive turns are `user`; the rest are runtime-driven. */
export type TurnOrigin = 'user' | 'system' | 'proactive' | 'background' | 'scheduler';

/**
 * Lifecycle status of a turn envelope.
 * - `active`: work is in flight.
 * - `awaiting_approval`: blocked waiting for a user approval decision.
 * - terminal: `completed` | `failed` | `cancelled` | `interrupted`.
 *
 * `interrupted` is distinct from `cancelled`: cancellation is user-requested,
 * interruption is a process death / restart that left the turn unfinished.
 */
export type TurnStatus =
  | 'active'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Server-authoritative envelope for one turn. */
export interface TurnEnvelope {
  turnId: string;
  tenantId: string;
  sessionId: string;
  chatId: string;
  origin: TurnOrigin;
  status: TurnStatus;
  /** High-water mark of the per-turn monotonic sequence assigned so far. */
  seqHighWater: number;
  /**
   * Presentation locale for this turn, inferred once from the turn's text and
   * carried on the authoritative path (Issue #628). Consumers read this instead
   * of re-scanning message characters. `undefined` for legacy turns recorded
   * before this field existed and for turns with no reliable language signal.
   */
  locale?: string;
  startedAt: number;
  endedAt?: number;
}

export const TURN_ORIGINS: readonly TurnOrigin[] = [
  'user',
  'system',
  'proactive',
  'background',
  'scheduler',
];

export const TURN_STATUSES: readonly TurnStatus[] = [
  'active',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

/** Statuses from which no further transition is expected. */
export const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export function isTurnOrigin(value: unknown): value is TurnOrigin {
  return typeof value === 'string' && (TURN_ORIGINS as readonly string[]).includes(value);
}

export function isTurnStatus(value: unknown): value is TurnStatus {
  return typeof value === 'string' && (TURN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalTurnStatus(value: unknown): value is TurnStatus {
  return typeof value === 'string' && (TERMINAL_TURN_STATUSES as readonly string[]).includes(value);
}

/**
 * Versioned capability advertised to clients that understand the
 * server-authoritative timeline contract (turn identity + per-turn sequence).
 * Clients declare it in their `hello`; the server echoes it in `welcome`.
 */
export const TIMELINE_CAPABILITY = 'timeline_v1';

/**
 * Typed plan presentation contract (Issue #735): the server persists and
 * broadcasts `plan_started` timeline events carrying the plan's goal, phases,
 * and locale as data instead of formatted assistant prose.
 */
export const PLAN_PRESENTATION_CAPABILITY = 'plan_v1';

/**
 * Capabilities the server implements today. Advertised in the WebSocket
 * `welcome` frame so a client can detect the contract without probing.
 */
export const SERVER_TIMELINE_CAPABILITIES: readonly string[] = [TIMELINE_CAPABILITY, PLAN_PRESENTATION_CAPABILITY];
