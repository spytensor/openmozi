import { describe, it, expect } from 'vitest';
import { createMCPBridge } from './bridge.js';

describe('MCPBridge', () => {
  it('returns empty tools when no servers configured', async () => {
    const bridge = createMCPBridge({ servers: {} });
    await bridge.start();
    expect(bridge.getTools()).toEqual({});
    expect(bridge.listServers()).toEqual([]);
    await bridge.shutdown();
  });

  it('lists servers with correct initial state', async () => {
    // With no actual server process to connect to, we verify the bridge
    // handles graceful failure and still reports server status
    const bridge = createMCPBridge({
      servers: {
        test_server: {
          command: 'node',
          args: ['-e', 'process.exit(1)'],
          permission_level: 'L0_READ_ONLY',
          enabled: true,
          restart_on_failure: false,
          max_restarts: 0,
        },
      },
    });

    await bridge.start();
    const servers = bridge.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe('test_server');
    expect(servers[0].permissionLevel).toBe('L0_READ_ONLY');
    // Server may or may not connect depending on environment
    await bridge.shutdown();
  });

  it('skips disabled servers', async () => {
    const bridge = createMCPBridge({
      servers: {
        disabled_server: {
          command: 'npx',
          args: ['nonexistent-server'],
          enabled: false,
          permission_level: 'L0_READ_ONLY',
          restart_on_failure: false,
          max_restarts: 0,
        },
      },
    });

    await bridge.start();
    expect(bridge.listServers()).toEqual([]);
    expect(bridge.getTools()).toEqual({});
    await bridge.shutdown();
  });

  it('shutdown is idempotent', async () => {
    const bridge = createMCPBridge({ servers: {} });
    await bridge.start();
    await bridge.shutdown();
    await bridge.shutdown(); // Should not throw
    expect(bridge.getTools()).toEqual({});
  });
});
