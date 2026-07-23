import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyPairingRoles, registerApiRoutes, shouldUseSecureCookie } from './api-routes.js';
import { getConfigPath, getMasterKeyPath } from './paths.js';
import { loadConfig } from './config/index.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { sign as jwtSign } from './security/jwt.js';
import { AUTH_COOKIE_NAME } from './security/api-auth.js';
import { addAllowedUser } from './security/pairing.js';
import { getSessionHistory, saveMessage } from './memory/conversations.js';
import { beginContextCheckpoint } from './memory/context-checkpoints.js';
import { saveFact } from './memory/long-term.js';
import { getDb } from './store/db.js';
import { saveTimelineItem } from './memory/session-timeline.js';
import { createSession, getSession } from './memory/sessions.js';
import {
  approveRequest,
  createApprovalRequest,
  resetTableFlag as resetApprovalTableFlag,
} from './security/gates.js';
import { resetTenantKeysTableFlag } from './security/tenant-keys.js';
import { getSecret, resolveMasterKey } from './security/secrets.js';
import { createLocalUser, getUserById } from './security/users.js';
import { getOnboardingStatus } from './security/onboarding.js';
import { assignRole } from './security/rbac.js';

const routeMocks = vi.hoisted(() => ({
  checkProviderHealth: vi.fn(),
  detectCodingWorkers: vi.fn(() => [] as Array<Record<string, unknown>>),
}));

vi.mock('./onboarding/index.js', () => ({
  checkProviderHealth: routeMocks.checkProviderHealth,
}));

vi.mock('./onboarding/coding-workers.js', () => ({
  detectCodingWorkers: routeMocks.detectCodingWorkers,
}));

