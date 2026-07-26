import pino from 'pino';
import { createMCPClient, type MCPClient, type ListToolsResult } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { MCPConfig, MCPServerConfig } from './config.js';
import { buildMcpToolName } from './naming.js';

const logger = pino({ name: 'mozi:mcp' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPServerStatus {
  id: string;
  connected: boolean;
  toolCount: number;
  permissionLevel: string;
  restarts: number;
  /** Reason the server is not connected, when it is not. */
  lastError: string | null;
}

/** One MCP tool, resolved to the shape MOZI's tool layer needs. */
export interface McpToolEntry {
  /** Model-facing name (`mcp_<server>_<tool>`, sanitised). */
  name: string;
  serverId: string;
  /** The name the server itself uses. */
  remoteName: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  /** The declared level of the server this tool came from. */
  permissionLevel: string;
}

export interface McpCallOutcome {
  ok: boolean;
  /** Result rendered as text for the model. */
  content: string;
}

export interface MCPBridge {
  /** Start all enabled MCP servers */
  start(): Promise<void>;
  /**
   * Currently callable tools, reflecting live connection state.
   *
   * The tool *set offered to a model* must not change mid-turn, so callers
   * snapshot this at a turn boundary rather than reading it per tool call.
   */
  listTools(): McpToolEntry[];
  /** Invoke a tool by its model-facing name. Never throws. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallOutcome>;
  /**
   * Stop one server and drop its tools immediately. Returns false when the id
   * was not connected. Used when a definition is revoked, so the revocation
   * takes effect now rather than at the next restart.
   */
  disconnectServer(id: string): Promise<boolean>;
  /** List server statuses */
  listServers(): MCPServerStatus[];
  /** Shutdown all servers */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Subprocess environment
// ---------------------------------------------------------------------------

/**
 * Variables an MCP server process inherits from MOZI.
 *
 * Deliberately minimal. The previous implementation passed `{...process.env}`
 * whenever a server declared any `env` at all — and declaring `env` is exactly
 * what a credential-consuming server does — so those servers could read MOZI's
 * provider API keys, JWT secret and master key. A server that needs a
 * credential must now declare it, which is also what makes the config
 * auditable.
 */
/*
 * Proxy and TLS-trust variables are inherited deliberately: an MCP server that
 * reaches the internet from behind a corporate proxy or a TLS-inspecting CA
 * fails with no useful diagnostic without them, and none of them is a secret.
 *
 * Note that `Experimental_StdioMCPTransport.getEnvironment` overwrites
 * HOME/LOGNAME/PATH/SHELL/TERM/USER from the parent after applying this map,
 * so declaring those in a server's `env` has no effect. It also injects the
 * Windows-specific set itself.
 */
const INHERITED_ENV_VARS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const;

export function buildServerEnv(
  declared: Record<string, string> | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_VARS) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(declared ?? {}) };
}

// ---------------------------------------------------------------------------
// Server connection state
// ---------------------------------------------------------------------------

interface ServerConnection {
  id: string;
  config: MCPServerConfig;
  client: MCPClient | null;
  connected: boolean;
  restarts: number;
  lastError: string | null;
  /** Tools this server currently contributes, keyed by model-facing name. */
  tools: Map<string, McpToolEntry>;
  /** Executable AI SDK tools, keyed by the server's own tool name. */
  executables: Record<string, { execute?: (input: unknown, options: unknown) => unknown }>;
}

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/**
 * An MCP server can return an arbitrarily large payload, and it lands directly
 * in the model's context. Cap it the way any other untrusted tool output is
 * capped rather than letting one call blow the context window.
 */
const MAX_RESULT_CHARS = 60_000;
/** Bound on the `initialize` handshake and the `tools/list` that follows it. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Bound on the liveness probe issued after a failed tool call. */
const PROBE_TIMEOUT_MS = 10_000;

class McpDeadlineError extends Error {}

/**
 * Run an MCP request against a wall-clock deadline.
 *
 * Necessary because `@ai-sdk/mcp` cannot be made to time out from the outside.
 * Its `RequestOptions.timeout` is declared in the types but never implemented,
 * and while `signal` is checked before sending and again when a response
 * arrives, nothing listens for `abort` — so aborting mid-wait does not settle
 * the promise. A server that accepts a request and then goes quiet hangs the
 * caller forever. The signal is still passed through so a late response is
 * discarded rather than acted on.
 */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new McpDeadlineError(`MCP request exceeded ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderResult(result: unknown): string {
  if (typeof result === 'string') return result;
  let text: string;
  try {
    text = JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    text = String(result);
  }
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: MCP result was ${text.length} characters, limit ${MAX_RESULT_CHARS}]`;
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

export function createMCPBridge(config: MCPConfig): MCPBridge {
  const connections = new Map<string, ServerConnection>();
  /** Model-facing tool name → owning server id. */
  const toolOwners = new Map<string, string>();
  const reconnectTimers = new Map<string, NodeJS.Timeout>();
  let shuttingDown = false;

  function dropTools(conn: ServerConnection): void {
    for (const name of conn.tools.keys()) toolOwners.delete(name);
    conn.tools.clear();
    conn.executables = {};
  }

  /**
   * Queue the next reconnect attempt, if the server's config still allows one.
   *
   * Separate from `handleServerFailure` because a *failed* reconnect has to be
   * able to queue another one. When this lived inline, the timer callback ran
   * `openClient`, and `openClient`'s catch only logs — so a server whose cause
   * of death outlived the first 1s retry (an npx cache lock, a busy port)
   * stayed dead for the process lifetime with its restart budget unspent, and
   * the exponential backoff had nothing to back off from.
   */
  function scheduleReconnect(conn: ServerConnection): void {
    if (shuttingDown || conn.connected) return;
    if (!conn.config.restart_on_failure || conn.restarts >= conn.config.max_restarts) {
      logger.warn(
        { serverId: conn.id, restarts: conn.restarts, max: conn.config.max_restarts },
        'MCP server will not be restarted',
      );
      return;
    }

    conn.restarts += 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (conn.restarts - 1), RECONNECT_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      reconnectTimers.delete(conn.id);
      void (async () => {
        if (shuttingDown) return;
        await openClient(conn);
        if (shuttingDown) {
          // `shutdown()` ran while this attempt was in flight and has already
          // walked `connections`, so nothing else will ever close this client.
          await conn.client?.close().catch(() => {});
          conn.client = null;
          conn.connected = false;
          return;
        }
        if (conn.connected) await loadTools(conn);
        else scheduleReconnect(conn);
      })();
    }, delay);
    // Do not hold the event loop open purely to retry a dead MCP server.
    timer.unref?.();
    reconnectTimers.set(conn.id, timer);
  }

  function handleServerFailure(conn: ServerConnection, err: unknown): void {
    if (shuttingDown || !conn.connected) return;
    const message = err instanceof Error ? err.message : String(err);
    conn.connected = false;
    conn.lastError = message;
    dropTools(conn);
    logger.warn({ serverId: conn.id, err: message }, 'MCP server lost');
    scheduleReconnect(conn);
  }

  async function openClient(conn: ServerConnection): Promise<void> {
    try {
      const transport = new Experimental_StdioMCPTransport({
        command: conn.config.command,
        args: conn.config.args,
        env: buildServerEnv(conn.config.env),
      });

      // Bounded: a command that spawns but never answers `initialize` would
      // otherwise hang `start()` — and with it MOZI's boot (index.ts awaits
      // it) — and hang the `/api/mcp/servers/:id/test` request indefinitely.
      const pending = createMCPClient({
        transport,
        name: 'mozi',
        onUncaughtError: (err) => handleServerFailure(conn, err),
      });
      try {
        conn.client = await withDeadline(() => pending, CONNECT_TIMEOUT_MS);
      } catch (err) {
        // The handshake may still complete after the deadline. Close whatever
        // it produces, or the child process outlives the connection attempt.
        void pending.then((client) => client.close()).catch(() => {});
        throw err;
      }
      conn.connected = true;
      conn.lastError = null;
      logger.info({ serverId: conn.id, command: conn.config.command }, 'MCP server connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      conn.client = null;
      conn.connected = false;
      conn.lastError = message;
      logger.error({ serverId: conn.id, err: message }, 'Failed to connect MCP server');
    }
  }

  /**
   * Fetch the server's tool list once and derive both halves from it: the
   * JSON-Schema definitions the model is offered, and the executables used to
   * invoke them. One round trip, and the two halves cannot drift apart.
   */
  async function loadTools(conn: ServerConnection): Promise<void> {
    if (!conn.connected || !conn.client) return;
    dropTools(conn);

    let listed: ListToolsResult;
    try {
      listed = await withDeadline(
        (signal) => conn.client!.listTools({ options: { signal } }),
        CONNECT_TIMEOUT_MS,
      );
      conn.executables = conn.client.toolsFromDefinitions(listed) as ServerConnection['executables'];
    } catch (err) {
      handleServerFailure(conn, err);
      return;
    }

    for (const tool of listed.tools) {
      const name = buildMcpToolName(conn.id, tool.name);
      const owner = toolOwners.get(name);
      if (owner !== undefined) {
        logger.warn(
          { serverId: conn.id, tool: tool.name, name, owner },
          'MCP tool name collides with another server — not exposed',
        );
        continue;
      }
      conn.tools.set(name, {
        name,
        serverId: conn.id,
        remoteName: tool.name,
        description: tool.description ?? `MCP tool "${tool.name}" from server "${conn.id}"`,
        parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        permissionLevel: conn.config.permission_level,
      });
      toolOwners.set(name, conn.id);
    }

    logger.info({ serverId: conn.id, tools: conn.tools.size }, 'MCP tools collected');
  }

  return {
    async start(): Promise<void> {
      shuttingDown = false;
      const enabledServers = Object.entries(config.servers).filter(([, cfg]) => cfg.enabled !== false);

      if (enabledServers.length === 0) {
        logger.info('No MCP servers configured');
        return;
      }

      await Promise.all(
        enabledServers.map(async ([id, cfg]) => {
          const conn: ServerConnection = {
            id,
            config: cfg,
            client: null,
            connected: false,
            restarts: 0,
            lastError: null,
            tools: new Map(),
            executables: {},
          };
          connections.set(id, conn);
          await openClient(conn);
          if (conn.connected) await loadTools(conn);
        }),
      );

      const connected = Array.from(connections.values()).filter((c) => c.connected).length;
      logger.info(
        { total: enabledServers.length, connected, tools: toolOwners.size },
        'MCP bridge started',
      );
    },

    listTools(): McpToolEntry[] {
      const entries: McpToolEntry[] = [];
      for (const conn of connections.values()) {
        if (!conn.connected) continue;
        entries.push(...conn.tools.values());
      }
      return entries;
    },

    async callTool(name, args, options) {
      const serverId = toolOwners.get(name);
      const conn = serverId ? connections.get(serverId) : undefined;
      if (!conn || !conn.connected) {
        // Live membership means a tool can vanish between the moment the model
        // was offered it and the moment it calls it. Report that plainly; the
        // model can pick another route instead of the turn dying.
        const reason = conn?.lastError ? `: ${conn.lastError}` : '';
        return {
          ok: false,
          content: `MCP tool "${name}" is unavailable — its server${serverId ? ` "${serverId}"` : ''} is not connected${reason}.`,
        };
      }

      const entry = conn.tools.get(name);
      const executable = entry ? conn.executables[entry.remoteName] : undefined;
      if (!entry || !executable?.execute) {
        return { ok: false, content: `MCP tool "${name}" is no longer exposed by server "${conn.id}".` };
      }

      const timeoutMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const signals = [timeoutController.signal];
      // Chaining the caller's signal is what makes a cancelled turn actually
      // stop the MCP call instead of leaving it running against a dead turn.
      if (options?.abortSignal) signals.push(options.abortSignal);

      try {
        const result = await executable.execute(args, {
          toolCallId: `${name}_${conn.restarts}_${conn.tools.size}`,
          messages: [],
          abortSignal: AbortSignal.any(signals),
        });
        return { ok: true, content: renderResult(result) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (timeoutController.signal.aborted) {
          return { ok: false, content: `MCP tool "${name}" timed out after ${timeoutMs}ms.` };
        }
        if (options?.abortSignal?.aborted) {
          return { ok: false, content: `MCP tool "${name}" was cancelled.` };
        }
        // A failure here may mean the transport died, not just that this call
        // was rejected. Probe the connection so the tool set stops advertising
        // a server that is gone.
        //
        // The probe carries its own deadline. `@ai-sdk/mcp`'s request layer has
        // no timeout of its own — it settles only on a response, a send
        // failure, or transport close — so a server that rejects `tools/call`
        // quickly and then stops answering `tools/list` would hang here
        // forever, past the `finally` that clears this call's timeout and
        // unreachable by the caller's cancellation.
        try {
          await withDeadline(
            (signal) => conn.client?.listTools({ options: { signal } }) ?? Promise.resolve(null),
            PROBE_TIMEOUT_MS,
          );
        } catch (probeErr) {
          handleServerFailure(conn, probeErr);
        }
        return { ok: false, content: `MCP tool "${name}" failed: ${message}` };
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Stop one server and drop its tools, without touching the others.
     *
     * Revoking a server has to take effect now, not at the next restart.
     * Deleting or disabling a definition only rewrote config, so the process
     * kept running with its credentials and its tools stayed callable — the
     * operator believed they had cut off a third-party server that was in fact
     * still live.
     *
     * Only ever *removes* capability, so it is safe to apply mid-session: the
     * live-membership rule already covers tools disappearing, and nothing new
     * is offered. Adding or editing a server still needs a restart.
     */
    async disconnectServer(id: string): Promise<boolean> {
      const conn = connections.get(id);
      if (!conn) return false;

      const timer = reconnectTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(id);
      }
      // Spend the restart budget so a queued reconnect cannot revive it.
      conn.restarts = conn.config.max_restarts;
      conn.connected = false;
      dropTools(conn);
      const client = conn.client;
      conn.client = null;
      connections.delete(id);
      if (client) {
        await client.close().catch((err) => {
          logger.warn({ serverId: id, err: err instanceof Error ? err.message : String(err) }, 'Error closing MCP client');
        });
      }
      logger.info({ serverId: id }, 'MCP server disconnected on request');
      return true;
    },

    listServers(): MCPServerStatus[] {
      return Array.from(connections.values()).map((conn) => ({
        id: conn.id,
        connected: conn.connected,
        toolCount: conn.tools.size,
        permissionLevel: conn.config.permission_level,
        restarts: conn.restarts,
        lastError: conn.lastError,
      }));
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const timer of reconnectTimers.values()) clearTimeout(timer);
      reconnectTimers.clear();

      await Promise.allSettled(
        Array.from(connections.values()).map(async (conn) => {
          if (!conn.client) return;
          try {
            await conn.client.close();
          } catch (err) {
            logger.warn(
              { serverId: conn.id, err: err instanceof Error ? err.message : String(err) },
              'Error closing MCP client',
            );
          }
        }),
      );

      connections.clear();
      toolOwners.clear();
      logger.info('MCP bridge shut down');
    },
  };
}
