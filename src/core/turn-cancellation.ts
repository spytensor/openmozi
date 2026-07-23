import pino from 'pino';

const logger = pino({ name: 'mozi:turn-cancellation' });

function turnKey(turnId: string, tenantId: string): string {
  return `${tenantId}:${turnId}`;
}

function chatKey(chatId: string, tenantId: string): string {
  return `${tenantId}:${chatId}`;
}

/**
 * Canonical session-scoped chat key (`userId:sessionId`). The stream / artifact /
 * final persist paths resolve a turn through this key (see resolveActiveTurnId in
 * channels/websocket.ts). For an established session it equals the incoming
 * chatId, but a brand-new Web chat arrives scoped to the transient client id
 * (`userId:clientId`) because no sessionId existed yet — so the turn must ALSO be
 * registered under the session key or its streamed rows persist with a null turn
 * id (Issue #627).
 */
function sessionChatKey(userId: string, sessionId: string, tenantId: string): string {
  return chatKey(`${userId}:${sessionId}`, tenantId);
}

export class TurnCancelledError extends Error {
  public readonly turnId: string;

  constructor(turnId: string, reason = 'Request cancelled') {
    super(reason);
    this.name = 'TurnCancelledError';
    this.turnId = turnId;
  }
}

interface ActiveTurnCancellation {
  turnId: string;
  tenantId: string;
  chatId: string;
  userId: string;
  sessionId?: string;
  controller: AbortController;
  startedAt: number;
}

const activeTurns = new Map<string, ActiveTurnCancellation>();
const activeTurnByChat = new Map<string, string>();

export interface RegisterRunningTurnInput {
  turnId: string;
  tenantId: string;
  chatId: string;
  userId: string;
  sessionId?: string;
}

export interface RegisteredRunningTurn {
  signal: AbortSignal;
  finish: () => void;
}

export function registerRunningTurn(input: RegisterRunningTurnInput): RegisteredRunningTurn {
  const controller = new AbortController();
  const key = turnKey(input.turnId, input.tenantId);
  const byChatKey = chatKey(input.chatId, input.tenantId);

  activeTurns.set(key, {
    ...input,
    controller,
    startedAt: Date.now(),
  });
  activeTurnByChat.set(byChatKey, key);
  // Additionally index by the canonical `userId:sessionId` key so the persist
  // paths resolve this turn even when the incoming chatId is client-scoped (a
  // brand-new Web chat). No-op when the incoming chatId already is that key.
  if (input.sessionId) {
    const sessionKey = sessionChatKey(input.userId, input.sessionId, input.tenantId);
    if (sessionKey !== byChatKey) activeTurnByChat.set(sessionKey, key);
  }

  logger.debug({
    turnId: input.turnId,
    chatId: input.chatId,
    tenantId: input.tenantId,
  }, 'Running turn registered');

  return {
    signal: controller.signal,
    finish: () => finishRunningTurn(input.turnId, input.tenantId),
  };
}

export function finishRunningTurn(turnId: string, tenantId = 'default'): void {
  const key = turnKey(turnId, tenantId);
  const active = activeTurns.get(key);
  activeTurns.delete(key);
  if (active && activeTurnByChat.get(chatKey(active.chatId, active.tenantId)) === key) {
    activeTurnByChat.delete(chatKey(active.chatId, active.tenantId));
  }
  // Mirror the session-scoped alias cleanup, guarded so a newer turn that has
  // since claimed the same session key is not evicted.
  if (active?.sessionId) {
    const sessionKey = sessionChatKey(active.userId, active.sessionId, active.tenantId);
    if (activeTurnByChat.get(sessionKey) === key) {
      activeTurnByChat.delete(sessionKey);
    }
  }
}

export interface CancelTurnOptions {
  tenantId?: string;
  requestedBy?: string;
  reason?: string;
  chatId?: string;
  turnId?: string;
}

