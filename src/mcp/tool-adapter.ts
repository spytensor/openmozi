/**
 * Bridges MCP tools into MOZI's own tool pipeline.
 *
 * MCP tools go through the same path as every built-in tool — the offered set
 * from `getAllRegisteredTools`, the permission gate and hooks in
 * `executeToolInner`, then one more link in the dispatch chain. A parallel path
 * would have skipped the permission gate, the approval flow, the hook plugins
 * and the execution timeline the UI renders.
 */
import pino from 'pino';
import type { ToolDefinition } from '../core/llm-contracts.js';
import type { ToolResult, ToolContext } from '../tools/types.js';
import type { ToolPermission } from '../tools/tool-permission-map.js';
import { getMCPBridge } from './index.js';
import { isMcpToolName } from './naming.js';
import type { McpToolEntry, MCPBridge } from './bridge.js';

const logger = pino({ name: 'mozi:mcp:tools' });

// ---------------------------------------------------------------------------
// Turn-boundary snapshot
// ---------------------------------------------------------------------------

/**
 * The tool set the model is currently offered.
 *
 * MCP membership is live — a server that drops takes its tools with it. But the
 * set handed to a model must not change *within* a turn: the model would be
 * offered a tool that vanishes before it calls it, and the tool array would be
 * rewritten between iterations of a single tool loop, invalidating the request
 * prefix mid-turn (the #727 prompt-cache incident class).
 *
 * So the live state is published into a snapshot at turn boundaries, and every
 * read within the turn sees the same set.
 *
 * `null` means no snapshot has been taken yet, and the first read takes one.
 * Without that, an execution surface that never calls `refreshMcpToolSnapshot`
 * — a background DAG loop, a delegated agent — would see an empty MCP tool set
 * until some chat turn happened to run first.
 *
 * `snapshotBridge` guards against pinning a snapshot from before the bridge
 * existed. `getAllRegisteredTools()` runs twice during startup (index.ts:222
 * and :268) well before `setMCPBridge` at :1354, so a plain lazy init would
 * pin an empty set and every later read would honour it.
 */
let snapshot: McpToolEntry[] | null = null;
let snapshotBridge: MCPBridge | null = null;

/** Publish current live MCP state. Called once at the start of each turn. */
export function refreshMcpToolSnapshot(): void {
  const bridge = getMCPBridge();
  const next = bridge ? bridge.listTools() : [];
  if (snapshot !== null && next.length !== snapshot.length) {
    logger.info({ from: snapshot.length, to: next.length }, 'MCP tool set changed');
  }
  snapshot = next;
  snapshotBridge = bridge;
}

/** Reset snapshot state. Test seam. */
export function clearMcpToolSnapshot(): void {
  snapshot = null;
  snapshotBridge = null;
}

function currentSnapshot(): McpToolEntry[] {
  if (snapshot === null || snapshotBridge !== getMCPBridge()) refreshMcpToolSnapshot();
  return snapshot ?? [];
}

function findEntry(toolName: string): McpToolEntry | undefined {
  return currentSnapshot().find((entry) => entry.name === toolName);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** MCP tools in the shape `getAllRegisteredTools` returns. */
export function getMcpToolDefinitions(): ToolDefinition[] {
  return currentSnapshot().map((entry) => ({
    type: 'function' as const,
    function: {
      name: entry.name,
      // Naming the origin server matters: the model needs to understand that
      // this tool is third-party and may disappear, unlike a built-in.
      description: `[MCP:${entry.serverId}] ${entry.description}`,
      parameters: entry.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Permission resolution
// ---------------------------------------------------------------------------

/**
 * The permission a server's declared level implies.
 *
 * The declared level is a ceiling the operator sets on the server, so it maps
 * onto the strongest requirement any of that server's tools may demand. The
 * session gate then applies unchanged.
 *
 * Deliberately not derived from the MCP tool's own `readOnlyHint`-style
 * annotations: the server controls those, so a careless or hostile server could
 * declare itself read-only. Operator config is the only trustworthy source.
 */
const LEVEL_TO_PERMISSION: Record<string, ToolPermission> = {
  L0_READ_ONLY: { category: 'filesystem', action: 'read' },
  L1_READ_WRITE: { category: 'filesystem', action: 'write' },
  L2_SHELL_EXEC: { category: 'shell', action: 'execute' },
  L3_FULL_ACCESS: { category: 'shell', action: 'execute' },
};

/** Most restrictive requirement, used when a tool cannot be resolved. */
const FAIL_CLOSED_PERMISSION: ToolPermission = { category: 'shell', action: 'execute' };

/**
 * Permission requirement for an MCP tool name, or `undefined` if the name is
 * not MCP at all.
 *
 * An unresolvable MCP name fails closed rather than falling through to the
 * generic dynamic-tool default, so a tool whose server disappeared mid-turn
 * cannot be executed at a weaker requirement than it was offered under.
 */
export function getMcpToolPermission(toolName: string): ToolPermission | undefined {
  if (!isMcpToolName(toolName)) return undefined;
  const entry = findEntry(toolName);
  if (!entry) return FAIL_CLOSED_PERMISSION;
  return LEVEL_TO_PERMISSION[entry.permissionLevel] ?? FAIL_CLOSED_PERMISSION;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Dispatch-chain link for MCP tools.
 *
 * Returns `null` for any name that is not an MCP tool, so the rest of the chain
 * is unaffected.
 */
export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  if (!isMcpToolName(name)) return null;

  const entry = findEntry(name);
  const bridge = getMCPBridge();
  if (!entry || !bridge) {
    return {
      tool_call_id: id,
      tool_name: name,
      content: `Error: MCP tool "${name}" is not available in this turn.`,
      is_error: true,
    };
  }

  try {
    const { log } = await import('../store/events.js');
    log('mcp_tool_call', 'mcp', name, {
      server: entry.serverId,
      tool: entry.remoteName,
      permission_level: entry.permissionLevel,
      args_preview: JSON.stringify(args).slice(0, 500),
    });
  } catch {
    // Event log is best-effort; a missing DB must not block the call.
  }

  const outcome = await bridge.callTool(name, args, { abortSignal: context?.abortSignal });

  try {
    const { log } = await import('../store/events.js');
    log('mcp_tool_result', 'mcp', name, {
      server: entry.serverId,
      tool: entry.remoteName,
      ok: outcome.ok,
      result_length: outcome.content.length,
    });
  } catch {
    // Best-effort, as above.
  }

  return {
    tool_call_id: id,
    tool_name: name,
    content: outcome.content,
    is_error: !outcome.ok,
  };
}
