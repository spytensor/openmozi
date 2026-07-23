import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './index.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

describe('server config', () => {
  let tmpDir: string;
  let configPath: string;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mozi-cfg-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'config.yaml');

    // Save MOZI_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MOZI_')) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('defaults: auth_mode is token, auth_token is undefined, and host binds localhost', () => {
    const config = loadConfig(configPath);
    expect(config.server.auth_mode).toBe('token');
    expect(config.server.auth_token).toBeUndefined();
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(9210);
  });

  it('loads auth_token from config file', () => {
    writeFileSync(configPath, yaml.dump({
      server: { auth_token: 'my-secret-token', auth_mode: 'token' },
    }));
    const config = loadConfig(configPath);
    expect(config.server.auth_token).toBe('my-secret-token');
    expect(config.server.auth_mode).toBe('token');
  });

  it('loads custom port and host', () => {
    writeFileSync(configPath, yaml.dump({
      server: { host: '127.0.0.1', port: 8080 },
    }));
    const config = loadConfig(configPath);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(8080);
  });

  it('accepts enterprise auth modes and registration policy', () => {
    writeFileSync(configPath, yaml.dump({
      server: { auth_mode: 'local' },
      security: { registration: 'open' },
    }));
    const config = loadConfig(configPath);
    expect(config.server.auth_mode).toBe('local');
    expect(config.security.registration).toBe('open');
  });

  it('maps MOZI_SERVER_REGISTRATION to security.registration', () => {
    process.env.MOZI_SERVER_AUTH_MODE = 'local';
    process.env.MOZI_SERVER_REGISTRATION = 'closed';
    const config = loadConfig(configPath);
    expect(config.server.auth_mode).toBe('local');
    expect(config.security.registration).toBe('closed');
  });

  it('rejects invalid auth_mode', () => {
    writeFileSync(configPath, yaml.dump({
      server: { auth_mode: 'invalid' },
    }));
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('auth_mode defaults to token when not specified', () => {
    writeFileSync(configPath, yaml.dump({
      server: { port: 9000 },
    }));
    const config = loadConfig(configPath);
    expect(config.server.auth_mode).toBe('token');
  });
});
