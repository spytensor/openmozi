import { describe, it, expect } from 'vitest';
import { createMCPBridge, buildServerEnv } from './bridge.js';

describe('buildServerEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'sk-secret',
    MOZI_MASTER_KEY: 'master-secret',
    JWT_SECRET: 'jwt-secret',
  } as NodeJS.ProcessEnv;

  it('does not leak MOZI credentials into a third-party server process', () => {
    const env = buildServerEnv(undefined, parent);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MOZI_MASTER_KEY).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('passes through the minimum a process needs to run', () => {
    const env = buildServerEnv(undefined, parent);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
  });

  it('passes declared variables and lets them win', () => {
    const env = buildServerEnv({ GITHUB_TOKEN: 'ghp_x', PATH: '/custom/bin' }, parent);
    expect(env.GITHUB_TOKEN).toBe('ghp_x');
    expect(env.PATH).toBe('/custom/bin');
  });
});

describe('MCPBridge', () => {
  it('returns empty tools when no servers configured', async () => {
    const bridge = createMCPBridge({ servers: {} });
    await bridge.start();
    expect(bridge.listTools()).toEqual([]);
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
    expect(bridge.listTools()).toEqual([]);
    await bridge.shutdown();
  });

  it('shutdown is idempotent', async () => {
    const bridge = createMCPBridge({ servers: {} });
    await bridge.start();
    await bridge.shutdown();
    await bridge.shutdown(); // Should not throw
    expect(bridge.listTools()).toEqual([]);
  });
});
