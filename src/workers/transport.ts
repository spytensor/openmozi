import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { MCPConfigSchema, MCPServerConfigSchema } from '../mcp/config.js';

export const WorkerTransportKindSchema = z.enum(['stdio', 'mcp']);
export type WorkerTransportKind = z.infer<typeof WorkerTransportKindSchema>;

export const ExternalWorkerMCPTransportConfigSchema = z.object({
  config_path: z.string().optional(),
  strict: z.boolean().default(false),
  servers: z.record(z.string(), MCPServerConfigSchema).default({}),
});
export type ExternalWorkerMCPTransportConfig = z.infer<typeof ExternalWorkerMCPTransportConfigSchema>;

export const ExternalWorkerTransportOptionsSchema = z.object({
  mcp: ExternalWorkerMCPTransportConfigSchema.optional(),
}).default({});
export type ExternalWorkerTransportOptions = z.infer<typeof ExternalWorkerTransportOptionsSchema>;

export interface WorkerTransportCapabilities {
  mcp?: {
    config_arg: string;
    strict_config_flag?: string;
  };
}

export interface WorkerTransportLaunchContext {
  adapter_id: string;
  job_id: string;
  transport: WorkerTransportKind;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  transport_options: ExternalWorkerTransportOptions;
  adapter_capabilities?: WorkerTransportCapabilities;
}

export interface PreparedWorkerTransportLaunch {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  artifacts: string[];
  metadata: Record<string, unknown>;
}

export interface WorkerTransport {
  readonly id: WorkerTransportKind;
  prepareLaunch(context: WorkerTransportLaunchContext): Promise<PreparedWorkerTransportLaunch>;
}

type ResolvedMCPConfig = {
  config_path: string;
  server_ids: string[];
  generated: boolean;
  strict: boolean;
};

function parseExistingMCPConfig(configPath: string): ResolvedMCPConfig {
  if (!existsSync(configPath)) {
    throw new Error(`MCP transport config path does not exist: ${configPath}`);
  }
  if (!statSync(configPath).isFile()) {
    throw new Error(`MCP transport config path is not a file: ${configPath}`);
  }

  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read MCP transport config: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid MCP transport config JSON: ${message}`);
  }

  const parsed = MCPConfigSchema.parse(parsedJson);
  return {
    config_path: configPath,
    server_ids: Object.keys(parsed.servers),
    generated: false,
    strict: false,
  };
}

function resolveMCPConfig(context: WorkerTransportLaunchContext): ResolvedMCPConfig {
  const options = context.transport_options.mcp;

  if (options?.config_path) {
    const resolved = parseExistingMCPConfig(options.config_path);
    return {
      ...resolved,
      strict: options.strict,
    };
  }

  const inlineServers = options?.servers ?? {};
  const globalServers = getConfig()?.mcp?.servers ?? {};
  const mergedConfig = MCPConfigSchema.parse({
    servers: Object.keys(inlineServers).length > 0 ? inlineServers : globalServers,
  });

  if (Object.keys(mergedConfig.servers).length === 0) {
    throw new Error(
      'MCP transport requires mcp.servers, mcp.config_path, or configured mcp.servers in MOZI config',
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'mozi-worker-mcp-'));
  const configPath = join(dir, `${context.adapter_id}-${context.job_id}.json`);
  const standardConfig = {
    servers: Object.fromEntries(
      Object.entries(mergedConfig.servers).map(([id, server]) => [
        id,
        {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        },
      ]),
    ),
  };
  writeFileSync(configPath, `${JSON.stringify(standardConfig, null, 2)}\n`, 'utf-8');

  return {
    config_path: configPath,
    server_ids: Object.keys(mergedConfig.servers),
    generated: true,
    strict: options?.strict ?? false,
  };
}

class StdioWorkerTransport implements WorkerTransport {
  readonly id = 'stdio' as const;

  async prepareLaunch(context: WorkerTransportLaunchContext): Promise<PreparedWorkerTransportLaunch> {
    return {
      command: context.command,
      args: [...context.args],
      cwd: context.cwd,
      env: { ...context.env },
      artifacts: [],
      metadata: {
        transport: this.id,
      },
    };
  }
}

class MCPWorkerTransport implements WorkerTransport {
  readonly id = 'mcp' as const;

  async prepareLaunch(context: WorkerTransportLaunchContext): Promise<PreparedWorkerTransportLaunch> {
    const capability = context.adapter_capabilities?.mcp;
    if (!capability?.config_arg) {
      throw new Error(`Worker adapter ${context.adapter_id} does not expose MCP launch capabilities`);
    }

    const resolved = resolveMCPConfig(context);
    const args = [...context.args, capability.config_arg, resolved.config_path];

    if (resolved.strict) {
      if (!capability.strict_config_flag) {
        throw new Error(`Worker adapter ${context.adapter_id} does not support strict MCP config`);
      }
      args.push(capability.strict_config_flag);
    }

    return {
      command: context.command,
      args,
      cwd: context.cwd,
      env: { ...context.env },
      artifacts: [resolved.config_path],
      metadata: {
        transport: this.id,
        mcp_config_path: resolved.config_path,
        mcp_config_dir: dirname(resolved.config_path),
        mcp_generated: resolved.generated,
        mcp_server_ids: resolved.server_ids,
        mcp_strict: resolved.strict,
      },
    };
  }
}

export class WorkerTransportRegistry {
  private readonly transports = new Map<WorkerTransportKind, WorkerTransport>();

  constructor(initialTransports: WorkerTransport[] = []) {
    for (const transport of initialTransports) {
      this.register(transport);
    }
  }

  register(transport: WorkerTransport): void {
    this.transports.set(transport.id, transport);
  }

  get(id: WorkerTransportKind): WorkerTransport | null {
    return this.transports.get(id) ?? null;
  }

  list(): WorkerTransportKind[] {
    return [...this.transports.keys()];
  }
}

const defaultWorkerTransportRegistry = new WorkerTransportRegistry([
  new StdioWorkerTransport(),
  new MCPWorkerTransport(),
]);

export function getDefaultWorkerTransportRegistry(): WorkerTransportRegistry {
  return defaultWorkerTransportRegistry;
}
