import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPConfigSchema } from '../mcp/config.js';
import { getDefaultWorkerTransportRegistry } from './transport.js';

const hoisted = vi.hoisted(() => ({
  getConfigMock: vi.fn(() => ({ mcp: { servers: {} } })),
}));

vi.mock('../config/index.js', () => ({
  getConfig: hoisted.getConfigMock,
}));

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('workers/transport', () => {
  beforeEach(() => {
    hoisted.getConfigMock.mockReset();
    hoisted.getConfigMock.mockReturnValue({ mcp: { servers: {} } });
  });

  it('passes stdio launches through without extra artifacts', async () => {
    const prepared = await getDefaultWorkerTransportRegistry().get('stdio')?.prepareLaunch({
      adapter_id: 'claude_code',
      job_id: 'job-160',
      transport: 'stdio',
      command: 'claude',
      args: ['-p', 'hello'],
      env: { TEST: '1' },
      transport_options: {},
    });

    expect(prepared).toEqual({
      command: 'claude',
      args: ['-p', 'hello'],
      cwd: undefined,
      env: { TEST: '1' },
      artifacts: [],
      metadata: { transport: 'stdio' },
    });
  });

  it('generates an MCP config file from inline transport servers', async () => {
    const transport = getDefaultWorkerTransportRegistry().get('mcp');
    const prepared = await transport?.prepareLaunch({
      adapter_id: 'claude_code',
      job_id: 'job-160',
      transport: 'mcp',
      command: 'claude',
      args: ['-p', 'hello'],
      env: { TEST: '1' },
      transport_options: {
        mcp: {
          strict: true,
          servers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@anthropic/mcp-filesystem-server', '/repo'],
            },
          },
        },
      },
      adapter_capabilities: {
        mcp: {
          config_arg: '--mcp-config',
          strict_config_flag: '--strict-mcp-config',
        },
      },
    });

    expect(prepared?.args).toContain('--mcp-config');
    expect(prepared?.args).toContain('--strict-mcp-config');
    expect(prepared?.artifacts).toHaveLength(1);

    const configPath = prepared?.artifacts[0];
    expect(configPath).toBeTruthy();
    tempPaths.push(dirname(configPath!));

    const rawConfig = JSON.parse(readFileSync(configPath!, 'utf-8')) as {
      servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    const parsed = MCPConfigSchema.parse(rawConfig);
    expect(parsed.servers.filesystem.command).toBe('npx');
    expect(rawConfig.servers.filesystem).toEqual({
      command: 'npx',
      args: ['-y', '@anthropic/mcp-filesystem-server', '/repo'],
    });
    expect(prepared?.metadata).toMatchObject({
      transport: 'mcp',
      mcp_generated: true,
      mcp_strict: true,
      mcp_server_ids: ['filesystem'],
    });
  });

  it('reuses an existing MCP config path when provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mozi-worker-transport-'));
    tempPaths.push(dir);
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({
      servers: {
        github: {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-github-server'],
        },
      },
    }), 'utf-8');

    const prepared = await getDefaultWorkerTransportRegistry().get('mcp')?.prepareLaunch({
      adapter_id: 'claude_code',
      job_id: 'job-161',
      transport: 'mcp',
      command: 'claude',
      args: ['-p', 'hello'],
      env: {},
      transport_options: {
        mcp: {
          config_path: configPath,
          strict: false,
        },
      },
      adapter_capabilities: {
        mcp: {
          config_arg: '--mcp-config',
          strict_config_flag: '--strict-mcp-config',
        },
      },
    });

    expect(prepared?.args).toContain(configPath);
    expect(prepared?.artifacts).toEqual([configPath]);
    expect(prepared?.metadata).toMatchObject({
      transport: 'mcp',
      mcp_config_path: configPath,
      mcp_generated: false,
      mcp_server_ids: ['github'],
    });
  });

  it('falls back to globally configured MCP servers when transport config does not inline servers', async () => {
    hoisted.getConfigMock.mockReturnValue({
      mcp: {
        servers: {
          docs: {
            command: 'node',
            args: ['/srv/mcp-docs.js'],
          },
        },
      },
    });

    const prepared = await getDefaultWorkerTransportRegistry().get('mcp')?.prepareLaunch({
      adapter_id: 'claude_code',
      job_id: 'job-162',
      transport: 'mcp',
      command: 'claude',
      args: ['-p', 'hello'],
      env: {},
      transport_options: {},
      adapter_capabilities: {
        mcp: {
          config_arg: '--mcp-config',
          strict_config_flag: '--strict-mcp-config',
        },
      },
    });

    const configPath = prepared?.artifacts[0];
    tempPaths.push(dirname(configPath!));
    const parsed = MCPConfigSchema.parse(JSON.parse(readFileSync(configPath!, 'utf-8')));
    expect(parsed.servers.docs.command).toBe('node');
  });

  it('treats missing global MCP config as an empty server set instead of throwing a TypeError', async () => {
    hoisted.getConfigMock.mockReturnValue({});

    await expect(
      getDefaultWorkerTransportRegistry().get('mcp')?.prepareLaunch({
        adapter_id: 'claude_code',
        job_id: 'job-162c',
        transport: 'mcp',
        command: 'claude',
        args: ['-p', 'hello'],
        env: {},
        transport_options: {},
        adapter_capabilities: {
          mcp: {
            config_arg: '--mcp-config',
            strict_config_flag: '--strict-mcp-config',
          },
        },
      }),
    ).rejects.toThrow(
      'MCP transport requires mcp.servers, mcp.config_path, or configured mcp.servers in MOZI config',
    );
  });

  it('rejects MCP config paths that point to directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mozi-worker-transport-dir-'));
    tempPaths.push(dir);

    await expect(
      getDefaultWorkerTransportRegistry().get('mcp')?.prepareLaunch({
        adapter_id: 'claude_code',
        job_id: 'job-162d',
        transport: 'mcp',
        command: 'claude',
        args: ['-p', 'hello'],
        env: {},
        transport_options: {
          mcp: {
            config_path: dir,
          },
        },
        adapter_capabilities: {
          mcp: {
            config_arg: '--mcp-config',
            strict_config_flag: '--strict-mcp-config',
          },
        },
      }),
    ).rejects.toThrow(`MCP transport config path is not a file: ${dir}`);
  });

  it('rejects MCP transport without inline or global servers', async () => {
    await expect(
      getDefaultWorkerTransportRegistry().get('mcp')?.prepareLaunch({
        adapter_id: 'claude_code',
        job_id: 'job-162b',
        transport: 'mcp',
        command: 'claude',
        args: ['-p', 'hello'],
        env: {},
        transport_options: {},
        adapter_capabilities: {
          mcp: {
            config_arg: '--mcp-config',
            strict_config_flag: '--strict-mcp-config',
          },
        },
      }),
    ).rejects.toThrow(
      'MCP transport requires mcp.servers, mcp.config_path, or configured mcp.servers in MOZI config',
    );
  });

  it('rejects strict MCP mode when the adapter does not advertise strict support', async () => {
    await expect(
      getDefaultWorkerTransportRegistry().get('mcp')?.prepareLaunch({
        adapter_id: 'custom_worker',
        job_id: 'job-163',
        transport: 'mcp',
        command: 'custom-cli',
        args: ['run'],
        env: {},
        transport_options: {
          mcp: {
            strict: true,
            servers: {
              docs: {
                command: 'node',
              },
            },
          },
        },
        adapter_capabilities: {
          mcp: {
            config_arg: '--mcp-config',
          },
        },
      }),
    ).rejects.toThrow('Worker adapter custom_worker does not support strict MCP config');
  });
});
