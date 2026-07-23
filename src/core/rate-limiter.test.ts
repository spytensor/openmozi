import { describe, it, expect } from 'vitest';
import { configure, acquire, release, getState } from './rate-limiter.js';

describe('core/rate-limiter', () => {
  it('acquire resolves immediately when within limits', async () => {
    configure('test-rl-1', { rpm: 100, tpm: 100000, concurrent: 10 });
    await acquire('test-rl-1', 100);
    const state = getState('test-rl-1');
    expect(state!.requestsThisMinute).toBe(1);
    expect(state!.tokensThisMinute).toBe(100);
    expect(state!.concurrent).toBe(1);
    release('test-rl-1');
  });

  it('acquire resolves for unconfigured provider', async () => {
    // No limits configured — should pass through
    await acquire('unconfigured-provider', 999);
    expect(getState('unconfigured-provider')).toBeNull();
  });

  it('concurrent limit blocks when at capacity', async () => {
    configure('test-rl-2', { rpm: 100, tpm: 100000, concurrent: 1 });

    // First acquire succeeds
    await acquire('test-rl-2', 10);
    expect(getState('test-rl-2')!.concurrent).toBe(1);

    // Second acquire should be queued
    let secondResolved = false;
    const secondPromise = acquire('test-rl-2', 10).then(() => {
      secondResolved = true;
    });

    // Wait a tick — should still be blocked
    await new Promise((r) => setTimeout(r, 50));
    expect(secondResolved).toBe(false);
    expect(getState('test-rl-2')!.queueLength).toBe(1);

    // Release first slot
    release('test-rl-2');

    // Now the second should resolve
    await secondPromise;
    expect(secondResolved).toBe(true);
    release('test-rl-2');
  });

  it('rpm limit blocks when at capacity', async () => {
    configure('test-rl-3', { rpm: 2, tpm: 100000, concurrent: 10 });

    await acquire('test-rl-3', 10);
    release('test-rl-3');
    await acquire('test-rl-3', 10);
    release('test-rl-3');

    // Third request should be queued (rpm=2 already used)
    let thirdResolved = false;
    const controller = new AbortController();
    const thirdPromise = acquire('test-rl-3', 10, 1, controller.signal).then(() => {
      thirdResolved = true;
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(thirdResolved).toBe(false);

    // Clean up by not waiting for minute reset (would take 60s)
    // Just verify the queue is populated
    expect(getState('test-rl-3')!.queueLength).toBe(1);
    controller.abort('test cleanup');
    await expect(thirdPromise).rejects.toMatchObject({ name: 'AbortError', message: 'test cleanup' });
    expect(getState('test-rl-3')!.queueLength).toBe(0);
  });

  it('removes a queued permit immediately when its signal aborts', async () => {
    configure('test-rl-abort', { rpm: 100, tpm: 100000, concurrent: 1 });
    await acquire('test-rl-abort', 10);
    const controller = new AbortController();
    const queued = acquire('test-rl-abort', 10, 1, controller.signal);

    expect(getState('test-rl-abort')!.queueLength).toBe(1);
    controller.abort(new Error('gateway deadline exceeded'));

    await expect(queued).rejects.toMatchObject({ name: 'AbortError', message: 'gateway deadline exceeded' });
    expect(getState('test-rl-abort')!.queueLength).toBe(0);
    release('test-rl-abort');
    expect(getState('test-rl-abort')!.concurrent).toBe(0);
  });

  it('priority ordering: lower priority number processed first', async () => {
    configure('test-rl-4', { rpm: 100, tpm: 100000, concurrent: 1 });

    // Fill the concurrent slot
    await acquire('test-rl-4', 10);

    const order: number[] = [];

    // Queue two requests with different priorities
    const lowPrio = acquire('test-rl-4', 10, 5).then(() => order.push(5));
    const highPrio = acquire('test-rl-4', 10, 0).then(() => order.push(0));

    await new Promise((r) => setTimeout(r, 50));

    // Release first slot — high priority should go first
    release('test-rl-4');
    await new Promise((r) => setTimeout(r, 200));
    release('test-rl-4');
    await Promise.all([lowPrio, highPrio]);

    expect(order[0]).toBe(0); // High priority first
    release('test-rl-4');
  });
});
