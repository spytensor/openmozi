/**
 * Turn Envelope persistence + recovery tests (Issue #627).
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  startTurnEnvelope,
  setTurnEnvelopeStatus,
  recordTurnSeqHighWater,
  getTurnEnvelope,
  getLatestOpenTurnEnvelope,
  getSessionTurns,
  terminalizeStaleActiveTurns,
} from './turn-envelopes.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = setupTestDb().tmpDir;
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

describe('memory/turn-envelopes', () => {
  it('records an active envelope and transitions it to a terminal status with an end time', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', origin: 'user', startedAt: 1000 });
    let env = getTurnEnvelope('s1', 'turn_1');
    expect(env).toMatchObject({ turnId: 'turn_1', origin: 'user', status: 'active', startedAt: 1000 });
    expect(env?.endedAt).toBeUndefined();

    setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'turn_1', status: 'completed', endedAt: 2000 });
    env = getTurnEnvelope('s1', 'turn_1');
    expect(env?.status).toBe('completed');
    expect(env?.endedAt).toBe(2000);
  });

  it('keeps the original started_at when the same turn is re-started (idempotent)', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', startedAt: 1000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', startedAt: 5000 });
    expect(getTurnEnvelope('s1', 'turn_1')?.startedAt).toBe(1000);
  });

  it('resurrects an interrupted turn back to active on re-start (durable plan resume)', () => {
    // Runtime restart marks the in-flight bg turn interrupted; the durable plan
    // runner then resumes the SAME turn id at boot. Observed live without this:
    // the envelope sat at `interrupted` while resumed rows kept arriving.
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_bg_1', origin: 'background', startedAt: 1000 });
    setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'turn_bg_1', status: 'interrupted', endedAt: 2000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_bg_1', origin: 'background', startedAt: 3000 });
    const env = getTurnEnvelope('s1', 'turn_bg_1');
    expect(env?.status).toBe('active');
    // ended_at cleared in the DB; the row mapper surfaces NULL as undefined.
    expect(env?.endedAt == null).toBe(true);
    expect(env?.startedAt).toBe(1000);
  });

  it('never resurrects a completed/failed/cancelled turn on re-start', () => {
    for (const [index, status] of (['completed', 'failed', 'cancelled'] as const).entries()) {
      const turnId = `turn_dead_${index}`;
      startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId, startedAt: 1000 });
      setTurnEnvelopeStatus({ sessionId: 's1', turnId, status, endedAt: 2000 });
      startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId, startedAt: 3000 });
      expect(getTurnEnvelope('s1', turnId)?.status).toBe(status);
      expect(getTurnEnvelope('s1', turnId)?.endedAt).toBe(2000);
    }
  });

  it('does not stamp ended_at for a non-terminal transition (awaiting_approval)', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', startedAt: 1000 });
    setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'turn_1', status: 'awaiting_approval' });
    const env = getTurnEnvelope('s1', 'turn_1');
    expect(env?.status).toBe('awaiting_approval');
    expect(env?.endedAt).toBeUndefined();
  });

  it('advances the sequence high-water mark monotonically and never lowers it', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', startedAt: 1000 });
    recordTurnSeqHighWater({ sessionId: 's1', turnId: 'turn_1', seq: 3 });
    recordTurnSeqHighWater({ sessionId: 's1', turnId: 'turn_1', seq: 7 });
    recordTurnSeqHighWater({ sessionId: 's1', turnId: 'turn_1', seq: 2 });
    expect(getTurnEnvelope('s1', 'turn_1')?.seqHighWater).toBe(7);
  });

  it('returns session turns in start order', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_b', startedAt: 2000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_a', startedAt: 1000 });
    expect(getSessionTurns('s1').map((t) => t.turnId)).toEqual(['turn_a', 'turn_b']);
  });

  it('terminalizes stale active/awaiting turns as interrupted on recovery', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'active_turn', startedAt: 1000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'waiting_turn', startedAt: 1100 });
    setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'waiting_turn', status: 'awaiting_approval' });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'done_turn', startedAt: 1200 });
    setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'done_turn', status: 'completed', endedAt: 1300 });

    const count = terminalizeStaleActiveTurns();
    expect(count).toBe(2);
    expect(getTurnEnvelope('s1', 'active_turn')?.status).toBe('interrupted');
    expect(getTurnEnvelope('s1', 'waiting_turn')?.status).toBe('interrupted');
    // A genuinely completed turn is untouched.
    expect(getTurnEnvelope('s1', 'done_turn')?.status).toBe('completed');
    expect(getTurnEnvelope('s1', 'done_turn')?.endedAt).toBe(1300);
  });

  it('returns the latest durable open turn for reconnect and ignores terminal turns', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'older', startedAt: 1000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'background', origin: 'background', startedAt: 3000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'newer', startedAt: 2000 });
    // Background work never masquerades as a cancellable foreground turn.
    expect(getLatestOpenTurnEnvelope('s1')?.turnId).toBe('newer');
    setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'newer', status: 'completed' });
    expect(getLatestOpenTurnEnvelope('s1')?.turnId).toBe('older');
  });

  it('is a no-op when transitioning a turn that was never started', () => {
    expect(() => setTurnEnvelopeStatus({ sessionId: 's1', turnId: 'ghost', status: 'failed' })).not.toThrow();
    expect(getTurnEnvelope('s1', 'ghost')).toBeNull();
  });

  // Issue #628: the authoritative presentation locale is carried on the envelope.
  it('persists and reads back the carried locale', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_zh', origin: 'user', locale: 'zh-CN', startedAt: 1000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_en', origin: 'user', locale: 'en', startedAt: 1100 });
    expect(getTurnEnvelope('s1', 'turn_zh')?.locale).toBe('zh-CN');
    expect(getTurnEnvelope('s1', 'turn_en')?.locale).toBe('en');
    expect(getSessionTurns('s1').map((t) => [t.turnId, t.locale])).toEqual([
      ['turn_zh', 'zh-CN'],
      ['turn_en', 'en'],
    ]);
  });

  it('leaves locale undefined when no reliable signal was carried', () => {
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', origin: 'user', startedAt: 1000 });
    expect(getTurnEnvelope('s1', 'turn_1')?.locale).toBeUndefined();
  });

  it('stamps the locale once at birth and does not overwrite it on re-start', () => {
    // A re-started turn keeps its first locale; COALESCE only backfills a
    // previously-absent one (so a signalless start can still be enriched later).
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', locale: 'zh-CN', startedAt: 1000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_1', locale: 'en', startedAt: 2000 });
    expect(getTurnEnvelope('s1', 'turn_1')?.locale).toBe('zh-CN');

    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_2', startedAt: 1000 });
    startTurnEnvelope({ sessionId: 's1', chatId: 'c1', turnId: 'turn_2', locale: 'en', startedAt: 2000 });
    expect(getTurnEnvelope('s1', 'turn_2')?.locale).toBe('en');
  });
});
