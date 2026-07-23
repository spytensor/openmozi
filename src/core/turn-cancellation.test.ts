import { afterEach, describe, expect, it } from 'vitest';
import {
  TurnCancelledError,
  cancelAllRunningTurns,
  clearRunningTurnsForTests,
  finishRunningTurn,
  getActiveTurnForChat,
  getRunningTurnCount,
  registerRunningTurn,
  requestTurnCancellation,
} from './turn-cancellation.js';

afterEach(() => {
  clearRunningTurnsForTests();
});

describe('turn cancellation', () => {
  it('cancels the active turn for a chat', () => {
    const running = registerRunningTurn({
      turnId: 'turn-1',
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      userId: 'user-1',
      sessionId: 'session-1',
    });

    const result = requestTurnCancellation({
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      requestedBy: 'user-1',
      reason: 'Stop',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'cancelled',
      turnId: 'turn-1',
      chatId: 'chat-1',
    });
    expect(running.signal.aborted).toBe(true);
    expect(running.signal.reason).toBeInstanceOf(TurnCancelledError);
    expect((running.signal.reason as TurnCancelledError).message).toBe('Stop');
  });

  it('reports the active turn for a chat and null once it finishes', () => {
    expect(getActiveTurnForChat('chat-1', 'tenant-1')).toBeNull();

    registerRunningTurn({
      turnId: 'turn-live',
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      userId: 'user-1',
      sessionId: 'session-1',
    });

    expect(getActiveTurnForChat('chat-1', 'tenant-1')).toMatchObject({
      turnId: 'turn-live',
      chatId: 'chat-1',
      sessionId: 'session-1',
    });

    expect(getActiveTurnForChat('user-1:session-1', 'tenant-1')).toMatchObject({
      turnId: 'turn-live',
      chatId: 'chat-1',
      sessionId: 'session-1',
    });

    finishRunningTurn('turn-live', 'tenant-1');
    expect(getActiveTurnForChat('chat-1', 'tenant-1')).toBeNull();
  });

  it('drains every running turn with the given reason', () => {
    const first = registerRunningTurn({ turnId: 'turn-a', tenantId: 't1', chatId: 'chat-a', userId: 'u1' });
    const second = registerRunningTurn({ turnId: 'turn-b', tenantId: 't1', chatId: 'chat-b', userId: 'u2' });
    expect(getRunningTurnCount()).toBe(2);

    const cancelled = cancelAllRunningTurns('Runtime restarting');

    expect(cancelled).toBe(2);
    for (const running of [first, second]) {
      expect(running.signal.aborted).toBe(true);
      expect((running.signal.reason as TurnCancelledError).message).toBe('Runtime restarting');
    }

    // Idempotent: already-aborted turns are not signalled twice.
    expect(cancelAllRunningTurns('Runtime restarting')).toBe(0);

    finishRunningTurn('turn-a', 't1');
    finishRunningTurn('turn-b', 't1');
    expect(getRunningTurnCount()).toBe(0);
  });

  it('reports null for a turn whose cancellation is already in flight', () => {
    registerRunningTurn({
      turnId: 'turn-aborting',
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      userId: 'user-1',
    });
    requestTurnCancellation({ tenantId: 'tenant-1', chatId: 'chat-1' });

    // Aborted-but-not-yet-finished turns are no longer "running" for the UI.
    expect(getActiveTurnForChat('chat-1', 'tenant-1')).toBeNull();
  });

  it('cancels an explicit turn id', () => {
    const running = registerRunningTurn({
      turnId: 'turn-explicit',
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      userId: 'user-1',
    });

    const result = requestTurnCancellation({
      tenantId: 'tenant-1',
      turnId: 'turn-explicit',
      requestedBy: 'user-1',
    });

    expect(result.status).toBe('cancelled');
    expect(running.signal.aborted).toBe(true);
  });

  it('keeps the latest chat index when an older turn finishes later', () => {
    registerRunningTurn({
      turnId: 'turn-old',
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      userId: 'user-1',
    });
    const latest = registerRunningTurn({
      turnId: 'turn-new',
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      userId: 'user-1',
    });

    finishRunningTurn('turn-old', 'tenant-1');
    const result = requestTurnCancellation({
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      requestedBy: 'user-1',
    });

    expect(result).toMatchObject({ ok: true, status: 'cancelled', turnId: 'turn-new' });
    expect(latest.signal.aborted).toBe(true);
  });

  it('reports not_found when no turn is running', () => {
    const result = requestTurnCancellation({
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      requestedBy: 'user-1',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'not_found',
      message: 'No active request is currently running.',
    });
  });
});
