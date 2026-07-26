import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerMcpRoutes } from './mcp-routes.js';
import { setMCPBridge } from '../mcp/index.js';
import type { MCPBridge } from '../mcp/bridge.js';

let root = '';
let previousHome: string | undefined;

function makeApp() {
  const app = Fastify();
  registerMcpRoutes(app);
  return app;
}

function storedServers(): Record<string, Record<string, unknown>> {
  const raw = JSON.parse(readFileSync(join(root, 'mozi.json'), 'utf-8'));
  return raw.mcp?.servers ?? {};
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mozi-mcp-api-'));
  previousHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = root;
  writeFileSync(join(root, 'mozi.json'), JSON.stringify({ mcp: { servers: {} } }, null, 2), 'utf-8');
});

afterEach(() => {
  setMCPBridge(null);
  if (previousHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('/api/mcp/servers', () => {
  it('persists a created server to the config file', async () => {
    const app = makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: {
        id: 'files',
        command: 'npx',
        args: ['-y', 'server-filesystem'],
        env: { TOKEN: 'secret-value' },
        permission_level: 'L1_READ_WRITE',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(storedServers().files).toMatchObject({
      command: 'npx',
      permission_level: 'L1_READ_WRITE',
      env: { TOKEN: 'secret-value' },
    });

    const listed = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(listed.json().servers).toHaveLength(1);
    await app.close();
  });

  it('never returns credential values, only their names', async () => {
    // The settings page must be able to show what a server needs without
    // handing every client that can read it the actual secrets.
    const app = makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { id: 'files', command: 'npx', env: { TOKEN: 'secret-value' } },
    });

    const listed = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(listed.payload).not.toContain('secret-value');
    expect(listed.json().servers[0].env_keys).toEqual(['TOKEN']);
    expect(listed.json().servers[0]).not.toHaveProperty('env');
    await app.close();
  });

  it('keeps stored credentials when a patch omits env', async () => {
    // The UI cannot read the values back, so it cannot echo them either. If an
    // omitted `env` cleared the block, editing the command would silently wipe
    // the server's secrets.
    const app = makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { id: 'files', command: 'npx', env: { TOKEN: 'secret-value' } },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/mcp/servers/files',
      payload: { command: 'node' },
    });
    expect(patched.statusCode).toBe(200);
    expect(storedServers().files).toMatchObject({ command: 'node', env: { TOKEN: 'secret-value' } });
    await app.close();
  });

  it('rejects a duplicate id and an id with unusable characters', async () => {
    const app = makeApp();
    await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { id: 'files', command: 'npx' } });

    const duplicate = await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { id: 'files', command: 'npx' } });
    expect(duplicate.statusCode).toBe(409);

    const bad = await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { id: 'my server!', command: 'npx' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('404s on patching or deleting an unknown server', async () => {
    const app = makeApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/mcp/servers/nope', payload: { command: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/mcp/servers/nope' })).statusCode).toBe(404);
    await app.close();
  });

  it('removes a deleted server from the config file', async () => {
    const app = makeApp();
    await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { id: 'files', command: 'npx' } });
    expect((await app.inject({ method: 'DELETE', url: '/api/mcp/servers/files' })).statusCode).toBe(200);
    expect(storedServers()).toEqual({});
    await app.close();
  });
});

describe('/api/mcp/servers live status', () => {
  it('reports connection state from the running bridge', async () => {
    const app = makeApp();
    await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { id: 'files', command: 'npx' } });

    setMCPBridge({
      start: async () => {},
      listTools: () => [],
      callTool: async () => ({ ok: true, content: '' }),
      listServers: () => [{
        id: 'files', connected: true, toolCount: 4,
        permissionLevel: 'L0_READ_ONLY', restarts: 2, lastError: null,
      }],
      shutdown: async () => {},
    } as MCPBridge);

    const listed = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(listed.json().servers[0]).toMatchObject({ connected: true, tool_count: 4, restarts: 2, running: true });
    await app.close();
  });

  it('marks a configured-but-not-started server as pending rather than connected', async () => {
    const app = makeApp();
    await app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { id: 'files', command: 'npx' } });
    const listed = await app.inject({ method: 'GET', url: '/api/mcp/servers' });
    expect(listed.json().servers[0]).toMatchObject({ connected: false, running: false });
    await app.close();
  });
});

describe('/api/mcp/tools', () => {
  it('lists what the model can currently call', async () => {
    const app = makeApp();
    setMCPBridge({
      start: async () => {},
      listTools: () => [{
        name: 'mcp_files_read', serverId: 'files', remoteName: 'read',
        description: 'Read a file', parameters: { type: 'object' },
        permissionLevel: 'L0_READ_ONLY',
      }],
      callTool: async () => ({ ok: true, content: '' }),
      listServers: () => [],
      shutdown: async () => {},
    } as MCPBridge);

    const res = await app.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(res.json()).toMatchObject({
      bridge_running: true,
      tools: [{ name: 'mcp_files_read', server_id: 'files', remote_name: 'read' }],
    });
    await app.close();
  });

  it('reports an empty set when no bridge is running', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(res.json()).toEqual({ tools: [], bridge_running: false });
    await app.close();
  });
});

describe('POST /api/mcp/servers/:id/test', () => {
  it('reports the tools a real server would expose without touching the live set', async () => {
    const app = makeApp();
    const fixture = new URL('../mcp/echo-server.fixture.mjs', import.meta.url).pathname;
    await app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { id: 'proof', command: process.execPath, args: [fixture] },
    });

    const res = await app.inject({ method: 'POST', url: '/api/mcp/servers/proof/test' });
    expect(res.json()).toMatchObject({ success: true, connected: true });
    expect(res.json().tools.map((t: { name: string }) => t.name)).toEqual([
      'mcp_proof_echo_shout',
      'mcp_proof_whoami',
    ]);
    await app.close();
  });

  it('reports a failure instead of throwing when the server cannot start', async () => {
    const app = makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { id: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    });

    const res = await app.inject({ method: 'POST', url: '/api/mcp/servers/broken/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: false, connected: false, tools: [] });
    await app.close();
  });
});
