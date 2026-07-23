import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { loadConfig } from '../config/index.js';
import { readConfigWithLegacyFallback } from '../config/storage.js';
import { getConfigPath } from '../paths.js';
vi.mock('../onboarding/coding-workers.js', () => ({
  detectCodingWorkers: () => [
    { id: 'codex_cli', installHint: 'npm install -g @openai/codex', authHint: 'Run: codex login' },
    { id: 'claude_code', installHint: 'npm install -g @anthropic-ai/claude-code', authHint: 'Run: claude login' },
  ],
}));
vi.mock('../workers/index.js', () => ({
  getDefaultWorkerAdapterRegistry: () => ({ get: (id: string) => ({ metadata: { id } }) }),
}));
vi.mock('../workers/preflight.js', () => ({
  inspectManagedWorkerPreflight: vi.fn(),
  inspectWorkerAdapterLaneReadiness: async (adapter: { metadata: { id: string } }) => adapter.metadata.id === 'codex_cli'
    ? { status: 'ready', command_path: '/opt/homebrew/bin/codex', summary: 'Managed worker ready', checks: [{ id: 'command', ok: true }, { id: 'auth', ok: true }] }
    : { status: 'blocked', command_path: '/opt/homebrew/bin/claude', summary: 'Claude CLI reports no authenticated session', checks: [{ id: 'command', ok: true }, { id: 'auth', ok: false }] },
}));
import { registerApiRoutes } from './application-routes.js';
import { getAllRegisteredTools } from '../tools/dynamic-registry.js';
describe('coding worker settings routes', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let savedMoziHome: string | undefined;
  beforeAll(async () => {
    ({ tmpDir } = setupTestDb());
    savedMoziHome = process.env.MOZI_HOME;
    process.env.MOZI_HOME = join(tmpDir, 'home');
    loadConfig(getConfigPath());
    app = Fastify();
    await registerApiRoutes(app, {
      jwtSecret: 'test-secret',
      config: {
        server: { auth_mode: 'none' }, security: { enterprise: {} },
        http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
      },
    });
  });
  afterAll(async () => {
    await app.close();
    teardownTestDb(tmpDir);
    if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = savedMoziHome;
  });
  it('reports readiness, persists activation, and rejects invalid ids', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/coding-workers' });
    expect(response.statusCode).toBe(200);
    expect(response.json().workers).toEqual([
      { id: 'codex_cli', installed: true, authed: true, ready: true, commandPath: '/opt/homebrew/bin/codex', remediation: null },
      { id: 'claude_code', installed: true, authed: false, ready: false, commandPath: '/opt/homebrew/bin/claude', remediation: 'Run: claude login' },
    ]);
    expect(response.json().config).toEqual({ routing: 'auto', available: [] });
    const saved = await app.inject({
      method: 'PUT', url: '/api/coding-workers',
      payload: { routing: 'codex_cli', available: ['codex_cli'] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ config: { routing: 'codex_cli', available: ['codex_cli'] } });
    expect(readConfigWithLegacyFallback(getConfigPath()).config.coding_worker).toEqual(saved.json().config);
    expect((await app.inject({ method: 'GET', url: '/api/coding-workers' })).json().config).toEqual(saved.json().config);
    expect(getAllRegisteredTools().map((tool) => tool.function.name)).toContain('delegate_coding_task');
    for (const payload of [
      { routing: 'auto', available: ['gemini_cli'] },
      { routing: 'claude_code', available: ['codex_cli'] },
    ]) {
      expect((await app.inject({ method: 'PUT', url: '/api/coding-workers', payload })).statusCode).toBe(400);
    }
  });
});
