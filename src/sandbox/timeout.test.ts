/**
 * Tests for hard timeout enforcement (#243)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  withTimeout,
  TimeoutError,
  getDefaultTimeout,
  DEFAULT_TIMEOUTS,
  withShellTimeout,
  withNetworkTimeout,
} from './timeout.js';

describe('DEFAULT_TIMEOUTS', () => {
  it('has expected values', () => {
    expect(DEFAULT_TIMEOUTS.shell).toBe(30_000);
    expect(DEFAULT_TIMEOUTS.network).toBe(60_000);
    expect(DEFAULT_TIMEOUTS.long_running).toBe(300_000);
  });
});

describe('getDefaultTimeout()', () => {
  it('returns timeout for known tool type', () => {
    expect(getDefaultTimeout('shell')).toBe(30_000);
    expect(getDefaultTimeout('network')).toBe(60_000);
  });

  it('returns default for unknown type', () => {
    expect(getDefaultTimeout('unknown_tool')).toBe(30_000);
  });
});

describe('withTimeout()', () => {
  it('resolves when fn completes before timeout', async () => {
    const result = await withTimeout(
      () => Promise.resolve(42),
      1000,
      'test-fast',
    );
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when fn exceeds timeout', async () => {
    vi.useFakeTimers();
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 5000));
    const timeoutPromise = withTimeout(() => slow, 100, 'test-slow');
    vi.advanceTimersByTime(101);
    await expect(timeoutPromise).rejects.toThrow(TimeoutError);
    vi.useRealTimers();
  });

  it('TimeoutError has correct label and timeoutMs', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {/* never resolves */});
    const p = withTimeout(() => never, 50, 'my-op');
    vi.advanceTimersByTime(51);
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).label).toBe('my-op');
      expect((err as TimeoutError).timeoutMs).toBe(50);
    }
    vi.useRealTimers();
  });

  it('propagates fn errors without wrapping in TimeoutError', async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error('boom')), 1000, 'test-err'),
    ).rejects.toThrow('boom');
  });
});

describe('withShellTimeout()', () => {
  it('uses shell default timeout', async () => {
    const result = await withShellTimeout(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('accepts override timeout', async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('x'), 999));
    const p = withShellTimeout(() => slow, 'shell-op', 50);
    vi.advanceTimersByTime(51);
    await expect(p).rejects.toThrow(TimeoutError);
    vi.useRealTimers();
  });
});

describe('withNetworkTimeout()', () => {
  it('uses network default timeout', async () => {
    const result = await withNetworkTimeout(() => Promise.resolve('pong'));
    expect(result).toBe('pong');
  });
});
