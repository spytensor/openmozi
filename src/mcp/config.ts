import { z } from 'zod';

// ---------------------------------------------------------------------------
// MCP Server Configuration Schema
// ---------------------------------------------------------------------------

export const MCPServerConfigSchema = z.object({
  /** Command to spawn the MCP server process (e.g. "npx", "node") */
  command: z.string(),
  /** Arguments passed to the command (e.g. ["-y", "@anthropic/mcp-filesystem-server", "/home"]) */
  args: z.array(z.string()).default([]),
  /** Environment variables for the server process */
  env: z.record(z.string(), z.string()).optional(),
  /** Permission level for all tools from this server */
  permission_level: z.enum([
    'L0_READ_ONLY',
    'L1_READ_WRITE',
    'L2_SHELL_EXEC',
    'L3_FULL_ACCESS',
  ]).default('L0_READ_ONLY'),
  /** Whether this server is enabled */
  enabled: z.boolean().default(true),
  /** Auto-restart on unexpected exit */
  restart_on_failure: z.boolean().default(true),
  /** Maximum restart attempts before giving up */
  max_restarts: z.number().int().min(0).default(3),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const MCPConfigSchema = z.object({
  /** Map of server ID to server configuration */
  servers: z.record(z.string(), MCPServerConfigSchema).default({}),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;
