import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createMCPBridge, setMCPBridge } from './index.js';
import { refreshMcpToolSnapshot, clearMcpToolSnapshot } from './tool-adapter.js';
import { getAllRegisteredTools } from '../tools/dynamic-registry.js';
import { getToolPermission } from '../tools/tool-permission-map.js';
import { executeToolCalls } from '../tools/executor.js';

const SERVER = new URL('./echo-server.fixture.mjs', import.meta.url).pathname;

const bridge = createMCPBridge({
  servers: {
    proof: {
      command: process.execPath,
      args: [SERVER],
      env: { PROOF_DECLARED: 'declared-value' },
      permission_level: 'L1_READ_WRITE',
      enabled: true,
      restart_on_failure: false,
      max_restarts: 0,
    },
  },
});

let tmpDir: string;

beforeAll(() => {
  // `executeToolCalls` writes turn envelopes and tool spans, so the real
  // execution path needs a real database.
  tmpDir = setupTestDb().tmpDir;
});

afterAll(async () => {
  setMCPBridge(null);
  clearMcpToolSnapshot();
  await bridge.shutdown();
  teardownTestDb(tmpDir);
});

describe('MCP end-to-end through the real tool pipeline', () => {
  it('spawns, connects and exposes the server tools to the model', async () => {
    await bridge.start();
    setMCPBridge(bridge);
    refreshMcpToolSnapshot();

    const status = bridge.listServers();
    console.log('SERVER STATUS:', JSON.stringify(status));
    expect(status[0].connected).toBe(true);

    const names = getAllRegisteredTools().map(t => t.function.name);
    const mcpNames = names.filter(n => n.startsWith('mcp_'));
    console.log('MCP TOOLS OFFERED TO MODEL:', JSON.stringify(mcpNames));
    // `echo.shout` must have been sanitised — a dot would break the API request.
    expect(mcpNames).toContain('mcp_proof_echo_shout');
    expect(mcpNames).toContain('mcp_proof_whoami');
  });

  it('resolves permission from the declared server level', () => {
    const perm = getToolPermission('mcp_proof_echo_shout');
    console.log('PERMISSION RESOLVED:', JSON.stringify(perm));
    expect(perm).toEqual({ category: 'filesystem', action: 'write' });
  });

  it('executes through executeToolCalls — the same path every built-in takes', async () => {
    const results = await executeToolCalls(
      [{ id: 'e2e-1', type: 'function', function: { name: 'mcp_proof_echo_shout', arguments: JSON.stringify({ text: 'wired at last' }) } }],
      { permissionLevel: 'L3_FULL_ACCESS', agentId: 'e2e-proof', tenantId: 'default' },
    );
    console.log('TOOL RESULT:', JSON.stringify(results));
    expect(results[0].is_error).toBe(false);
    expect(results[0].content).toContain('WIRED AT LAST');
  });

  it('denies the same call at a session level below the server level', async () => {
    const results = await executeToolCalls(
      [{ id: 'e2e-2', type: 'function', function: { name: 'mcp_proof_echo_shout', arguments: JSON.stringify({ text: 'x' }) } }],
      { permissionLevel: 'L0_READ_ONLY', agentId: 'e2e-proof', tenantId: 'default' },
    );
    console.log('L0 GATE RESULT:', JSON.stringify(results));
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).not.toContain('X');
  });

  it('did not hand MOZI credentials to the server process', async () => {
    const results = await executeToolCalls(
      [{ id: 'e2e-3', type: 'function', function: { name: 'mcp_proof_whoami', arguments: '{}' } }],
      { permissionLevel: 'L3_FULL_ACCESS', agentId: 'e2e-proof', tenantId: 'default' },
    );
    console.log('SUBPROCESS ENV:', results[0].content);
    expect(results[0].is_error).toBe(false);
    const payload = JSON.parse(JSON.parse(results[0].content).content[0].text);
    expect(payload.leaked_vars).toEqual([]);
    expect(payload.declared_var).toBe('declared-value');
  });
});