describe('api route auth helpers', () => {
  it('maps legacy pairing owner roles to admin JWT roles', () => {
    expect(legacyPairingRoles('owner')).toEqual(['admin']);
    expect(legacyPairingRoles('admin')).toEqual(['admin']);
  });

  it('maps legacy pairing users to operator JWT roles', () => {
    expect(legacyPairingRoles('user')).toEqual(['operator']);
    expect(legacyPairingRoles('operator')).toEqual(['operator']);
    expect(legacyPairingRoles(undefined)).toEqual(['operator']);
  });

  it('preserves explicit viewer role', () => {
    expect(legacyPairingRoles('viewer')).toEqual(['viewer']);
  });

  it('uses secure cookies only for https requests', () => {
    expect(shouldUseSecureCookie({
      headers: {},
      protocol: 'http',
    } as FastifyRequest)).toBe(false);

    expect(shouldUseSecureCookie({
      headers: { 'x-forwarded-proto': 'https' },
      protocol: 'http',
    } as unknown as FastifyRequest)).toBe(true);
  });

  it('returns runtime identity from health', async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-health-'));
    process.env.MOZI_HOME = moziHome;
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const payload = response.json() as { ok: boolean; pid: number; mozi_home: string; config_path: string; version: string; commit: string; surface: string };

      expect(response.statusCode).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.pid).toBe(process.pid);
      expect(payload.mozi_home).toBe(moziHome);
      expect(payload.config_path).toBe(getConfigPath());
      expect(payload.version).toBe('0.0.0-dev');
      expect(payload.commit).toBe('unknown');
      expect(payload.surface).toBe('source');

      const version = await app.inject({ method: 'GET', url: '/api/version' });
      expect(version.statusCode).toBe(200);
      expect(version.json()).toMatchObject({ version: '0.0.0-dev', channel: 'dev', surface: 'source' });
    } finally {
      await app.close();
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
    }
  });

  it('exposes explicit runtime service controls', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    let status:
      | { installed: false; platform: 'darwin' }
      | { installed: true; platform: 'darwin'; unitPath: string; active: boolean; enabled: boolean } = {
        installed: false,
        platform: 'darwin',
      };
    const getStatus = vi.fn(async () => status);
    const install = vi.fn(async () => {
      status = {
        installed: true,
        platform: 'darwin',
        unitPath: '/Users/u/Library/LaunchAgents/ai.mozi.agent.plist',
        active: true,
        enabled: true,
      };
      return {
        ok: true as const,
        platform: 'darwin' as const,
        unitPath: status.unitPath,
        started: true,
        logPath: '/Users/u/Library/Application Support/MOZI/logs/mozi.log',
      };
    });
    const uninstall = vi.fn(async () => {
      status = { installed: false, platform: 'darwin' };
      return {
        ok: true as const,
        unitPath: '/Users/u/Library/LaunchAgents/ai.mozi.agent.plist',
      };
    });

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
        runtimeService: { getStatus, install, uninstall },
      });

      const initial = await app.inject({ method: 'GET', url: '/api/runtime/service' });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({ installed: false, platform: 'darwin' });

      const enabled = await app.inject({
        method: 'POST',
        url: '/api/runtime/service',
        payload: { action: 'enable' },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({
        ok: true,
        action: 'enable',
        status: { installed: true, active: true, enabled: true },
      });
      expect(install).toHaveBeenCalledTimes(1);

      const disabled = await app.inject({
        method: 'POST',
        url: '/api/runtime/service',
        payload: { action: 'disable' },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({
        ok: true,
        action: 'disable',
        status: { installed: false, platform: 'darwin' },
      });
      expect(uninstall).toHaveBeenCalledTimes(1);

      const badAction = await app.inject({
        method: 'POST',
        url: '/api/runtime/service',
        payload: { action: 'maybe' },
      });
      expect(badAction.statusCode).toBe(400);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('auto-authenticates local API routes in auth_mode none', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const initialStatus = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(initialStatus.statusCode).toBe(200);
      expect(initialStatus.json()).toMatchObject({
        authenticated: true,
        onboarding_done: false,
      });

      const complete = await app.inject({
        method: 'POST',
        url: '/api/onboarding/complete',
        payload: { name: 'Local User' },
      });
      expect(complete.statusCode).toBe(200);
      expect(complete.json()).toMatchObject({
        success: true,
        status: { completed: true, workspace_initialized: true },
      });

      const readyStatus = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(readyStatus.statusCode).toBe(200);
      expect(readyStatus.json()).toMatchObject({
        authenticated: true,
        onboarding_done: true,
      });

      const me = await app.inject({ method: 'GET', url: '/api/users/me' });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        user: {
          id: 'local-user',
          tenant_id: 'default',
          auth_provider: 'local',
          role: 'admin',
        },
      });

      const users = await app.inject({ method: 'GET', url: '/api/users' });
      expect(users.statusCode).toBe(200);
      expect(users.json()).toMatchObject({
        users: [
          {
            id: 'local-user',
            tenant_id: 'default',
            role: 'admin',
          },
        ],
      });
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('does not mint a web auth cookie from status for paired token-mode users', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      addAllowedUser('owner-user', 'owner', 'owner', 'default');

      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'token', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({ method: 'GET', url: '/api/auth/status' });
      const setCookie = response.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        authenticated: false,
        paired: true,
      });
      expect(cookies.some(cookie => String(cookie).startsWith(`${AUTH_COOKIE_NAME}=`))).toBe(false);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('checks providers with API keys saved through the Settings UI key store', async () => {
    const { tmpDir } = setupTestDb();
    resetTenantKeysTableFlag();
    const savedMoziHome = process.env.MOZI_HOME;
    const savedMasterPassword = process.env.MOZI_MASTER_PASSWORD;
    // The assertion is "UI-stored key wins when no env key exists" — a real
    // DEEPSEEK_API_KEY leaking in from .env (vitest loads dotenv) would win
    // instead, so isolate it for this test's scope.
    const savedDeepseekKey = process.env.DEEPSEEK_API_KEY;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-provider-key-'));
    process.env.MOZI_HOME = moziHome;
    delete process.env.MOZI_MASTER_PASSWORD;
    delete process.env.DEEPSEEK_API_KEY;
    const app = Fastify();
    routeMocks.checkProviderHealth.mockResolvedValueOnce(true);

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const saved = await app.inject({
        method: 'POST',
        url: '/api/keys/deepseek',
        payload: { key: 'sk-deepseek-ui-key' },
      });
      expect(saved.statusCode).toBe(200);
      expect(existsSync(getMasterKeyPath())).toBe(true);

      const checked = await app.inject({
        method: 'POST',
        url: '/api/providers/deepseek/check',
        payload: { model: 'deepseek-v4-flash' },
      });

      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ ok: true, model: 'deepseek-v4-flash' });
      expect(routeMocks.checkProviderHealth).toHaveBeenCalledWith(expect.objectContaining({
        id: 'deepseek',
        apiKey: 'sk-deepseek-ui-key',
      }));
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      if (savedMasterPassword === undefined) delete process.env.MOZI_MASTER_PASSWORD;
      else process.env.MOZI_MASTER_PASSWORD = savedMasterPassword;
      if (savedDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedDeepseekKey;
      routeMocks.checkProviderHealth.mockReset();
    }
  });

  it('stores the Search1API key from Settings when no secret master key exists yet', async () => {
    const { tmpDir } = setupTestDb();
    const savedMoziHome = process.env.MOZI_HOME;
    const savedMasterPassword = process.env.MOZI_MASTER_PASSWORD;
    const savedSearchKey = process.env.SEARCH1API_KEY;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-search-key-'));
    process.env.MOZI_HOME = moziHome;
    delete process.env.MOZI_MASTER_PASSWORD;
    delete process.env.SEARCH1API_KEY;
    const app = Fastify();

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const saved = await app.inject({
        method: 'POST',
        url: '/api/search-key',
        payload: { key: 'search1api-ui-key' },
      });

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ success: true, configured: true });
      expect(existsSync(getMasterKeyPath())).toBe(true);
      const masterKey = resolveMasterKey();
      expect(masterKey).not.toBeNull();
      expect(getSecret('SEARCH1API_KEY', masterKey!)).toBe('search1api-ui-key');
      expect(process.env.SEARCH1API_KEY).toBe('search1api-ui-key');
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      if (savedMasterPassword === undefined) delete process.env.MOZI_MASTER_PASSWORD;
      else process.env.MOZI_MASTER_PASSWORD = savedMasterPassword;
      if (savedSearchKey === undefined) delete process.env.SEARCH1API_KEY;
      else process.env.SEARCH1API_KEY = savedSearchKey;
    }
  });

  it('updates model role slots, persists config, and reflects them on GET', async () => {
    const { tmpDir } = setupTestDb();
    const savedMoziHome = process.env.MOZI_HOME;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-model-roles-'));
    process.env.MOZI_HOME = moziHome;
    process.env.OPENAI_API_KEY = 'sk-openai-roles-test';
    const app = Fastify();

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        payload: {
          brain: { provider: 'openai', model: 'gpt-4.1-mini' },
          light: { provider: 'openai', model: 'gpt-4.1-mini' },
          step: { provider: 'openai', model: 'gpt-4.1-mini' },
          plan_summary: { provider: 'openai', model: 'gpt-4.1-mini' },
          embedding: { provider: 'openai', model: 'text-embedding-3-small' },
        },
      });

      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        success: true,
        roles: {
          brain: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
          light: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
          step: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
          plan_summary: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
          embedding: { provider: 'openai', model: 'text-embedding-3-small', ready: true },
        },
      });

      const got = await app.inject({ method: 'GET', url: '/api/models/roles' });
      expect(got.statusCode).toBe(200);
      expect(got.json()).toMatchObject({
        brain: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
        light: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
        embedding: { provider: 'openai', model: 'text-embedding-3-small', ready: true },
      });

      const persisted = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as {
        brain?: { model?: string };
        model_router?: { brain_provider?: string };
        models?: { light?: { provider?: string; model?: string } };
        memory?: { embedding?: { provider?: string; model?: string } };
      };
      expect(persisted.brain?.model).toBe('gpt-4.1-mini');
      expect(persisted.model_router?.brain_provider).toBe('openai');
      expect(persisted.models?.light).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
      expect(persisted.memory?.embedding).toMatchObject({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });

      const inherited = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        payload: { step: null, plan_summary: null },
      });
      expect(inherited.statusCode).toBe(200);
      expect(inherited.json()).toMatchObject({
        roles: {
          step: { provider: '', model: '', ready: true, inherit: true },
          plan_summary: { provider: '', model: '', ready: true, inherit: true },
        },
      });

      const invalid = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        payload: { embedding: { provider: 'bogus' } },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('supports the onboarding profile-model-marker sequence while preserving model RBAC', async () => {
    const { tmpDir } = setupTestDb();
    const savedMoziHome = process.env.MOZI_HOME;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-onboarding-wiring-'));
    process.env.MOZI_HOME = moziHome;
    process.env.OPENAI_API_KEY = 'sk-openai-onboarding-test';
    const app = Fastify();
    const jwtSecret = 'test-secret';
    const tenantId = 'tenant-onboarding';

    try {
      const admin = createLocalUser({
        tenant_id: tenantId,
        email: 'admin-onboarding@example.com',
        name: 'Before Admin',
        password_hash: null,
        role: 'admin',
      });
      const viewer = createLocalUser({
        tenant_id: tenantId,
        email: 'viewer-onboarding@example.com',
        name: 'Before Viewer',
        password_hash: null,
        role: 'viewer',
      });
      assignRole(tenantId, admin.id, 'admin', 'test');
      assignRole(tenantId, viewer.id, 'viewer', 'test');
      addAllowedUser(admin.id, admin.email, 'owner', tenantId);
      addAllowedUser(viewer.id, viewer.email, 'viewer', tenantId);
      const adminHeaders = {
        authorization: `Bearer ${jwtSign(admin.id, jwtSecret, 3600, { tenant_id: tenantId, roles: ['admin'] })}`,
      };
      const viewerHeaders = {
        authorization: `Bearer ${jwtSign(viewer.id, jwtSecret, 3600, { tenant_id: tenantId, roles: ['viewer'] })}`,
      };

      await registerApiRoutes(app, {
        jwtSecret,
        config: {
          server: { auth_mode: 'token', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const profile = await app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: adminHeaders,
        payload: { name: 'Wired Admin' },
      });
      expect(profile.statusCode).toBe(200);

      const rolesPatch = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        headers: adminHeaders,
        payload: { brain: { provider: 'openai', model: 'gpt-4.1-mini' } },
      });
      expect(rolesPatch.statusCode).toBe(200);

      const completed = await app.inject({
        method: 'POST',
        url: '/api/onboarding/complete',
        headers: adminHeaders,
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ success: true, status: { completed: true } });

      const persistedProfile = await app.inject({ method: 'GET', url: '/api/users/me', headers: adminHeaders });
      expect(persistedProfile.json()).toMatchObject({ user: { name: 'Wired Admin', role: 'admin' } });
      const persistedRoles = await app.inject({ method: 'GET', url: '/api/models/roles', headers: adminHeaders });
      expect(persistedRoles.json()).toMatchObject({
        brain: { provider: 'openai', model: 'gpt-4.1-mini', ready: true },
      });
      expect(getUserById(admin.id, tenantId)?.name).toBe('Wired Admin');
      expect(getOnboardingStatus(admin.id, tenantId).completed).toBe(true);

      const forbiddenViewerWrite = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        headers: viewerHeaders,
        payload: { brain: { provider: 'openai', model: 'gpt-4.1-mini' } },
      });
      expect(forbiddenViewerWrite.statusCode).toBe(403);
      const viewerCompleted = await app.inject({
        method: 'POST',
        url: '/api/onboarding/complete',
        headers: viewerHeaders,
      });
      expect(viewerCompleted.statusCode).toBe(200);
      expect(getOnboardingStatus(viewer.id, tenantId).completed).toBe(true);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('accepts ready Codex/Claude CLI role assignments and still rejects Gemini CLI', async () => {
    const { tmpDir } = setupTestDb();
    const savedMoziHome = process.env.MOZI_HOME;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-cli-role-ineligible-'));
    process.env.MOZI_HOME = moziHome;
    process.env.OPENAI_API_KEY = ['sk', 'openai-cli-fallback-test'].join('-');
    routeMocks.detectCodingWorkers.mockReturnValue([
      {
        id: 'claude_code',
        name: 'Claude Code',
        command: 'claude',
        installed: true,
        commandPath: '/opt/homebrew/bin/claude',
        version: '2.1.191',
        authorized: true,
        authHint: '',
        installHint: '',
      },
      {
        id: 'codex_cli',
        name: 'Codex CLI',
        command: 'codex',
        installed: true,
        commandPath: '/opt/homebrew/bin/codex',
        version: '0.144.6',
        authorized: true,
        authHint: '',
        installHint: '',
      },
    ]);
    writeFileSync(getConfigPath(), JSON.stringify({
      brain: { model: '_cli-default' },
      model_router: { brain_provider: 'claude-cli' },
    }));
    loadConfig(getConfigPath());
    const app = Fastify();

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const roles = await app.inject({ method: 'GET', url: '/api/models/roles' });
      expect(roles.statusCode).toBe(200);
      expect(roles.json()).toMatchObject({
        brain: {
          provider: 'claude-cli',
          model: '_cli-default',
          ready: true,
          eligible: true,
        },
      });

      const providers = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(providers.statusCode).toBe(200);
      const providerPayload = providers.json() as { providers: Array<{ id: string; apiMode: string; brainEligible: boolean; lightEligible: boolean }> };
      expect(providerPayload.providers.find((provider) => provider.id === 'claude-cli')).toMatchObject({
        brainEligible: true,
        lightEligible: true,
      });
      expect(providerPayload.providers.find((provider) => provider.id === 'codex-cli')).toMatchObject({
        brainEligible: true,
        lightEligible: true,
      });
      expect(providerPayload.providers.find((provider) => provider.id === 'gemini-cli')).toBeUndefined();
      expect(providerPayload.providers.find((provider) => provider.id === 'openai')).toMatchObject({
        brainEligible: true,
        lightEligible: true,
      });

      const patchBrain = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        payload: { brain: { provider: 'codex-cli', model: 'gpt-5.3-codex' } },
      });
      expect(patchBrain.statusCode).toBe(200);
      expect(patchBrain.json()).toMatchObject({
        success: true,
        roles: { brain: { provider: 'codex-cli', model: 'gpt-5.3-codex', ready: true } },
      });
      expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
        brain: { model: 'gpt-5.3-codex' },
        model_router: { brain_provider: 'codex-cli' },
      });

      const patchLight = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        payload: { light: { provider: 'claude-cli', model: 'sonnet' } },
      });
      expect(patchLight.statusCode).toBe(200);
      expect(patchLight.json()).toMatchObject({
        success: true,
        roles: { light: { provider: 'claude-cli', model: 'sonnet', ready: true } },
      });

      const postBrain = await app.inject({
        method: 'POST',
        url: '/api/brain',
        payload: { provider: 'gemini-cli', model: '_cli-default' },
      });
      expect(postBrain.statusCode).toBe(400);
      expect(postBrain.json()).toMatchObject({ success: false });
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      routeMocks.detectCodingWorkers.mockReturnValue([]);
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('returns mixed persisted session timeline rows in chronological order', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      saveTimelineItem({
        tenantId: 'default',
        sessionId: 'session-restore',
        chatId: 'local-user',
        type: 'artifact',
        eventKey: 'artifact:report-1',
        timestamp: 400,
        data: {
          id: 'report-1',
          title: 'Runtime report',
          status: 'completed',
          data: { summary: 'done' },
          timestamp: 400,
        },
      });
      saveTimelineItem({
        tenantId: 'default',
        sessionId: 'session-restore',
        chatId: 'local-user',
        type: 'message',
        eventKey: 'turn:turn-1:message:user',
        timestamp: 100,
        data: {
          id: 'msg_turn-1_user',
          role: 'user',
          content: 'Research OpenClaw',
          timestamp: 100,
        },
      });
      saveTimelineItem({
        tenantId: 'default',
        sessionId: 'session-restore',
        chatId: 'local-user',
        type: 'tool_event',
        eventKey: 'tool:call-1',
        timestamp: 300,
        data: {
          id: 'tool_call-1',
          callId: 'call-1',
          tool: 'browser_extract',
          phase: 'end',
          status: 'success',
          intent: 'Verify persisted browser timeline',
          timestamp: 350,
        },
      });
      saveTimelineItem({
        tenantId: 'default',
        sessionId: 'session-restore',
        chatId: 'local-user',
        type: 'task_update',
        eventKey: 'task:task-1',
        timestamp: 200,
        data: {
          id: 'task_task-1',
          task_id: 'task-1',
          title: 'Collect public information',
          status: 'completed',
          timestamp: 240,
        },
      });

      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({ method: 'GET', url: '/api/sessions/session-restore/timeline' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        sessionId: 'session-restore',
        hasMore: false,
        nextCursor: null,
        timeline: [
          {
            type: 'message',
            timestamp: 100,
            data: {
              id: 'msg_turn-1_user',
              role: 'user',
              content: 'Research OpenClaw',
              timestamp: 100,
            },
          },
          {
            type: 'task_update',
            timestamp: 200,
            data: {
              id: 'task_task-1',
              task_id: 'task-1',
              title: 'Collect public information',
              status: 'completed',
              timestamp: 240,
            },
          },
          {
            type: 'tool_event',
            timestamp: 300,
            data: {
              id: 'tool_call-1',
              callId: 'call-1',
              tool: 'browser_extract',
              phase: 'end',
              status: 'success',
              intent: 'Verify persisted browser timeline',
              timestamp: 350,
            },
          },
          {
            type: 'artifact',
            timestamp: 400,
            data: {
              id: 'report-1',
              title: 'Runtime report',
              status: 'completed',
              data: { summary: 'done' },
              timestamp: 400,
            },
          },
        ],
      });
      expect(body.timeline.map((item: { eventId?: unknown }) => item.eventId))
        .toEqual([expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)]);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('reconciles stale approval timeline rows against the approval table', async () => {
    const { tmpDir } = setupTestDb();
    resetApprovalTableFlag();
    const app = Fastify();
    try {
      const session = createSession('local-user', 'Approval restore', 'default');
      const req = createApprovalRequest(
        'external_comm',
        'Send external update',
        { sessionId: session.id, chatId: 'local-user', required_level: 'L3_FULL_ACCESS' },
        'agent-1',
        'default',
      );
      saveTimelineItem({
        tenantId: 'default',
        sessionId: session.id,
        chatId: 'local-user',
        type: 'approval_request',
        eventKey: `approval:${req.id}`,
        timestamp: 100,
        data: {
          id: req.id,
          description: req.description,
          action: req.action,
          status: 'pending',
          required_level: 'L3_FULL_ACCESS',
        },
      });
      approveRequest(req.id, 'local-user', 'default');

      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/timeline` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        sessionId: session.id,
        timeline: [
          {
            type: 'approval_request',
            timestamp: 100,
            data: {
              id: req.id,
              status: 'approved',
              permission_level: 'L3_FULL_ACCESS',
            },
          },
        ],
      });
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('scopes session timeline/messages reads to the owning user', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      // auth_mode 'none' authenticates every request as 'local-user'.
      const owned = createSession('local-user', 'Mine', 'default');
      const foreign = createSession('someone-else', 'Theirs', 'default');
      beginContextCheckpoint({ tenantId: 'default', userId: 'local-user', sessionId: owned.id, chatId: 'chat', sourceMessageId: 1, retainedFromMessageId: null, sourceTokenCount: 700, modelContextWindow: 1000, threshold: 0.7 });
      beginContextCheckpoint({ tenantId: 'default', userId: 'someone-else', sessionId: foreign.id, chatId: 'chat', sourceMessageId: 1, retainedFromMessageId: null, sourceTokenCount: 700, modelContextWindow: 1000, threshold: 0.7 });
      for (const sessionId of [owned.id, foreign.id]) {
        saveTimelineItem({
          tenantId: 'default',
          sessionId,
          chatId: 'chat',
          type: 'message',
          eventKey: 'message:user',
          timestamp: 100,
          data: { id: 'm', role: 'user', content: 'hi', timestamp: 100 },
        });
      }

      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const ownedTimeline = await app.inject({ method: 'GET', url: `/api/sessions/${owned.id}/timeline` });
      expect(ownedTimeline.statusCode).toBe(200);

      const foreignTimeline = await app.inject({ method: 'GET', url: `/api/sessions/${foreign.id}/timeline` });
      expect(foreignTimeline.statusCode).toBe(404);

      const foreignMessages = await app.inject({ method: 'GET', url: `/api/sessions/${foreign.id}/messages` });
      expect(foreignMessages.statusCode).toBe(404);

      const ownedCheckpoint = await app.inject({ method: 'GET', url: `/api/sessions/${owned.id}/context-checkpoint` });
      expect(ownedCheckpoint.statusCode).toBe(200);
      expect(ownedCheckpoint.json().checkpoint.session_id).toBe(owned.id);

      const foreignCheckpoint = await app.inject({ method: 'GET', url: `/api/sessions/${foreign.id}/context-checkpoint` });
      expect(foreignCheckpoint.statusCode).toBe(404);

      const foreignPatch = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${foreign.id}`,
        payload: { title: 'Stolen' },
      });
      expect(foreignPatch.statusCode).toBe(404);
      expect(getSession(foreign.id, 'default')?.title).toBe('Theirs');

      const foreignDelete = await app.inject({ method: 'DELETE', url: `/api/sessions/${foreign.id}` });
      expect(foreignDelete.statusCode).toBe(404);
      expect(getSession(foreign.id, 'default')?.archived).toBe(0);

      // Unknown sessions (no row) keep legacy behavior — not a 404.
      const unknown = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist/timeline' });
      expect(unknown.statusCode).toBe(200);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('updates execution scope without rewriting canonical project ownership', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      const session = createSession('local-user', 'Project work', 'default', {
        workspaceRootId: 'project:a',
        workspaceContext: { rootPath: '/repo/a', rootKind: 'project_root', label: 'A' },
      });
      saveMessage('project-work', 'user', 'start', undefined, undefined, session.id);
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${session.id}`,
        payload: {
          workspaceRootId: 'project:b',
          workspaceContext: { rootPath: '/repo/b', rootKind: 'project_root', label: 'B' },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().session).toMatchObject({
        project_root_id: 'project:a',
        project_context: { rootPath: '/repo/a' },
        execution_root_id: 'project:b',
        execution_context: { rootPath: '/repo/b' },
      });

      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${session.id}`,
        payload: { workspaceRootId: 'project:bad', workspaceContext: { rootPath: 'relative/path' } },
      });
      expect(rejected.statusCode).toBe(400);
      expect(getSession(session.id)?.execution_root_id).toBe('project:b');
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('moves an unused task into the project selected before its first message', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      const session = createSession('local-user', 'New Chat', 'default', {
        workspaceRootId: 'project:a',
        workspaceContext: { rootPath: '/repo/a', rootKind: 'project_root', label: 'A' },
      });
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${session.id}`,
        payload: {
          workspaceRootId: 'project:b',
          workspaceContext: { rootPath: '/repo/b', rootKind: 'project_root', label: 'B' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().session).toMatchObject({
        project_root_id: 'project:b',
        project_context: { rootPath: '/repo/b' },
        execution_root_id: 'project:b',
        execution_context: { rootPath: '/repo/b' },
      });
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('deletes owned session messages and their rendered user turn without exposing foreign sessions', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      const owned = createSession('local-user', 'Mine', 'default');
      const foreign = createSession('someone-else', 'Theirs', 'default');
      const firstPrompt = saveMessage('local-user', 'user', 'First prompt', undefined, undefined, owned.id);
      saveMessage('local-user', 'assistant', 'First answer', undefined, undefined, owned.id);
      saveMessage('local-user', 'user', 'Second prompt', undefined, undefined, owned.id);
      const foreignPrompt = saveMessage('someone-else', 'user', 'Private prompt', undefined, undefined, foreign.id);
      for (const [sessionId, prefix] of [[owned.id, 'owned'], [foreign.id, 'foreign']] as const) {
        saveTimelineItem({
          tenantId: 'default', sessionId, chatId: sessionId, type: 'message', eventKey: `${prefix}:user-1`, timestamp: 100,
          data: { id: `${prefix}-user-1`, role: 'user', content: sessionId === owned.id ? 'First prompt' : 'Private prompt', timestamp: 100 },
        });
        saveTimelineItem({
          tenantId: 'default', sessionId, chatId: sessionId, type: 'message', eventKey: `${prefix}:assistant-1`, timestamp: 200,
          data: { id: `${prefix}-assistant-1`, role: 'assistant', content: 'First answer', timestamp: 200 },
        });
      }
      saveTimelineItem({
        tenantId: 'default', sessionId: owned.id, chatId: owned.id, type: 'message', eventKey: 'owned:user-2', timestamp: 300,
        data: { id: 'owned-user-2', role: 'user', content: 'Second prompt', timestamp: 300 },
      });

      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const deleted = await app.inject({ method: 'DELETE', url: `/api/sessions/${owned.id}/messages/${firstPrompt}` });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ ok: true, deletedConversationCount: 2, deletedTimelineCount: 2 });
      expect(getSessionHistory(owned.id).map(message => message.content)).toEqual(['Second prompt']);
      const timeline = await app.inject({ method: 'GET', url: `/api/sessions/${owned.id}/timeline` });
      expect((timeline.json() as { timeline: Array<{ data: { content: string } }> }).timeline.map(item => item.data.content)).toEqual(['Second prompt']);

      const foreignDelete = await app.inject({ method: 'DELETE', url: `/api/sessions/${foreign.id}/messages/${foreignPrompt}` });
      expect(foreignDelete.statusCode).toBe(404);
      expect(getSessionHistory(foreign.id).map(message => message.content)).toEqual(['Private prompt']);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('gets and updates session permission level only for the owning user', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    try {
      const owned = createSession('local-user', 'Mine', 'default');
      const foreign = createSession('someone-else', 'Theirs', 'default');

      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const initial = await app.inject({ method: 'GET', url: `/api/sessions/${owned.id}/permission-level` });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        sessionId: owned.id,
        permission_level: 'L3_FULL_ACCESS',
      });

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${owned.id}/permission-level`,
        payload: { permission_level: 'L1_READ_WRITE' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        sessionId: owned.id,
        permission_level: 'L1_READ_WRITE',
      });
      expect(getSession(owned.id, 'default')?.permission_level).toBe('L1_READ_WRITE');

      const invalid = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${owned.id}/permission-level`,
        payload: { permission_level: 'L9_IMAGINARY' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(getSession(owned.id, 'default')?.permission_level).toBe('L1_READ_WRITE');

      const foreignGet = await app.inject({ method: 'GET', url: `/api/sessions/${foreign.id}/permission-level` });
      expect(foreignGet.statusCode).toBe(404);

      const foreignPatch = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${foreign.id}/permission-level`,
        payload: { permission_level: 'L0_READ_ONLY' },
      });
      expect(foreignPatch.statusCode).toBe(404);
      expect(getSession(foreign.id, 'default')?.permission_level).toBe('L3_FULL_ACCESS');
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('scopes history and memory endpoints to the requesting user in the same tenant', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    const jwtSecret = 'test-secret';
    const tenantId = 'tenant-shared';
    const tokenA = jwtSign('user-a', jwtSecret, 3600, { tenant_id: tenantId, roles: ['admin'] });
    const tokenB = jwtSign('user-b', jwtSecret, 3600, { tenant_id: tenantId, roles: ['admin'] });
    const authA = { authorization: `Bearer ${tokenA}` };
    const authB = { authorization: `Bearer ${tokenB}` };

    try {
      addAllowedUser('user-a', 'user-a', 'owner', tenantId);
      addAllowedUser('user-b', 'user-b', 'owner', tenantId);
      const sessionA = createSession('user-a', 'A', tenantId);
      const sessionB = createSession('user-b', 'B', tenantId);
      saveMessage('chat-a', 'user', 'A history', undefined, undefined, sessionA.id, tenantId);
      saveMessage('chat-b', 'user', 'B history', undefined, undefined, sessionB.id, tenantId);
      saveFact('chat-a', 'fact', 'project', 'alpha private fact', 'test', tenantId, 'user-a');
      saveFact('chat-b', 'fact', 'project', 'beta private fact', 'test', tenantId, 'user-b');
      saveFact('chat-a', 'decision', 'legacy-owned', 'visible through owned chat', 'test', tenantId);

      await registerApiRoutes(app, {
        jwtSecret,
        config: {
          server: { auth_mode: 'token', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const ownHistory = await app.inject({ method: 'GET', url: '/api/history?chatId=chat-a', headers: authA });
      expect(ownHistory.statusCode).toBe(200);
      expect((ownHistory.json() as { messages: Array<{ content: string }> }).messages.map(message => message.content)).toEqual(['A history']);

      const foreignHistory = await app.inject({ method: 'GET', url: '/api/history?chatId=chat-b', headers: authA });
      expect(foreignHistory.statusCode).toBe(200);
      expect((foreignHistory.json() as { messages: unknown[] }).messages).toEqual([]);

      const ownFacts = await app.inject({ method: 'GET', url: '/api/memory/facts', headers: authA });
      expect(ownFacts.statusCode).toBe(200);
      expect((ownFacts.json() as { facts: Array<{ key: string; value: string }> }).facts.map(fact => fact.key)).toEqual([
        'legacy-owned',
        'project',
      ]);

      const foreignFacts = await app.inject({ method: 'GET', url: '/api/memory/facts', headers: authB });
      expect(foreignFacts.statusCode).toBe(200);
      expect((foreignFacts.json() as { facts: Array<{ key: string; value: string }> }).facts.map(fact => fact.value)).toEqual([
        'beta private fact',
      ]);

      const ownSearch = await app.inject({ method: 'GET', url: '/api/memory/search?chatId=chat-a&q=alpha&limit=5', headers: authA });
      expect(ownSearch.statusCode).toBe(200);
      expect((ownSearch.json() as { facts: Array<{ fact: { value: string } }> }).facts.map(hit => hit.fact.value)).toContain('alpha private fact');

      const foreignSearch = await app.inject({ method: 'GET', url: '/api/memory/search?chatId=chat-b&q=beta&limit=5', headers: authA });
      expect(foreignSearch.statusCode).toBe(200);
      expect((foreignSearch.json() as { facts: unknown[] }).facts).toEqual([]);

    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });

  it('quarantines legacy project memory for admin review and rehomes it on confirmation', async () => {
    const { tmpDir } = setupTestDb();
    const app = Fastify();
    const jwtSecret = 'test-secret';
    const tenantId = 'tenant-project-review';
    const adminHeaders = {
      authorization: `Bearer ${jwtSign('admin-a', jwtSecret, 3600, { tenant_id: tenantId, roles: ['admin'] })}`,
    };
    const viewerHeaders = {
      authorization: `Bearer ${jwtSign('viewer-b', jwtSecret, 3600, { tenant_id: tenantId, roles: ['viewer'] })}`,
    };

    try {
      addAllowedUser('admin-a', 'admin-a', 'owner', tenantId);
      addAllowedUser('viewer-b', 'viewer-b', 'viewer', tenantId);
      saveFact(
        '__project__', 'fact', 'legacy_architecture', 'Unverified assistant claim',
        'project_extraction', tenantId, undefined, undefined, 'pending_review', 'assistant',
      );
      await registerApiRoutes(app, {
        jwtSecret,
        config: {
          server: { auth_mode: 'token', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const adminList = await app.inject({ method: 'GET', url: '/api/memory/facts', headers: adminHeaders });
      const pending = (adminList.json() as { facts: Array<{ id: number; status: string }> }).facts[0];
      expect(pending.status).toBe('pending_review');

      const viewerList = await app.inject({ method: 'GET', url: '/api/memory/facts', headers: viewerHeaders });
      expect((viewerList.json() as { facts: unknown[] }).facts).toEqual([]);

      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/memory/facts/${pending.id}`,
        headers: adminHeaders,
        payload: { value: 'Admin verified this project claim' },
      });
      expect(edited.statusCode).toBe(200);

      const confirmed = await app.inject({
        method: 'PATCH',
        url: `/api/memory/facts/${pending.id}/status`,
        headers: adminHeaders,
        payload: { status: 'active' },
      });
      expect(confirmed.statusCode).toBe(200);
      expect((confirmed.json() as { fact: { chat_id: string; user_id: string; status: string; origin_kind: string } }).fact).toMatchObject({
        chat_id: '__project__:admin-a',
        user_id: 'admin-a',
        status: 'active',
        origin_kind: 'user',
      });
      const evidence = getDb().prepare(`
        SELECT source, value_snapshot, previous_value_snapshot, previous_status_snapshot,
               previous_origin_kind, previous_source
        FROM memory_fact_evidence WHERE fact_id = ? ORDER BY id
      `).all(pending.id);
      expect(evidence).toEqual([
        {
          source: 'user_edit',
          value_snapshot: 'Admin verified this project claim',
          previous_value_snapshot: 'Unverified assistant claim',
          previous_status_snapshot: 'pending_review',
          previous_origin_kind: 'assistant',
          previous_source: 'project_extraction',
        },
        {
          source: 'user_review',
          value_snapshot: 'Admin verified this project claim',
          previous_value_snapshot: 'Admin verified this project claim',
          previous_status_snapshot: 'pending_review',
          previous_origin_kind: 'assistant',
          previous_source: 'user_edit',
        },
      ]);
    } finally {
      await app.close();
      teardownTestDb(tmpDir);
    }
  });
});
