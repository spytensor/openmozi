import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleApprovalDecision, waitForApprovalDecision } from './approval-wait.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('security/approval-wait', () => {
  it('settle resolves the waiter and cleans up', async () => {
    const waiting = waitForApprovalDecision('approval-settle', { timeoutMs: 10_000 });

    expect(settleApprovalDecision('approval-settle', 'approved')).toBe(true);
    await expect(waiting).resolves.toBe('approved');
    expect(settleApprovalDecision('approval-settle', 'rejected')).toBe(false);
  });

  it('timeout resolves timeout and cleans up', async () => {
    vi.useFakeTimers();
    const waiting = waitForApprovalDecision('approval-timeout', { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toBe('timeout');
    expect(settleApprovalDecision('approval-timeout', 'approved')).toBe(false);
  });

  it('abort resolves timeout and cleans up', async () => {
    const controller = new AbortController();
    const waiting = waitForApprovalDecision('approval-abort', {
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    controller.abort(new Error('cancelled'));

    await expect(waiting).resolves.toBe('timeout');
    expect(settleApprovalDecision('approval-abort', 'approved')).toBe(false);
  });
});
