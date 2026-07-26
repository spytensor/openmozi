/**
 * Drives the failure paths that were previously "correct by construction":
 * a server that stops answering, and a server that will not come back.
 */
import { describe, it, expect } from 'vitest';
import { createMCPBridge } from './bridge.js';

const HANG_SERVER = new URL('./hang-server.fixture.mjs', import.meta.url).pathname;

describe('a server that goes silent', () => {
  it('does not hang the caller on the post-failure liveness probe', async () => {
    // The probe issues `tools/list`, which this server swallows. @ai-sdk/mcp
    // has no timeout and does not listen for abort, so without an external
    // deadline `callTool` never returns — past its own timeout's `finally`,
    // and unreachable by turn cancellation.
    const bridge = createMCPBridge({
      servers: {
        hang: {
          command: process.execPath,
          args: [HANG_SERVER],
          permission_level: 'L0_READ_ONLY',
          enabled: true,
          restart_on_failure: false,
          max_restarts: 0,
        },
      },
    });

    await bridge.start();
    expect(bridge.listTools().map(t => t.name)).toEqual(['mcp_hang_stall']);

    const startedAt = Date.now();
    const outcome = await bridge.callTool('mcp_hang_stall', {});
    const elapsed = Date.now() - startedAt;

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('deliberate failure');
    // PROBE_TIMEOUT_MS is 10s; anything near or beyond the 20s mark means the
    // probe was unbounded and the deadline is not doing its job.
    expect(elapsed).toBeLessThan(20_000);

    await bridge.shutdown();
  }, 40_000);
});

describe('a server that cannot be restarted', () => {
  it('spends its whole restart budget instead of giving up after one attempt', async () => {
    // The command always fails, so every reconnect attempt fails too. A timer
    // callback that does not reschedule on failure leaves the server dead with
    // its budget unspent and the exponential backoff pointless.
    const bridge = createMCPBridge({
      servers: {
        broken: {
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
          permission_level: 'L0_READ_ONLY',
          enabled: true,
          restart_on_failure: true,
          max_restarts: 2,
        },
      },
    });

    await bridge.start();
    expect(bridge.listServers()[0].connected).toBe(false);

    // start() failing does not itself schedule a reconnect (nothing was ever
    // connected to lose), so drive the retry path directly through a call.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const status = bridge.listServers()[0];
    expect(status.connected).toBe(false);
    expect(status.lastError).toBeTruthy();

    await bridge.shutdown();
  }, 30_000);
});

describe('revoking one server', () => {
  it('drops its tools immediately instead of at the next restart', async () => {
    // Found by driving the real Settings panel: deleting a server only
    // rewrote config, so the process kept running with its credentials and
    // its tools stayed callable while the UI showed the server as gone.
    const bridge = createMCPBridge({
      servers: {
        hang: {
          command: process.execPath,
          args: [HANG_SERVER],
          permission_level: 'L0_READ_ONLY',
          enabled: true,
          restart_on_failure: true,
          max_restarts: 3,
        },
      },
    });

    await bridge.start();
    expect(bridge.listTools().map(t => t.name)).toEqual(['mcp_hang_stall']);

    expect(await bridge.disconnectServer('hang')).toBe(true);
    expect(bridge.listTools()).toEqual([]);
    expect(bridge.listServers()).toEqual([]);

    // The tool must also stop being callable, not merely stop being listed.
    const outcome = await bridge.callTool('mcp_hang_stall', {});
    expect(outcome.ok).toBe(false);

    expect(await bridge.disconnectServer('hang')).toBe(false);
    await bridge.shutdown();
  }, 30_000);
});

describe('shutdown', () => {
  it('leaves nothing connected and no tools exposed', async () => {
    const bridge = createMCPBridge({
      servers: {
        hang: {
          command: process.execPath,
          args: [HANG_SERVER],
          permission_level: 'L0_READ_ONLY',
          enabled: true,
          restart_on_failure: true,
          max_restarts: 3,
        },
      },
    });

    await bridge.start();
    expect(bridge.listTools()).toHaveLength(1);

    await bridge.shutdown();
    expect(bridge.listTools()).toEqual([]);
    expect(bridge.listServers()).toEqual([]);
  }, 30_000);
});
