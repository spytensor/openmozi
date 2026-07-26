import { describe, it, expect } from 'vitest';
import { buildMcpToolName, isMcpToolName, MCP_TOOL_PREFIX } from './naming.js';

const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe('buildMcpToolName', () => {
  it('keeps a plain name readable', () => {
    expect(buildMcpToolName('files', 'read_file')).toBe('mcp_files_read_file');
  });

  it('sanitises characters providers reject', () => {
    // A dotted tool name reaching the API verbatim fails the whole request,
    // not just this tool — every turn breaks, including turns without MCP.
    const name = buildMcpToolName('my.server', 'search.web');
    expect(name).toBe('mcp_my_server_search_web');
    expect(name).toMatch(PROVIDER_TOOL_NAME);
  });

  it('truncates over-long names within the provider limit', () => {
    const name = buildMcpToolName('s'.repeat(40), 't'.repeat(40));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(PROVIDER_TOOL_NAME);
  });

  it('keeps truncated names distinct', () => {
    const a = buildMcpToolName('server', `${'x'.repeat(70)}_alpha`);
    const b = buildMcpToolName('server', `${'x'.repeat(70)}_beta`);
    expect(a).not.toBe(b);
  });

  it('is stable across calls', () => {
    // An unstable name would change the tool array between turns and
    // invalidate the provider-side prefix cache for no reason.
    const first = buildMcpToolName('server', 'y'.repeat(80));
    expect(buildMcpToolName('server', 'y'.repeat(80))).toBe(first);
  });

  it('always carries the MCP prefix', () => {
    expect(isMcpToolName(buildMcpToolName('a', 'b'))).toBe(true);
    expect(buildMcpToolName('a', 'b').startsWith(MCP_TOOL_PREFIX)).toBe(true);
  });
});

describe('isMcpToolName', () => {
  it('rejects built-in tool names so dispatch is unaffected', () => {
    expect(isMcpToolName('shell_exec')).toBe(false);
    expect(isMcpToolName('read_file')).toBe(false);
  });
});
