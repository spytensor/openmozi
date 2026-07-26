/**
 * Model-facing naming for MCP tools.
 *
 * MCP servers choose their own tool names. Those names reach the provider API
 * verbatim unless something sanitises them, and every major provider rejects a
 * tool whose name falls outside `^[a-zA-Z0-9_-]{1,64}$` — rejecting the *whole
 * request*, not just the offending tool. A single server exposing `search.web`
 * would therefore break every turn, including turns that never touch MCP.
 */
import { createHash } from 'node:crypto';

/** Every model-facing MCP tool name starts with this. */
export const MCP_TOOL_PREFIX = 'mcp_';

/** Tightest common provider constraint on tool names. */
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

function sanitisePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build the model-facing name for a server's tool.
 *
 * Over-long names are truncated and given a hash suffix derived from the full
 * `<serverId>/<toolName>` pair, so two tools that truncate to the same prefix
 * still get distinct names, and the same tool gets the same name on every run
 * (a name that changed between runs would invalidate the prompt cache).
 */
export function buildMcpToolName(serverId: string, toolName: string): string {
  const full = `${MCP_TOOL_PREFIX}${sanitisePart(serverId)}_${sanitisePart(toolName)}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;

  const hash = createHash('sha1')
    .update(`${serverId}/${toolName}`)
    .digest('hex')
    .slice(0, HASH_SUFFIX_LENGTH);
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH - 1)}_${hash}`;
}

/** Cheap prefix test used by the dispatch chain to skip non-MCP tool names. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}
