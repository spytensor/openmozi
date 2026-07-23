import { beforeEach, describe, expect, it } from 'vitest';
import {
  __peekMapSizesForTests,
  __resetSteerStoreForTests,
  __setLastBrainAtForTests,
  drainSteer,
  enqueueSteer,
  expireSteerTurn,
  markBrainActivity,
  peekSteerCount,
  PROMPT_CACHE_TTL_MS,
  STEER_MAX_LENGTH,
  STEER_MAX_PER_TURN,
} from './steer-store.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const scope = ['tenant-a', 'chat-1', 'turn-1'] as const;

describe('gateway/steer-store', () => {
  let dbDir: string;

  beforeEach(() => {
    __resetSteerStoreForTests();
    ({ tmpDir: dbDir } = setupTestDb());
    return () => teardownTestDb(dbDir);
  });

  it('validates, counts, drains exactly once, and rate limits one turn generation', () => {
    expect(enqueueSteer(...scope, 42).reason).toBe('not_string');
    expect(enqueueSteer(...scope, ' ').reason).toBe('empty');
    expect(enqueueSteer(...scope, 'x'.repeat(STEER_MAX_LENGTH + 1)).reason).toBe('too_long');
    for (let i = 0; i < STEER_MAX_PER_TURN; i += 1) {
      expect(enqueueSteer(...scope, `steer-${i}`).accepted).toBe(true);
    }
    expect(enqueueSteer(...scope, 'overflow').reason).toBe('rate_limited');
    expect(peekSteerCount(...scope)).toBe(STEER_MAX_PER_TURN);
    expect(drainSteer(...scope)).toEqual(['steer-0', 'steer-1', 'steer-2']);
    expect(drainSteer(...scope)).toEqual([]);
  });

  it('isolates the same chat id across tenant and turn generations', () => {
    enqueueSteer('tenant-a', 'shared-chat', 'turn-a1', 'alpha-current');
    enqueueSteer('tenant-a', 'shared-chat', 'turn-a2', 'alpha-next');
    enqueueSteer('tenant-b', 'shared-chat', 'turn-b1', 'bravo');

    expect(drainSteer('tenant-b', 'shared-chat', 'turn-b1')).toEqual(['bravo']);
    expect(drainSteer('tenant-a', 'shared-chat', 'turn-a2')).toEqual(['alpha-next']);
    expect(drainSteer('tenant-a', 'shared-chat', 'turn-a1')).toEqual(['alpha-current']);
  });

  it('expires input that missed the last boundary and never exposes it to the next turn', () => {
    enqueueSteer('tenant-a', 'chat-1', 'turn-old', 'late nudge');
    expect(expireSteerTurn('tenant-a', 'chat-1', 'turn-old')).toBe(1);
    expect(drainSteer('tenant-a', 'chat-1', 'turn-old')).toEqual([]);
    expect(drainSteer('tenant-a', 'chat-1', 'turn-new')).toEqual([]);
    expect(__peekMapSizesForTests()).toEqual({ pending: 0, lastBrain: 0 });
  });

  it('reports activity only for the exact current generation and clears it on expiry', () => {
    markBrainActivity(...scope);
    expect(enqueueSteer(...scope, 'hot').brainIdle).toBe(false);
    __setLastBrainAtForTests(...scope, Date.now() - PROMPT_CACHE_TTL_MS - 1);
    expect(enqueueSteer(...scope, 'stale').brainIdle).toBe(true);
    expireSteerTurn(...scope);
    expect(__peekMapSizesForTests()).toEqual({ pending: 0, lastBrain: 0 });
  });
});
