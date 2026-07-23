import { describe, it, expect } from 'vitest';
import { MCPServerConfigSchema, MCPConfigSchema } from './config.js';

describe('MCPServerConfigSchema', () => {
  it('parses valid config with all fields', () => {
    const result = MCPServerConfigSchema.parse({
      command: 'npx',
      args: ['-y', '@anthropic/mcp-filesystem-server', '/home'],
      env: { GITHUB_TOKEN: 'abc123' },
      permission_level: 'L1_READ_WRITE',
      enabled: true,
      restart_on_failure: true,
      max_restarts: 5,
    });

    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@anthropic/mcp-filesystem-server', '/home']);
    expect(result.env).toEqual({ GITHUB_TOKEN: 'abc123' });
    expect(result.permission_level).toBe('L1_READ_WRITE');
    expect(result.enabled).toBe(true);
    expect(result.restart_on_failure).toBe(true);
    expect(result.max_restarts).toBe(5);
  });

  it('applies defaults for optional fields', () => {
    const result = MCPServerConfigSchema.parse({
      command: 'node',
    });

    expect(result.command).toBe('node');
    expect(result.args).toEqual([]);
    expect(result.env).toBeUndefined();
    expect(result.permission_level).toBe('L0_READ_ONLY');
    expect(result.enabled).toBe(true);
    expect(result.restart_on_failure).toBe(true);
    expect(result.max_restarts).toBe(3);
  });

  it('rejects invalid permission level', () => {
    expect(() => MCPServerConfigSchema.parse({
      command: 'node',
      permission_level: 'INVALID',
    })).toThrow();
  });

  it('rejects missing command', () => {
    expect(() => MCPServerConfigSchema.parse({})).toThrow();
  });
});

describe('MCPConfigSchema', () => {
  it('parses config with multiple servers', () => {
    const result = MCPConfigSchema.parse({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-filesystem-server', '/home'],
          permission_level: 'L1_READ_WRITE',
        },
        github: {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-github-server'],
          env: { GITHUB_TOKEN: 'token' },
          permission_level: 'L1_READ_WRITE',
        },
      },
    });

    expect(Object.keys(result.servers)).toHaveLength(2);
    expect(result.servers.filesystem.command).toBe('npx');
    expect(result.servers.github.env?.GITHUB_TOKEN).toBe('token');
  });

  it('defaults to empty servers object', () => {
    const result = MCPConfigSchema.parse({});
    expect(result.servers).toEqual({});
  });

  it('parses empty servers object', () => {
    const result = MCPConfigSchema.parse({ servers: {} });
    expect(result.servers).toEqual({});
  });
});
