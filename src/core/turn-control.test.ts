import { describe, expect, it } from 'vitest';
import { createTurnControl } from './turn-control.js';

describe('core/turn-control', () => {
  it('follows valid lifecycle transitions', () => {
    const turn = createTurnControl('chat-1', 'user-1');
    expect(turn.state()).toBe('QUEUED');

    turn.transition('PLANNING', 'start');
    turn.transition('EXECUTING', 'run');
    turn.transition('RESPONDING', 'render');
    turn.transition('DONE', 'complete');

    expect(turn.state()).toBe('DONE');
    expect(turn.snapshot().detail).toBe('complete');
  });

  it('allows recovery path and waiting-input path', () => {
    const turn = createTurnControl('chat-2', 'user-2');
    turn.transition('PLANNING');
    turn.transition('EXECUTING');
    turn.transition('RECOVERING');
    turn.transition('WAITING_INPUT');
    turn.transition('RESPONDING');
    turn.transition('DONE');
    expect(turn.state()).toBe('DONE');
  });

  it('rejects invalid transitions', () => {
    const turn = createTurnControl('chat-3', 'user-3');
    expect(() => turn.transition('DONE')).toThrow('Invalid turn-state transition');
  });

  it('supports cancellation as terminal state', () => {
    const turn = createTurnControl('chat-4', 'user-4');
    turn.transition('PLANNING');
    turn.transition('EXECUTING');
    turn.transition('CANCELLED', 'user requested');
    expect(turn.state()).toBe('CANCELLED');
    expect(turn.snapshot().detail).toBe('user requested');
  });
});
