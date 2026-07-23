import { readConfigWithLegacyFallback, writeConfigObject } from '../config/storage.js';
import { getConfigPath } from '../paths.js';
import { MCPServerConfigSchema, type MCPServerConfig } from './config.js';
import { createMCPBridge } from './bridge.js';

// ---------------------------------------------------------------------------
// CLI: mozi mcp list
// ---------------------------------------------------------------------------

export function cmdMCPList(): void {
  const cfgPath = getConfigPath();
  const { config } = readConfigWithLegacyFallback(cfgPath);
  const mcpConfig = (config.mcp ?? {}) as { servers?: Record<string, MCPServerConfig> };
  const servers = mcpConfig.servers ?? {};
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    console.log('\n  No MCP servers configured.');
    console.log('  Use: mozi mcp add <id> <command> [args...]\n');
    return;
  }

  console.log(`\n  MCP Servers (${entries.length}):\n`);
  console.log('  ID              │ Command                              │ Permission     │ Enabled');
  console.log('  ────────────────┼──────────────────────────────────────┼────────────────┼────────');
  for (const [id, cfg] of entries) {
    const cmdStr = `${cfg.command} ${(cfg.args ?? []).join(' ')}`.slice(0, 36).padEnd(37);
    const perm = (cfg.permission_level ?? 'L0_READ_ONLY').padEnd(15);
    const enabled = cfg.enabled !== false ? 'yes' : 'no';
    console.log(`  ${id.padEnd(16)}│ ${cmdStr}│ ${perm}│ ${enabled}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI: mozi mcp add <id> <command> [args...]
// ---------------------------------------------------------------------------

export function cmdMCPAdd(id: string, command: string, extraArgs: string[]): void {
  const cfgPath = getConfigPath();
  const { config } = readConfigWithLegacyFallback(cfgPath);

  if (!config.mcp) config.mcp = { servers: {} };
  const mcpConfig = config.mcp as { servers: Record<string, unknown> };
  if (!mcpConfig.servers) mcpConfig.servers = {};

  if (mcpConfig.servers[id]) {
    console.error(`\n  MCP server "${id}" already exists. Remove it first: mozi mcp remove ${id}\n`);
    process.exit(1);
  }

  const serverConfig = MCPServerConfigSchema.parse({
    command,
    args: extraArgs,
  });

  mcpConfig.servers[id] = serverConfig;
  writeConfigObject(cfgPath, config);
  console.log(`\n  ✅ MCP server "${id}" added.`);
  console.log(`  Command: ${command} ${extraArgs.join(' ')}`);
  console.log(`  Permission: ${serverConfig.permission_level}`);
  console.log('\n  Restart MOZI to connect.\n');
}

// ---------------------------------------------------------------------------
// CLI: mozi mcp remove <id>
// ---------------------------------------------------------------------------

export function cmdMCPRemove(id: string): void {
  const cfgPath = getConfigPath();
  const { config } = readConfigWithLegacyFallback(cfgPath);
  const mcpConfig = (config.mcp ?? {}) as { servers?: Record<string, unknown> };
  const servers = mcpConfig.servers ?? {};

  if (!servers[id]) {
    console.error(`\n  MCP server "${id}" not found.\n`);
    process.exit(1);
  }

  delete servers[id];
  writeConfigObject(cfgPath, config);
  console.log(`\n  ✅ MCP server "${id}" removed.`);
  console.log('  Restart MOZI for changes to take effect.\n');
}

// ---------------------------------------------------------------------------
// CLI: mozi mcp test <id>
// ---------------------------------------------------------------------------

export async function cmdMCPTest(id: string): Promise<void> {
  const cfgPath = getConfigPath();
  const { config } = readConfigWithLegacyFallback(cfgPath);
  const mcpConfig = (config.mcp ?? {}) as { servers?: Record<string, MCPServerConfig> };
  const servers = mcpConfig.servers ?? {};
  const serverConfig = servers[id];

  if (!serverConfig) {
    console.error(`\n  MCP server "${id}" not found.\n`);
    process.exit(1);
  }

  console.log(`\n  Testing MCP server "${id}"...`);
  console.log(`  Command: ${serverConfig.command} ${(serverConfig.args ?? []).join(' ')}`);

  const bridge = createMCPBridge({
    servers: { [id]: serverConfig },
  });

  try {
    await bridge.start();
    const statuses = bridge.listServers();
    const status = statuses[0];

    if (!status?.connected) {
      console.error('  ❌ Failed to connect.\n');
      await bridge.shutdown();
      process.exit(1);
    }

    const tools = bridge.getTools();
    const toolNames = Object.keys(tools);

    console.log(`  ✅ Connected (${toolNames.length} tools):`);
    for (const name of toolNames) {
      // Strip the mcp_{id}_ prefix for display
      const shortName = name.replace(`mcp_${id}_`, '');
      console.log(`     - ${shortName}`);
    }
    console.log('');

    await bridge.shutdown();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Error: ${msg}\n`);
    await bridge.shutdown().catch(() => {});
    process.exit(1);
  }
}
