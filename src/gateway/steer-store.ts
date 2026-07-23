/** Turn-generation-scoped storage for `/steer` user nudges. */
import pino from 'pino';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:gateway:steer-store' });

export const STEER_MAX_LENGTH = 500;
export const STEER_MAX_PER_TURN = 3;
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

interface SteerScope {
  tenantId: string;
  chatId: string;
  turnId: string;
}

interface Entry {
  text: string;
  enqueuedAt: number;
}

interface PendingTurn {
  scope: SteerScope;
  entries: Entry[];
}

const pendingByTurn = new Map<string, PendingTurn>();
const lastBrainAtByTurn = new Map<string, number>();

export type EnqueueReason = 'empty' | 'not_string' | 'too_long' | 'rate_limited';

export interface EnqueueResult {
  accepted: boolean;
  reason?: EnqueueReason;
  brainIdle?: boolean;
}

function scopeKey(scope: SteerScope): string {
  return JSON.stringify([scope.tenantId, scope.chatId, scope.turnId]);
}

function audit(event: string, scope: SteerScope, detail: Record<string, unknown>): void {
  try {
    logEvent(event, 'steer', scope.turnId, { chatId: scope.chatId, ...detail }, scope.tenantId);
  } catch (err) {
    logger.warn({ err: (err as Error).message, event, ...scope }, 'steer audit log failed');
  }
}

export function enqueueSteer(
  tenantId: string,
  chatId: string,
  turnId: string,
  text: unknown,
): EnqueueResult {
  const scope = { tenantId, chatId, turnId };
  if (typeof text !== 'string') {
    audit('security.steer_rejected', scope, { reason: 'not_string' });
    return { accepted: false, reason: 'not_string' };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    audit('security.steer_rejected', scope, { reason: 'empty' });
    return { accepted: false, reason: 'empty' };
  }
  if (trimmed.length > STEER_MAX_LENGTH) {
    audit('security.steer_rate_limited', scope, { reason: 'too_long', len: trimmed.length });
    return { accepted: false, reason: 'too_long' };
  }

  const key = scopeKey(scope);
  const pending = pendingByTurn.get(key) ?? { scope, entries: [] };
  if (pending.entries.length >= STEER_MAX_PER_TURN) {
    audit('security.steer_rate_limited', scope, { reason: 'count', queued: pending.entries.length });
    return { accepted: false, reason: 'rate_limited' };
  }
  pending.entries.push({ text: trimmed, enqueuedAt: Date.now() });
  pendingByTurn.set(key, pending);

  const lastBrain = lastBrainAtByTurn.get(key);
  return {
    accepted: true,
    brainIdle: lastBrain === undefined || Date.now() - lastBrain > PROMPT_CACHE_TTL_MS,
  };
}

export function drainSteer(tenantId: string, chatId: string, turnId: string): string[] {
  const key = scopeKey({ tenantId, chatId, turnId });
  const pending = pendingByTurn.get(key);
  if (!pending) return [];
  pendingByTurn.delete(key);
  return pending.entries.map((entry) => entry.text);
}

export function markBrainActivity(tenantId: string, chatId: string, turnId: string): void {
  lastBrainAtByTurn.set(scopeKey({ tenantId, chatId, turnId }), Date.now());
}

/**
 * Close one exact turn generation. Any steer that arrived after its final
 * Brain boundary is truthfully discarded and audited, never carried forward.
 */
export function expireSteerTurn(tenantId: string, chatId: string, turnId: string): number {
  const scope = { tenantId, chatId, turnId };
  const key = scopeKey(scope);
  const pending = pendingByTurn.get(key);
  pendingByTurn.delete(key);
  lastBrainAtByTurn.delete(key);
  const discarded = pending?.entries.length ?? 0;
  if (discarded > 0) {
    audit('security.steer_expired', scope, { discarded, reason: 'turn_finished_before_next_boundary' });
    logger.info({ ...scope, discarded }, 'Undelivered steers expired with turn');
  }
  return discarded;
}

export function peekSteerCount(tenantId: string, chatId: string, turnId: string): number {
  return pendingByTurn.get(scopeKey({ tenantId, chatId, turnId }))?.entries.length ?? 0;
}

export function __resetSteerStoreForTests(): void {
  pendingByTurn.clear();
  lastBrainAtByTurn.clear();
}

export function __setLastBrainAtForTests(tenantId: string, chatId: string, turnId: string, ts: number): void {
  lastBrainAtByTurn.set(scopeKey({ tenantId, chatId, turnId }), ts);
}

export function __peekMapSizesForTests(): { pending: number; lastBrain: number } {
  return { pending: pendingByTurn.size, lastBrain: lastBrainAtByTurn.size };
}
