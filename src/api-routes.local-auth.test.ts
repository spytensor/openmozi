import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerApiRoutes } from './api-routes.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { getDb } from './store/db.js';
import { loadConfig } from './config/index.js';
import { clearModelRegistryEnrichmentCache } from './core/model-registry-enrichment.js';
import { clearModelDiscoveryCache } from './core/model-discovery.js';
import { resetUsersTableFlag } from './security/users.js';
import { resetTableFlag as resetRbacTableFlag } from './security/rbac.js';
import { resetTableFlag as resetPairingTableFlag } from './security/pairing.js';
import { resetRefreshTokenTableFlag } from './security/refresh-token.js';
import { resetTableFlag as resetApprovalTableFlag } from './security/gates.js';
import { createSession } from './memory/sessions.js';
import { queryAuditLog } from './security/audit.js';
import { addAllowedUser } from './security/pairing.js';
import { sign as signJwt } from './security/jwt.js';
import { AUTH_COOKIE_NAME } from './security/api-auth.js';
import { legacyPairingRoles } from './api/application-routes.js';

let tmpDir: string;
let app: FastifyInstance | null = null;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
let savedOpenAiApiKey: string | undefined;
let savedMoziHome: string | undefined;

beforeEach(() => {
  savedOpenAiApiKey = process.env.OPENAI_API_KEY;
  savedMoziHome = process.env.MOZI_HOME;
  clearModelRegistryEnrichmentCache();
  clearModelDiscoveryCache();
  const db = setupTestDb();
  tmpDir = db.tmpDir;
  process.env.MOZI_HOME = tmpDir;
  resetUsersTableFlag();
  resetRbacTableFlag();
  resetPairingTableFlag();
  resetRefreshTokenTableFlag();
  resetApprovalTableFlag();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  vi.unstubAllGlobals();
  clearModelRegistryEnrichmentCache();
  clearModelDiscoveryCache();
  if (savedOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiApiKey;
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
  teardownTestDb(tmpDir);
});

describe('api routes local auth', () => {
  it('restricts usage analytics to admins and exports the same filtered records', async () => {
    app = await createApp('open');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const adminId = admin.json().user.id as string;
    const viewer = await registerUser(app, { email: 'viewer@example.com', password: 'ViewerPass1' });
    getDb().prepare(`
      INSERT INTO billing_records (
        tenant_id, record_type, user_id, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cost_usd, pricing_source, usage_status, outcome, duration_ms
      ) VALUES ('default', 'llm_call', ?, 'openai', 'gpt-4.1-mini', 100, 20, 60, 0.01, 'catalog_estimate', 'provider_reported', 'success', 250)
    `).run(adminId);

    const analytics = await app.inject({ method: 'GET', url: `/api/admin/usage?user_id=${adminId}&from=2000-01-01&to=2999-12-31`, headers: { cookie: cookieHeader(admin) } });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toMatchObject({ summary: { calls: 1, cache_read_tokens: 60, cost_usd: 0.01 }, total: 1 });

    const exported = await app.inject({ method: 'GET', url: `/api/admin/usage/export?user_id=${adminId}&from=2000-01-01&to=2999-12-31`, headers: { cookie: cookieHeader(admin) } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body).toContain('gpt-4.1-mini');
    expect(exported.body).toContain(adminId);

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      'gpt-4.1-mini': { litellm_provider: 'openai', input_cost_per_token: 0.0000004, cache_read_input_token_cost: 0.0000001, output_cost_per_token: 0.0000016 },
    }), { status: 200 })));
    const refreshed = await app.inject({
      method: 'POST', url: '/api/admin/usage/refresh-pricing', headers: { cookie: cookieHeader(admin) },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ success: true, pricing: { registry_available: true } });
    expect(refreshed.json()).not.toHaveProperty('openai');

    const forbidden = await app.inject({ method: 'GET', url: '/api/admin/usage', headers: { cookie: cookieHeader(viewer) } });
    expect(forbidden.statusCode).toBe(403);
    const refreshForbidden = await app.inject({ method: 'POST', url: '/api/admin/usage/refresh-pricing', headers: { cookie: cookieHeader(viewer) }, payload: {} });
    expect(refreshForbidden.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/usage/reconcile', headers: { cookie: cookieHeader(admin) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/admin/usage/openai-admin-key', headers: { cookie: cookieHeader(admin), }, payload: { key: 'nope' } })).statusCode).toBe(404);
    const auditForbidden = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookieHeader(viewer) } });
    expect(auditForbidden.statusCode).toBe(403);
  });

  it('bootstraps the first local registrant as admin', async () => {
    app = await createApp('invite');

    const registered = await registerUser(app, {
      email: ' Admin@Example.com ',
      password: 'AdminPass1',
      name: 'Admin User',
    });

    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toMatchObject({
      success: true,
      user: {
        email: 'admin@example.com',
        role: 'admin',
        status: 'active',
      },
    });
    expect(cookieHeader(registered)).toContain('mozi_token=');
    expect(cookieHeader(registered)).toContain('mozi_refresh=');

    const role = getDb().prepare('SELECT role FROM role_assignments WHERE user_id = ?').get(registered.json().user.id) as { role: string };
    expect(role.role).toBe('admin');
  });

  it('still bootstraps the first real account when a keyless none-mode local-user exists', async () => {
    // Simulate a box that ran in auth_mode=none first: an auto-provisioned
    // 'local-user' with an admin role but NO password. It must not lock out the
    // first genuine local registration when the box switches to auth_mode=local.
    const { ensureLocalUser, canBootstrapLocalAdmin } = await import('./security/users.js');
    ensureLocalUser('default');
    expect(canBootstrapLocalAdmin('default')).toBe(true);

    app = await createApp('invite');
    const registered = await registerUser(app, { email: 'owner@example.com', password: 'OwnerPass1', name: 'Owner' });
    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toMatchObject({ success: true, user: { role: 'admin', status: 'active' } });
  });

  it('applies open, invite, and closed registration policies after bootstrap', async () => {
    app = await createApp('open');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const openUser = await registerUser(app, { email: 'viewer@example.com', password: 'ViewerPass1' });
    expect(openUser.statusCode).toBe(200);
    expect(openUser.json()).toMatchObject({ user: { role: 'viewer' } });

    await app.close();
    app = await createApp('invite');
    const invite = await app.inject({
      method: 'POST',
      url: '/api/auth/invites',
      headers: { cookie: cookieHeader(admin) },
      payload: { role: 'operator', expires_minutes: 10 },
    });
    expect(invite.statusCode).toBe(200);
    const invited = await registerUser(app, {
      email: 'operator@example.com',
      password: 'OperatorPass1',
      invite_code: invite.json().code,
    });
    expect(invited.statusCode).toBe(200);
    expect(invited.json()).toMatchObject({ user: { role: 'operator' } });

    await app.close();
    app = await createApp('closed');
    const closed = await registerUser(app, { email: 'blocked@example.com', password: 'BlockedPass1' });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toMatchObject({ success: false, error: 'Registration is closed' });
  });

  it('returns a typed conflict for duplicate registration without consuming invites', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/auth/invites',
      headers: { cookie: cookieHeader(admin) },
      payload: { role: 'viewer' },
    });

    const duplicate = await registerUser(app, {
      email: 'admin@example.com',
      password: 'AdminPass1',
      invite_code: invite.json().code,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ success: false, code: 'duplicate_email' });

    const invited = await registerUser(app, {
      email: 'new@example.com',
      password: 'NewUserPass1',
      invite_code: invite.json().code,
    });
    expect(invited.statusCode).toBe(200);
  });

  it('logs in local users and keeps unknown email and wrong password errors identical', async () => {
    app = await createApp('invite');
    await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const success = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'AdminPass1' },
    });
    expect(success.statusCode).toBe(200);
    expect(cookieHeader(success)).toContain('mozi_token=');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'WrongPass1' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'missing@example.com', password: 'WrongPass1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toEqual({ success: false, error: 'invalid credentials' });
  });

  it('rejects disabled users on login, refresh, and authenticated API routes', async () => {
    app = await createApp('open');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    await registerUser(app, { email: 'target@example.com', password: 'TargetPass1' });
    const targetLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'target@example.com', password: 'TargetPass1' },
    });
    const targetId = targetLogin.json().user.id as string;

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/users/${targetId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'target@example.com', password: 'TargetPass1' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ error: 'Account disabled' });

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: cookieHeader(targetLogin) },
    });
    expect(refresh.statusCode).not.toBe(200);

    const guarded = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: cookieHeader(targetLogin) },
    });
    expect(guarded.statusCode).toBe(403);
  });

  it('changes passwords and revokes refresh tokens', async () => {
    app = await createApp('invite');
    const registered = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const userId = registered.json().user.id as string;

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: cookieHeader(registered) },
      payload: { current_password: 'AdminPass1', new_password: 'ChangedPass1' },
    });
    expect(changed.statusCode).toBe(200);

    const revoked = getDb().prepare(`
      SELECT COUNT(*) as count FROM refresh_tokens
      WHERE user_id = ? AND revoked_at IS NOT NULL
    `).get(userId) as { count: number };
    expect(revoked.count).toBeGreaterThan(0);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'AdminPass1' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'ChangedPass1' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('lets admins create users, patch role and password, and disable with token revocation', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: cookieHeader(admin) },
      payload: { email: 'created@example.com', name: 'Created User', role: 'viewer' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().generated_password).toEqual(expect.any(String));
    expect(created.json()).toMatchObject({ user: { email: 'created@example.com', role: 'viewer' } });

    const createdLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'created@example.com', password: created.json().generated_password },
    });
    expect(createdLogin.statusCode).toBe(200);
    const createdUserId = created.json().user.id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/users/${createdUserId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { role: 'operator', new_password: 'ResetPass1' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ user: { role: 'operator' } });

    const resetLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'created@example.com', password: 'ResetPass1' },
    });
    expect(resetLogin.statusCode).toBe(200);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/users/${createdUserId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ user: { status: 'disabled' } });

    const revoked = getDb().prepare(`
      SELECT COUNT(*) as count FROM refresh_tokens
      WHERE user_id = ? AND revoked_at IS NOT NULL
    `).get(createdUserId) as { count: number };
    expect(revoked.count).toBeGreaterThan(0);

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: cookieHeader(createdLogin) },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('lets admins patch user model grants and writes an entitlement audit row', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const adminId = admin.json().user.id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['gpt-4.1-mini'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      success: true,
      user: { allowed_models: ['gpt-4.1-mini'] },
    });

    const audit = getDb().prepare(`
      SELECT action, resource_type, resource_id, details
      FROM audit_log
      WHERE action = 'entitlement.update' AND resource_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(adminId) as { action: string; resource_type: string; resource_id: string; details: string };
    expect(audit).toMatchObject({
      action: 'entitlement.update',
      resource_type: 'user',
      resource_id: adminId,
    });
    expect(JSON.parse(audit.details)).toEqual({ allowed_models: ['gpt-4.1-mini'] });
  });

  it('denies model role updates outside the caller effective model set', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const adminId = admin.json().user.id as string;

    const grant = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['gpt-4.1-mini'] },
    });
    expect(grant.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/models/roles',
      headers: { cookie: cookieHeader(admin) },
      payload: { brain: { provider: 'openai', model: 'gpt-4.1' } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      success: false,
      code: 'model_not_allowed',
    });
    expect(denied.json().error).toContain('gpt-4.1-mini');
  });

  it('lets only admins repoint a tenant-wide model role', async () => {
    app = await createApp('open');
    await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const member = await registerUser(app, { email: 'member@example.com', password: 'MemberPass1' });

    // Two independent limits guard this endpoint and they are easy to confuse:
    // the entitlement check bounds WHICH model a caller may name (403
    // `model_not_allowed`), while `requiredRoleForApiRoute` bounds WHO may write
    // at all. Only the latter is under test — a role slot is tenant-wide, so a
    // member repointing it would move the Brain for everyone.
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/models/roles',
      headers: { cookie: cookieHeader(member) },
      payload: { brain: { provider: 'openai', model: 'gpt-4.1-mini' } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ success: false, error: 'Forbidden: admin role required' });
    // Distinguishes the role gate from the entitlement gate: the latter answers
    // with code 'model_not_allowed', so a green test here would otherwise prove
    // nothing about who is allowed to write.
    expect(denied.json().code).toBeUndefined();
  });

  it('stops honouring a token whose account no longer exists (deleted, not merely disabled)', async () => {
    app = await createApp('open');
    await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const ghost = await registerUser(app, { email: 'ghost@example.com', password: 'GhostPass1' });
    const ghostId = ghost.json().user.id as string;
    const cookie = cookieHeader(ghost);

    // Signature stays valid: the row goes away underneath a live session — an
    // account deletion, or a database reset while jwt-secret survives.
    getDb().prepare('DELETE FROM users WHERE id = ?').run(ghostId);

    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } });
    expect(status.json()).toMatchObject({ authenticated: false });

    const api = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie } });
    expect(api.statusCode).toBe(401);

    // Rotation would mint a FRESH access token, renewing the ghost indefinitely.
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } });
    expect(refreshed.statusCode).toBe(401);

    expect(queryAuditLog({ tenant_id: 'default', action: 'auth.fail' }).entries
      .some((row) => (row.details as { reason?: string } | null)?.reason === 'subject_gone')).toBe(true);
  });

  it('keeps honouring a paired identity that legitimately has no users row', async () => {
    app = await createApp('open');
    // Channel pairings live in allowed_users and never get a `users` row, so a
    // subject-existence check that consults only `users` would lock out every
    // paired Telegram/Discord operator.
    addAllowedUser('tg-42', 'pairedOperator', 'owner', 'default');
    const token = signJwt('tg-42', 'test-secret', 3600, {
      tenant_id: 'default', role: 'owner', roles: legacyPairingRoles('owner'),
      username: 'pairedOperator', legacy_pairing: true,
    });

    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` },
    });
    expect(status.json()).toMatchObject({ authenticated: true });
  });

  it('marks provider catalog models with caller allowed flags without removing entries', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const adminId = admin.json().user.id as string;

    const grant = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['gpt-4.1-mini'] },
    });
    expect(grant.statusCode).toBe(200);

    const providers = await app.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { cookie: cookieHeader(admin) },
    });
    expect(providers.statusCode).toBe(200);
    const openai = providers.json().providers.find((provider: { id: string }) => provider.id === 'openai') as {
      models: Array<{ id: string; allowed: boolean }>;
    };
    expect(openai.models.find(model => model.id === 'gpt-4.1-mini')).toMatchObject({ allowed: true });
    expect(openai.models.find(model => model.id === 'gpt-4.1')).toMatchObject({ allowed: false });
  });

  it('persists tenant allowed_models through the quota route with catalog validation', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/quotas/default',
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['gpt-4.1-mini'], daily_token_limit: 1000 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      success: true,
      quota: {
        tenant_id: 'default',
        daily_token_limit: 1000,
        allowed_models: ['gpt-4.1-mini'],
      },
    });

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/quotas/default',
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['not-a-real-model'] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('Unknown model id');
  });

  it('accepts pattern-resolvable model grants and rejects unresolvable ids', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/quotas/default',
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['gpt-5.5-pro'] },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().quota.allowed_models).toEqual(['gpt-5.5-pro']);

    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/quotas/default',
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['garbage-model-id'] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain('Unknown model id');
  });

  it('appends granted non-bundled models to /api/providers with enrichment metadata', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        'gpt-5.5-pro': {
          max_input_tokens: 500000,
          max_output_tokens: 64000,
          supports_function_calling: true,
          supports_vision: true,
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000012,
        },
      }),
    } as Response));
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    await app.inject({
      method: 'PUT',
      url: '/api/quotas/default',
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['gpt-5.5-pro'] },
    });

    const providers = await app.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { cookie: cookieHeader(admin) },
    });
    expect(providers.statusCode).toBe(200);
    const openai = providers.json().providers.find((provider: { id: string }) => provider.id === 'openai') as {
      models: Array<{ id: string; allowed: boolean; discovered?: boolean; contextWindow?: number; inputCostPer1M?: number }>;
    };
    expect(openai.models.find(model => model.id === 'gpt-5.5-pro')).toMatchObject({
      allowed: true,
      discovered: true,
      contextWindow: 500000,
      inputCostPer1M: 3,
    });
  });

  it('lists live provider models with junk filtering and resolvability flags', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-live-models';
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test-live-models');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'gpt-4.1' },
              { id: 'gpt-5.5-pro' },
              { id: 'text-embedding-3-large' },
              { id: 'whisper-1' },
              { id: 'not-resolvable-chat-model' },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'gpt-5.5-pro': {
            max_input_tokens: 500000,
            supports_function_calling: true,
          },
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const live = await app.inject({
      method: 'GET',
      url: '/api/providers/openai/models/live',
      headers: { cookie: cookieHeader(admin) },
    });

    expect(live.statusCode).toBe(200);
    const body = live.json() as {
      models: Array<{ id: string; bundled: boolean; resolvable: boolean; metadata: { contextWindow?: number } | null }>;
    };
    expect(body.models.map(model => model.id)).toEqual(['gpt-4.1', 'gpt-5.5-pro', 'not-resolvable-chat-model']);
    expect(body.models.find(model => model.id === 'gpt-4.1')).toMatchObject({ bundled: true, resolvable: true });
    expect(body.models.find(model => model.id === 'gpt-5.5-pro')).toMatchObject({
      bundled: false,
      resolvable: true,
      metadata: { contextWindow: 500000 },
    });
    expect(body.models.find(model => model.id === 'not-resolvable-chat-model')).toMatchObject({
      bundled: false,
      resolvable: true,
      capability_confidence: 'provider',
    });

    const providers = await app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: cookieHeader(admin) } });
    const openai = providers.json().providers.find((entry: { id: string }) => entry.id === 'openai');
    expect(openai.discovery).toMatchObject({ source: 'cache', capability_confidence: 'provider' });
    expect(openai.models.find((model: { id: string }) => model.id === 'not-resolvable-chat-model')).toMatchObject({
      source: 'cache',
      capabilityConfidence: 'provider',
    });
  });

  it('persists a provider-scoped manual model and routes it with conservative capabilities', async () => {
    app = await createApp('invite');
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    const manual = await app.inject({
      method: 'POST',
      url: '/api/providers/deepseek/models/manual',
      headers: { cookie: cookieHeader(admin) },
      payload: { model: 'deepseek-private-preview' },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().model).toMatchObject({
      id: 'deepseek-private-preview',
      source: 'manual',
      capabilityConfidence: 'conservative',
      supportsTools: false,
      reasoning: false,
    });

    const grant = await app.inject({
      method: 'PUT',
      url: '/api/quotas/default',
      headers: { cookie: cookieHeader(admin) },
      payload: { allowed_models: ['deepseek-private-preview'] },
    });
    expect(grant.statusCode).toBe(200);

    const role = await app.inject({
      method: 'PATCH',
      url: '/api/models/roles',
      headers: { cookie: cookieHeader(admin) },
      payload: { brain: { provider: 'deepseek', model: 'deepseek-private-preview' } },
    });
    expect(role.statusCode).toBe(200);

    const providers = await app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: cookieHeader(admin) } });
    const deepseek = providers.json().providers.find((provider: { id: string }) => provider.id === 'deepseek');
    expect(deepseek.models.find((model: { id: string }) => model.id === 'deepseek-private-preview')).toMatchObject({
      source: 'manual',
      allowed: true,
    });
  });

  it('keeps auth_mode none auto-authenticated as local-user', async () => {
    app = Fastify();
    await registerApiRoutes(app, {
      jwtSecret: 'test-secret',
      config: {
        server: { auth_mode: 'none', host: '127.0.0.1' },
        security: { enterprise: {} },
        http_rate_limit: { global_rpm: 1000, auth_rpm: 1000, pair_rpm: 1000 },
      },
    });

    const me = await app.inject({ method: 'GET', url: '/api/users/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: {
        id: 'local-user',
        auth_provider: 'local',
        role: 'admin',
        status: 'active',
      },
    });
  });

  it('audits manual session permission changes in personal mode', async () => {
    app = Fastify();
    const session = createSession('local-user', 'Permission audit', 'default');
    await registerApiRoutes(app, {
      jwtSecret: 'test-secret',
      config: {
        server: { auth_mode: 'none', host: '127.0.0.1' },
        security: { enterprise: {} },
        http_rate_limit: { global_rpm: 1000, auth_rpm: 1000, pair_rpm: 1000 },
      },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}/permission-level`,
      payload: { permission_level: 'L1_READ_WRITE' },
    });

    expect(patched.statusCode).toBe(200);
    const audit = queryAuditLog({ tenant_id: 'default', action: 'session.permission' });
    expect(audit.entries[0]).toMatchObject({
      user_id: 'local-user',
      resource_type: 'session',
      resource_id: session.id,
    });
    expect(audit.entries[0].details).toMatchObject({
      permission_level: 'L1_READ_WRITE',
      reason: 'manual_update',
    });
  });

  it('enforces tenant model activation in auth_mode none when a tenant grant exists', async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-personal-entitlements-'));
    process.env.MOZI_HOME = moziHome;
    getDb().prepare(`
      INSERT INTO tenant_quotas (tenant_id, allowed_models)
      VALUES ('default', ?)
    `).run(JSON.stringify(['gpt-4.1-mini']));

    app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 1000, auth_rpm: 1000, pair_rpm: 1000 },
        },
      });

      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/models/roles',
        payload: { brain: { provider: 'openai', model: 'gpt-4.1' } },
      });
      expect(patched.statusCode).toBe(403);
      expect(patched.json()).toMatchObject({ success: false, code: 'model_not_allowed' });

      const providers = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(providers.statusCode).toBe(200);
      const openai = providers.json().providers.find((provider: { id: string }) => provider.id === 'openai') as {
        models: Array<{ id: string; allowed: boolean }>;
      };
      expect(openai.models.find(model => model.id === 'gpt-4.1-mini')).toMatchObject({ allowed: true });
      expect(openai.models.find(model => model.id === 'gpt-4.1')).toMatchObject({ allowed: false });
    } finally {
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('issues refresh cookies with the configured TTL (default 30 days)', async () => {
    app = await createApp('open');
    const registered = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const refreshCookie = findSetCookie(registered, 'mozi_refresh');
    expect(refreshCookie).toMatch(/max-age=2592000/i); // 30 days

    await app.close();
    app = await createApp('open', { refreshTtlDays: 1 });
    const oneDay = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'AdminPass1' },
    });
    expect(oneDay.statusCode).toBe(200);
    expect(findSetCookie(oneDay, 'mozi_refresh')).toMatch(/max-age=86400/i);

    // The stored token row must expire on the same schedule as the cookie.
    // created_at has second granularity and ties with the earlier 30-day
    // registration, so pick the soonest-expiring live token instead.
    const row = getDb().prepare(`
      SELECT expires_at FROM refresh_tokens
      WHERE revoked_at IS NULL ORDER BY expires_at ASC LIMIT 1
    `).get() as { expires_at: string };
    const deltaSeconds = (new Date(row.expires_at).getTime() - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(86400 - 120);
    expect(deltaSeconds).toBeLessThan(86400 + 120);
  });

  it('marks auth cookies Secure only when the request came over https', async () => {
    app = await createApp('open');
    const httpLogin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    for (const cookie of setCookieStrings(httpLogin)) {
      expect(cookie).not.toMatch(/;\s*secure/i);
    }

    const httpsLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { email: 'admin@example.com', password: 'AdminPass1' },
    });
    expect(httpsLogin.statusCode).toBe(200);
    const cookies = setCookieStrings(httpsLogin);
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/;\s*secure/i);
    }
  });

  it('recovers a session from the refresh cookie alone after the access cookie expired', async () => {
    app = await createApp('open');
    const registered = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });

    // Simulate a cold start after >15 min: the access cookie is gone, only
    // the long-lived refresh cookie survives in the browser jar.
    const refreshOnly = findSetCookie(registered, 'mozi_refresh')!.split(';')[0];
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: refreshOnly },
    });
    expect(refreshed.statusCode).toBe(200);
    const newAccess = findSetCookie(refreshed, 'mozi_token');
    expect(newAccess).toBeTruthy();
    expect(findSetCookie(refreshed, 'mozi_refresh')).toBeTruthy(); // rotated

    const me = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: newAccess!.split(';')[0] },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: 'admin@example.com' } });

    // Rotation is one-time-use: replaying the consumed refresh cookie fails.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: refreshOnly },
    });
    expect(replay.statusCode).toBe(401);
  });
});

async function createApp(
  registration: 'open' | 'invite' | 'closed',
  opts?: { refreshTtlDays?: number },
): Promise<FastifyInstance> {
  const fastify = Fastify();
  await registerApiRoutes(fastify, {
    jwtSecret: 'test-secret',
    config: {
      server: { auth_mode: 'local', host: '127.0.0.1' },
      security: { enterprise: {}, registration, refresh_token_ttl_days: opts?.refreshTtlDays },
      http_rate_limit: { global_rpm: 1000, auth_rpm: 1000, pair_rpm: 1000 },
    },
  });
  return fastify;
}

function registerUser(
  fastify: FastifyInstance,
  payload: { email: string; password: string; name?: string; invite_code?: string },
): Promise<InjectResponse> {
  return fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload,
  });
}

function cookieHeader(response: InjectResponse): string {
  const value = response.headers['set-cookie'];
  const cookies = Array.isArray(value) ? value : value ? [value] : [];
  return cookies.map((cookie) => String(cookie).split(';')[0]).join('; ');
}

function setCookieStrings(response: InjectResponse): string[] {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

function findSetCookie(response: InjectResponse, name: string): string | undefined {
  return setCookieStrings(response).find((cookie) => cookie.startsWith(`${name}=`));
}
