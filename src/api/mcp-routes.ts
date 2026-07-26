/**
 * `/api/mcp` — manage MCP servers without hand-editing `mozi.json`.
 *
 * Config on disk stays the source of truth. These routes read and write that
 * file, then report live bridge state alongside it, so the UI can show both
 * what is configured and what is actually connected.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getConfigPath } from '../paths.js';
import { readConfigObject, writeConfigObject } from '../config/storage.js';
import { MCPServerConfigSchema, type MCPServerConfig } from '../mcp/config.js';
import { createMCPBridge, getMCPBridge } from '../mcp/index.js';

const ServerBodySchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/,
    'Server id may only contain letters, digits, underscore and hyphen'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  permission_level: z.enum(['L0_READ_ONLY', 'L1_READ_WRITE', 'L2_SHELL_EXEC', 'L3_FULL_ACCESS']).default('L0_READ_ONLY'),
  enabled: z.boolean().default(true),
  restart_on_failure: z.boolean().default(true),
  max_restarts: z.number().int().min(0).default(3),
}).strict();

const ServerPatchSchema = ServerBodySchema.omit({ id: true }).partial().strict();

interface RawConfigWithMcp {
  mcp?: { servers?: Record<string, unknown> };
  [key: string]: unknown;
}

function readServers(): Record<string, MCPServerConfig> {
  const raw = readConfigObject(getConfigPath()) as RawConfigWithMcp;
  const servers = raw.mcp?.servers ?? {};
  const parsed: Record<string, MCPServerConfig> = {};
  for (const [id, value] of Object.entries(servers)) {
    const result = MCPServerConfigSchema.safeParse(value);
    if (result.success) parsed[id] = result.data;
  }
  return parsed;
}

function writeServers(servers: Record<string, MCPServerConfig>): void {
  const path = getConfigPath();
  const raw = readConfigObject(path) as RawConfigWithMcp;
  raw.mcp = { ...(raw.mcp ?? {}), servers: servers as unknown as Record<string, unknown> };
  writeConfigObject(path, raw);
}

/**
 * Config as the UI may see it.
 *
 * `env` holds credentials, so only the variable *names* cross this boundary.
 * Echoing the values back would put every MCP server's secrets into any client
 * that can read the settings page.
 */
function present(id: string, config: MCPServerConfig) {
  const live = getMCPBridge()?.listServers().find(s => s.id === id);
  return {
    id,
    command: config.command,
    args: config.args,
    env_keys: Object.keys(config.env ?? {}),
    permission_level: config.permission_level,
    enabled: config.enabled,
    restart_on_failure: config.restart_on_failure,
    max_restarts: config.max_restarts,
    connected: live?.connected ?? false,
    tool_count: live?.toolCount ?? 0,
    restarts: live?.restarts ?? 0,
    last_error: live?.lastError ?? null,
    // Config changes take effect when the bridge next starts. Saying so is the
    // difference between an honest UI and one that implies a hot swap.
    running: live !== undefined,
  };
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ success: false, error: message });
}

/** Register the `/api/mcp` management routes. */
export function registerMcpRoutes(app: FastifyInstance): void {
  app.get('/api/mcp/servers', async (_request, reply) => {
    const servers = readServers();
    return reply.send({
      servers: Object.entries(servers).map(([id, config]) => present(id, config)),
      bridge_running: getMCPBridge() !== null,
    });
  });

  /** Tools currently callable, straight from live bridge state. */
  app.get('/api/mcp/tools', async (_request, reply) => {
    const bridge = getMCPBridge();
    if (!bridge) return reply.send({ tools: [], bridge_running: false });
    return reply.send({
      bridge_running: true,
      tools: bridge.listTools().map(tool => ({
        name: tool.name,
        server_id: tool.serverId,
        remote_name: tool.remoteName,
        description: tool.description,
        permission_level: tool.permissionLevel,
      })),
    });
  });

  app.post('/api/mcp/servers', async (request, reply) => {
    const parsed = ServerBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid server definition');

    const { id, ...config } = parsed.data;
    const servers = readServers();
    if (servers[id]) return reply.code(409).send({ success: false, error: `MCP server "${id}" already exists` });

    servers[id] = config;
    writeServers(servers);
    return reply.code(201).send({ success: true, server: present(id, config) });
  });

  app.patch('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ServerPatchSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid server patch');

    const servers = readServers();
    const existing = servers[id];
    if (!existing) return reply.code(404).send({ success: false, error: `MCP server "${id}" not found` });

    // A patch that omits `env` leaves the stored credentials alone. The UI
    // cannot read them back, so it cannot echo them either — without this, any
    // edit of the command would silently wipe the server's secrets.
    const merged = { ...existing, ...parsed.data };
    const validated = MCPServerConfigSchema.safeParse(merged);
    if (!validated.success) return badRequest(reply, validated.error.issues[0]?.message ?? 'Invalid server definition');

    servers[id] = validated.data;
    writeServers(servers);

    // Disabling a server, or changing what it spawns, makes the running
    // process no longer match its definition. Stop it rather than leave a
    // stale process holding the old command and the old credentials. The
    // replacement starts at the next restart, as the UI says — this only
    // withdraws, never adds.
    const spawnChanged = validated.data.command !== existing.command
      || JSON.stringify(validated.data.args) !== JSON.stringify(existing.args)
      || JSON.stringify(validated.data.env ?? {}) !== JSON.stringify(existing.env ?? {});
    if (validated.data.enabled === false || spawnChanged) {
      await getMCPBridge()?.disconnectServer(id);
    }
    return reply.send({ success: true, server: present(id, validated.data) });
  });

  app.delete('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const servers = readServers();
    if (!servers[id]) return reply.code(404).send({ success: false, error: `MCP server "${id}" not found` });
    delete servers[id];
    writeServers(servers);
    // Revoking a server must be effective immediately. Without this the
    // process kept running with its credentials and its tools stayed callable
    // until the next restart, while the UI showed the server as gone.
    await getMCPBridge()?.disconnectServer(id);
    return reply.send({ success: true });
  });

  /**
   * Dry-run a server: spawn it on its own bridge, read its tool list, shut it
   * down. Deliberately isolated from the running bridge — a test must never
   * change the tool set a live turn is using.
   */
  app.post('/api/mcp/servers/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const servers = readServers();
    const config = servers[id];
    if (!config) return reply.code(404).send({ success: false, error: `MCP server "${id}" not found` });

    const probe = createMCPBridge({ servers: { [id]: { ...config, enabled: true, restart_on_failure: false } } });
    try {
      await probe.start();
      const status = probe.listServers().find(s => s.id === id);
      const tools = probe.listTools();
      return reply.send({
        success: status?.connected ?? false,
        connected: status?.connected ?? false,
        error: status?.lastError ?? null,
        tools: tools.map(tool => ({ name: tool.name, remote_name: tool.remoteName, description: tool.description })),
      });
    } catch (err) {
      return reply.send({
        success: false,
        connected: false,
        error: err instanceof Error ? err.message : String(err),
        tools: [],
      });
    } finally {
      await probe.shutdown().catch(() => {});
    }
  });
}
