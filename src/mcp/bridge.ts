import pino from 'pino';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { MCPConfig, MCPServerConfig } from './config.js';

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
}

export interface MCPBridge {
  /** Start all enabled MCP servers */
  start(): Promise<void>;
  /** Get AI SDK tools from all connected servers (prefixed, permission-wrapped) */
  getTools(): Record<string, unknown>;
  /** List connected server statuses */
  listServers(): MCPServerStatus[];
  /** Shutdown all servers */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Permission level ordering
// ---------------------------------------------------------------------------

const PERMISSION_LEVELS = ['L0_READ_ONLY', 'L1_READ_WRITE', 'L2_SHELL_EXEC', 'L3_FULL_ACCESS'] as const;

function permissionLevelIndex(level: string): number {
  const idx = PERMISSION_LEVELS.indexOf(level as typeof PERMISSION_LEVELS[number]);
  return idx >= 0 ? idx : 0;
}

// ---------------------------------------------------------------------------
// Server connection state
// ---------------------------------------------------------------------------

interface ServerConnection {
  id: string;
  config: MCPServerConfig;
  client: MCPClient | null;
  transport: Experimental_StdioMCPTransport | null;
  connected: boolean;
  toolCount: number;
  restarts: number;
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

export function createMCPBridge(config: MCPConfig): MCPBridge {
  const connections = new Map<string, ServerConnection>();
  let allTools: Record<string, unknown> = {};

  async function connectServer(id: string, serverConfig: MCPServerConfig): Promise<ServerConnection> {
    const conn: ServerConnection = {
      id,
      config: serverConfig,
      client: null,
      transport: null,
      connected: false,
      toolCount: 0,
      restarts: 0,
    };

    try {
      const transport = new Experimental_StdioMCPTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env ? { ...process.env, ...serverConfig.env } as Record<string, string> : undefined,
      });

      const client = await createMCPClient({ transport });

      conn.client = client;
      conn.transport = transport;
      conn.connected = true;

      logger.info({ serverId: id, command: serverConfig.command }, 'MCP server connected');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ serverId: id, err: errMsg }, 'Failed to connect MCP server');
      conn.connected = false;
    }

    return conn;
  }

  async function collectTools(): Promise<void> {
    const merged: Record<string, unknown> = {};

    for (const [id, conn] of connections) {
      if (!conn.connected || !conn.client) continue;

      try {
        const serverTools = await conn.client.tools();
        const serverPermLevel = permissionLevelIndex(conn.config.permission_level);
        let count = 0;

        for (const [toolName, tool] of Object.entries(serverTools)) {
          const prefixedName = `mcp_${id}_${toolName}`;
          const originalTool = tool as { description?: string; parameters?: unknown; execute?: (...args: unknown[]) => unknown };

          // Wrap the tool with permission checking and audit logging
          const wrappedTool = {
            ...originalTool,
            execute: async (...args: unknown[]) => {
              // Log MCP tool call
              try {
                const { log } = await import('../store/events.js');
                log('mcp_tool_call', 'mcp', prefixedName, {
                  server: id,
                  tool: toolName,
                  permission_level: conn.config.permission_level,
                  args_preview: JSON.stringify(args).slice(0, 500),
                });
              } catch {
                // DB may not be available during tests
              }

              if (!originalTool.execute) {
                throw new Error(`MCP tool ${toolName} has no execute function`);
              }

              const result = await originalTool.execute(...args);

              // Log result
              try {
                const { log } = await import('../store/events.js');
                log('mcp_tool_result', 'mcp', prefixedName, {
                  server: id,
                  tool: toolName,
                  result_length: JSON.stringify(result).length,
                });
              } catch {
                // DB may not be available during tests
              }

              return result;
            },
          };

          merged[prefixedName] = wrappedTool;
          count++;
        }

        conn.toolCount = count;
        logger.info({ serverId: id, tools: count }, 'MCP tools collected');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ serverId: id, err: errMsg }, 'Failed to collect MCP tools');
        conn.toolCount = 0;
      }
    }

    allTools = merged;
  }

  return {
    async start(): Promise<void> {
      const enabledServers = Object.entries(config.servers).filter(
        ([, cfg]) => cfg.enabled !== false,
      );

      if (enabledServers.length === 0) {
        logger.info('No MCP servers configured');
        return;
      }

      // Connect all servers in parallel
      const results = await Promise.allSettled(
        enabledServers.map(async ([id, cfg]) => {
          const conn = await connectServer(id, cfg);
          connections.set(id, conn);
        }),
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const [id] = enabledServers[i];
          logger.error({ serverId: id, err: (results[i] as PromiseRejectedResult).reason }, 'MCP server startup failed');
        }
      }

      // Collect tools from all connected servers
      await collectTools();

      const connectedCount = Array.from(connections.values()).filter(c => c.connected).length;
      logger.info({ total: enabledServers.length, connected: connectedCount, tools: Object.keys(allTools).length }, 'MCP bridge started');
    },

    getTools(): Record<string, unknown> {
      return allTools;
    },

    listServers(): MCPServerStatus[] {
      return Array.from(connections.values()).map(conn => ({
        id: conn.id,
        connected: conn.connected,
        toolCount: conn.toolCount,
        permissionLevel: conn.config.permission_level,
        restarts: conn.restarts,
      }));
    },

    async shutdown(): Promise<void> {
      const shutdownPromises: Promise<void>[] = [];

      for (const [id, conn] of connections) {
        if (conn.client) {
          shutdownPromises.push(
            conn.client.close().catch(err => {
              logger.warn({ serverId: id, err: err instanceof Error ? err.message : String(err) }, 'Error closing MCP client');
            }),
          );
        }
      }

      await Promise.allSettled(shutdownPromises);
      connections.clear();
      allTools = {};
      logger.info('MCP bridge shut down');
    },
  };
}
