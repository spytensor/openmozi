import { describe, expect, it } from 'vitest';
import { prepareRuntimeAfterStatus } from './navigation.js';

describe('prepareRuntimeAfterStatus', () => {
  it('finishes the status navigation before runtime readiness can navigate the workspace', async () => {
    const order: string[] = [];
    const state = await prepareRuntimeAfterStatus(
      async () => {
        order.push('status:start');
        await Promise.resolve();
        order.push('status:end');
      },
      async () => {
        order.push('runtime');
        return 'ready';
      },
    );

    expect(state).toBe('ready');
    expect(order).toEqual(['status:start', 'status:end', 'runtime']);
  });
});
