import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMCPBridge } from './index.js';
import type { MCPBridge, McpToolEntry } from './bridge.js';
import {
  clearMcpToolSnapshot,
  executeMcpTool,
  getMcpToolDefinitions,
  getMcpToolPermission,
  refreshMcpToolSnapshot,
} from './tool-adapter.js';
import { getAllRegisteredTools } from '../tools/dynamic-registry.js';
import { getToolPermission } from '../tools/tool-permission-map.js';

function entry(overrides: Partial<McpToolEntry> = {}): McpToolEntry {
  return {
    name: 'mcp_files_read',
    serverId: 'files',
    remoteName: 'read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    permissionLevel: 'L0_READ_ONLY',
    ...overrides,
  };
}

function stubBridge(tools: McpToolEntry[], call?: MCPBridge['callTool']): MCPBridge {
  return {
    start: vi.fn(async () => {}),
    listTools: () => tools,
    callTool: call ?? vi.fn(async () => ({ ok: true, content: 'ok' })),
    listServers: () => [],
    shutdown: vi.fn(async () => {}),
  };
}

afterEach(() => {
  setMCPBridge(null);
  clearMcpToolSnapshot();
});

describe('MCP tool snapshot', () => {
  it('takes a snapshot on first read for surfaces that never call refresh', () => {
    // A background DAG loop or delegated agent never hits a turn boundary. It
    // must still see the real tool set, not an empty one.
    setMCPBridge(stubBridge([entry()]));
    expect(getMcpToolDefinitions()).toHaveLength(1);
  });

  it('does not pin an empty set read before the bridge was installed', () => {
    // `getAllRegisteredTools()` runs at startup (index.ts:222 and :268) long
    // before `setMCPBridge` at :1354. A plain lazy init pinned that empty read
    // and every later read honoured it, so MCP tools stayed invisible to every
    // surface that does not force a refresh.
    expect(getMcpToolDefinitions()).toEqual([]);
    setMCPBridge(stubBridge([entry()]));
    expect(getMcpToolDefinitions()).toHaveLength(1);
  });

  it('drops the snapshot when the bridge is torn down', () => {
    setMCPBridge(stubBridge([entry()]));
    expect(getMcpToolDefinitions()).toHaveLength(1);
    setMCPBridge(null);
    expect(getMcpToolDefinitions()).toEqual([]);
  });

  it('holds the set steady when live state changes mid-turn', () => {
    // The model must not be offered a tool that disappears before it calls it,
    // and the tool array must not be rewritten between loop iterations.
    let live = [entry()];
    setMCPBridge(stubBridge(live as McpToolEntry[]));
    const bridge = { ...stubBridge([]), listTools: () => live };
    setMCPBridge(bridge as MCPBridge);
    refreshMcpToolSnapshot();
    expect(getMcpToolDefinitions()).toHaveLength(1);

    live = [];
    expect(getMcpToolDefinitions()).toHaveLength(1);

    refreshMcpToolSnapshot();
    expect(getMcpToolDefinitions()).toHaveLength(0);
  });

  it('names the origin server in the description', () => {
    setMCPBridge(stubBridge([entry()]));
    refreshMcpToolSnapshot();
    expect(getMcpToolDefinitions()[0].function.description).toContain('[MCP:files]');
  });

  it('passes the server schema through as tool parameters', () => {
    setMCPBridge(stubBridge([entry()]));
    refreshMcpToolSnapshot();
    expect(getMcpToolDefinitions()[0].function.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
  });
});

describe('MCP tools reach the offered tool set', () => {
  it('appears in getAllRegisteredTools — the wiring that was missing', () => {
    setMCPBridge(stubBridge([entry()]));
    refreshMcpToolSnapshot();
    const names = getAllRegisteredTools().map(tool => tool.function.name);
    expect(names).toContain('mcp_files_read');
  });

  it('never shadows a local tool of the same name', () => {
    setMCPBridge(stubBridge([entry({ name: 'shell_exec' })]));
    refreshMcpToolSnapshot();
    const shellTools = getAllRegisteredTools().filter(tool => tool.function.name === 'shell_exec');
    expect(shellTools).toHaveLength(1);
    expect(shellTools[0].function.description).not.toContain('[MCP:');
  });

  it('refuses to register a dynamic tool under the reserved MCP prefix', async () => {
    // Dispatch reaches dynamic tools before MCP, but `getToolPermission` would
    // still resolve the MCP entry — so a script named `mcp_files_read` would
    // execute under an MCP server's declared level instead of the
    // `shell/execute` a script requires. An L0_READ_ONLY session could then run
    // arbitrary bash.
    const { registerDynamicTool } = await import('../tools/dynamic-registry.js');
    expect(() => registerDynamicTool({
      name: 'mcp_files_read',
      description: 'a script pretending to be an MCP tool',
      parameters_schema: JSON.stringify({ type: 'object', properties: {} }),
      handler_path: '/tmp/whatever.sh',
    } as Parameters<typeof registerDynamicTool>[0])).toThrow(/reserved MCP prefix/);
  });

  it('contributes nothing when no bridge is running', () => {
    refreshMcpToolSnapshot();
    expect(getAllRegisteredTools().some(tool => tool.function.name.startsWith('mcp_'))).toBe(false);
  });
});

describe('MCP permission resolution', () => {
  it('maps each declared level onto a requirement', () => {
    setMCPBridge(stubBridge([
      entry({ name: 'mcp_a_t', permissionLevel: 'L0_READ_ONLY' }),
      entry({ name: 'mcp_b_t', permissionLevel: 'L1_READ_WRITE' }),
      entry({ name: 'mcp_c_t', permissionLevel: 'L2_SHELL_EXEC' }),
    ]));
    refreshMcpToolSnapshot();
    expect(getMcpToolPermission('mcp_a_t')).toEqual({ category: 'filesystem', action: 'read' });
    expect(getMcpToolPermission('mcp_b_t')).toEqual({ category: 'filesystem', action: 'write' });
    expect(getMcpToolPermission('mcp_c_t')).toEqual({ category: 'shell', action: 'execute' });
  });

  it('fails closed for an MCP name it cannot resolve', () => {
    // A server that vanished mid-turn must not downgrade to a weaker gate than
    // the one its tool was offered under.
    refreshMcpToolSnapshot();
    expect(getMcpToolPermission('mcp_gone_tool')).toEqual({ category: 'shell', action: 'execute' });
  });

  it('leaves non-MCP names to the existing map', () => {
    expect(getMcpToolPermission('shell_exec')).toBeUndefined();
  });

  it('is what the hot-path gate actually consults', () => {
    setMCPBridge(stubBridge([entry({ permissionLevel: 'L0_READ_ONLY' })]));
    refreshMcpToolSnapshot();
    expect(getToolPermission('mcp_files_read')).toEqual({ category: 'filesystem', action: 'read' });
    // Built-ins keep their declared requirement.
    expect(getToolPermission('shell_exec')).toEqual({ category: 'shell', action: 'execute' });
  });
});

describe('executeMcpTool', () => {
  it('ignores non-MCP names so the dispatch chain is unaffected', async () => {
    expect(await executeMcpTool('read_file', {}, 'call-1')).toBeNull();
  });

  it('returns the bridge result', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'file contents' }));
    setMCPBridge(stubBridge([entry()], callTool));
    refreshMcpToolSnapshot();

    const result = await executeMcpTool('mcp_files_read', { path: '/tmp/a' }, 'call-2');
    expect(result).toMatchObject({ tool_call_id: 'call-2', content: 'file contents', is_error: false });
    expect(callTool).toHaveBeenCalledWith('mcp_files_read', { path: '/tmp/a' }, expect.anything());
  });

  it('reports a failed call as an error result rather than throwing', async () => {
    const callTool = vi.fn(async () => ({ ok: false, content: 'server is not connected' }));
    setMCPBridge(stubBridge([entry()], callTool));
    refreshMcpToolSnapshot();

    const result = await executeMcpTool('mcp_files_read', {}, 'call-3');
    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('not connected');
  });

  it('errors when the tool left the snapshot', async () => {
    setMCPBridge(stubBridge([]));
    refreshMcpToolSnapshot();
    const result = await executeMcpTool('mcp_files_read', {}, 'call-4');
    expect(result?.is_error).toBe(true);
  });

  it('chains the caller abort signal so a cancelled turn stops the call', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'ok' }));
    setMCPBridge(stubBridge([entry()], callTool));
    refreshMcpToolSnapshot();

    const controller = new AbortController();
    await executeMcpTool('mcp_files_read', {}, 'call-5', {
      permissionLevel: 'L3_FULL_ACCESS',
      agentId: 'test',
      abortSignal: controller.signal,
    });
    expect(callTool.mock.calls[0][2]).toMatchObject({ abortSignal: controller.signal });
  });
});
