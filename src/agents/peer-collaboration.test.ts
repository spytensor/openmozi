import { describe, it, expect } from 'vitest';
import { getLiveCapabilities, broadcastToProcesses } from './process-manager.js';

describe('agents/peer-collaboration', () => {
  it('getLiveCapabilities returns an empty map initially', () => {
    const caps = getLiveCapabilities();
    expect(caps).toBeDefined();
    expect(caps.size).toBe(0);
  });

  it('broadcastToProcesses does not throw when no processes exist', () => {
    expect(() => broadcastToProcesses('test_notification', { data: 'hello' })).not.toThrow();
  });
});
