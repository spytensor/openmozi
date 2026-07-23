import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the streaming debounce logic used in Telegram streaming.
 * We test the core debounce pattern in isolation.
 */

interface DebounceState {
  lastEditTime: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  edits: string[];
}

function createStreamDebouncer(intervalMs: number) {
  const state: DebounceState = {
    lastEditTime: 0,
    pendingTimer: null,
    edits: [],
  };

  return {
    state,
    onChunk(text: string) {
      const now = Date.now();
      if (now - state.lastEditTime >= intervalMs) {
        state.lastEditTime = now;
        state.edits.push(text);
      } else {
        if (state.pendingTimer) clearTimeout(state.pendingTimer);
        state.pendingTimer = setTimeout(() => {
          state.lastEditTime = Date.now();
          state.edits.push(text);
          state.pendingTimer = null;
        }, intervalMs - (now - state.lastEditTime));
      }
    },
    cleanup() {
      if (state.pendingTimer) {
        clearTimeout(state.pendingTimer);
        state.pendingTimer = null;
      }
    },
  };
}

describe('streaming debounce logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends first chunk immediately', () => {
    const debouncer = createStreamDebouncer(500);
    debouncer.onChunk('Hello');
    expect(debouncer.state.edits).toEqual(['Hello']);
  });

  it('debounces rapid subsequent chunks', () => {
    const debouncer = createStreamDebouncer(500);

    debouncer.onChunk('Hello');
    expect(debouncer.state.edits).toEqual(['Hello']);

    // Rapid updates within 500ms should be debounced
    vi.advanceTimersByTime(100);
    debouncer.onChunk('Hello world');
    expect(debouncer.state.edits).toEqual(['Hello']); // Still just first

    vi.advanceTimersByTime(100);
    debouncer.onChunk('Hello world!');
    expect(debouncer.state.edits).toEqual(['Hello']); // Still debounced

    // After interval passes, the last value should fire
    vi.advanceTimersByTime(400);
    expect(debouncer.state.edits).toEqual(['Hello', 'Hello world!']);

    debouncer.cleanup();
  });

  it('sends after interval when enough time passes', () => {
    const debouncer = createStreamDebouncer(500);

    debouncer.onChunk('A');
    expect(debouncer.state.edits).toEqual(['A']);

    // Wait full interval
    vi.advanceTimersByTime(500);
    debouncer.onChunk('AB');
    expect(debouncer.state.edits).toEqual(['A', 'AB']);

    debouncer.cleanup();
  });

  it('cleanup cancels pending timer', () => {
    const debouncer = createStreamDebouncer(500);

    debouncer.onChunk('A');
    vi.advanceTimersByTime(100);
    debouncer.onChunk('AB');
    expect(debouncer.state.pendingTimer).not.toBeNull();

    debouncer.cleanup();
    expect(debouncer.state.pendingTimer).toBeNull();

    // Advancing time should not trigger the edit
    vi.advanceTimersByTime(500);
    expect(debouncer.state.edits).toEqual(['A']);
  });
});