export interface CancelTurnResult {
  ok: boolean;
  status: 'cancelled' | 'already_cancelled' | 'not_found' | 'failed';
  message: string;
  tenantId: string;
  chatId?: string;
  turnId?: string;
}

function resolveActiveTurn(options: Required<Pick<CancelTurnOptions, 'tenantId'>> & CancelTurnOptions): ActiveTurnCancellation | undefined {
  const explicitTurnId = options.turnId?.trim();
  if (explicitTurnId) {
    return activeTurns.get(turnKey(explicitTurnId, options.tenantId));
  }

  const chatId = options.chatId?.trim();
  if (!chatId) return undefined;
  const key = activeTurnByChat.get(chatKey(chatId, options.tenantId));
  return key ? activeTurns.get(key) : undefined;
}

export function requestTurnCancellation(options: CancelTurnOptions): CancelTurnResult {
  const tenantId = options.tenantId ?? 'default';
  const reason = options.reason ?? 'User requested cancellation';
  const active = resolveActiveTurn({ ...options, tenantId });

  if (!active) {
    return {
      ok: false,
      status: 'not_found',
      message: 'No active request is currently running.',
      tenantId,
      chatId: options.chatId,
      turnId: options.turnId,
    };
  }

  if (active.controller.signal.aborted) {
    return {
      ok: true,
      status: 'already_cancelled',
      message: 'Request cancellation is already in progress.',
      tenantId,
      chatId: active.chatId,
      turnId: active.turnId,
    };
  }

  active.controller.abort(new TurnCancelledError(active.turnId, reason));
  logger.info({
    turnId: active.turnId,
    chatId: active.chatId,
    tenantId,
    requestedBy: options.requestedBy ?? 'system',
  }, 'Running turn cancellation requested');

  return {
    ok: true,
    status: 'cancelled',
    message: 'Request cancellation requested.',
    tenantId,
    chatId: active.chatId,
    turnId: active.turnId,
  };
}

export interface ActiveTurnSnapshot {
  turnId: string;
  /** Canonical execution scope used by Brain steering and turn-end expiry. */
  chatId: string;
  sessionId?: string;
  startedAt: number;
}

/**
 * Authoritative "is anything running for this chat right now" query. The
 * registry is in-memory, so after a process restart it is empty — which is
 * exactly the truth the UI needs to stop showing zombie in-flight steps.
 */
export function getActiveTurnForChat(chatId: string, tenantId = 'default'): ActiveTurnSnapshot | null {
  const key = activeTurnByChat.get(chatKey(chatId, tenantId));
  const active = key ? activeTurns.get(key) : undefined;
  if (!active || active.controller.signal.aborted) return null;
  return {
    turnId: active.turnId,
    chatId: active.chatId,
    sessionId: active.sessionId,
    startedAt: active.startedAt,
  };
}

/** Number of turns currently registered as running (for shutdown drain waits). */
export function getRunningTurnCount(): number {
  return activeTurns.size;
}

/**
 * Abort every running turn — the graceful-shutdown drain. Each turn's real
 * abort signal fires with the given reason, so the brain loop stops streaming,
 * handlers publish truthful CANCELLED markers to clients, and DB writes settle
 * before the process exits. Returns how many turns were signalled.
 */
export function cancelAllRunningTurns(reason: string): number {
  let cancelled = 0;
  for (const active of activeTurns.values()) {
    if (active.controller.signal.aborted) continue;
    active.controller.abort(new TurnCancelledError(active.turnId, reason));
    cancelled += 1;
    logger.info({ turnId: active.turnId, chatId: active.chatId, reason }, 'Running turn aborted for shutdown drain');
  }
  return cancelled;
}

export function isTurnCancellationError(err: unknown): err is TurnCancelledError {
  return err instanceof TurnCancelledError || (err instanceof Error && err.name === 'TurnCancelledError');
}

export function clearRunningTurnsForTests(): void {
  activeTurns.clear();
  activeTurnByChat.clear();
}
