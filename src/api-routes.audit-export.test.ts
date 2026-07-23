import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApiRoutes } from './api-routes.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { resetUsersTableFlag } from './security/users.js';
import { resetTableFlag as resetRbacTableFlag } from './security/rbac.js';
import { resetTableFlag as resetPairingTableFlag } from './security/pairing.js';
import { resetRefreshTokenTableFlag } from './security/refresh-token.js';
import { logAudit } from './security/audit.js';

let tmpDir: string;
let app: FastifyInstance | null = null;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
const fakeApiKey = ['sk', 'testsecret1234567890'].join('-');

beforeEach(() => {
  const db = setupTestDb();
  tmpDir = db.tmpDir;
  resetUsersTableFlag();
  resetRbacTableFlag();
  resetPairingTableFlag();
  resetRefreshTokenTableFlag();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  teardownTestDb(tmpDir);
});

describe('api audit export route', () => {
  it('allows admins to export redacted CSV audit logs and denies viewers', async () => {
    app = await createApp();
    const admin = await registerUser(app, { email: 'admin@example.com', password: 'AdminPass1' });
    const viewer = await registerUser(app, { email: 'viewer@example.com', password: 'ViewerPass1' });

    logAudit({
      tenant_id: 'default',
      user_id: admin.json().user.id,
      action: 'config.update',
      resource_type: 'provider',
      resource_id: 'openai',
      details: {
        provider: 'openai',
        api_key: fakeApiKey,
        nested: { refresh_token: 'eyJhbGciOiJIUzI1NiJ9.payload.signature' },
      },
      outcome: 'success',
    });

    const exported = await app.inject({
      method: 'GET',
      url: '/api/audit/export?format=csv&limit=100',
      headers: { cookie: cookieHeader(admin) },
    });

    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toContain('attachment;');
    expect(exported.headers['content-disposition']).toContain('mozi-audit-default-');
    expect(exported.body).toContain('config.update');
    expect(exported.body).toContain('***REDACTED***');
    expect(exported.body).not.toContain(fakeApiKey);
    expect(exported.body).not.toContain('payload.signature');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/audit/export?format=csv',
      headers: { cookie: cookieHeader(viewer) },
    });
    expect(denied.statusCode).toBe(403);
  });
});

async function createApp(): Promise<FastifyInstance> {
  const fastify = Fastify();
  await registerApiRoutes(fastify, {
    jwtSecret: 'test-secret',
    config: {
      server: { auth_mode: 'local', host: '127.0.0.1' },
      security: { enterprise: {}, registration: 'open' },
      http_rate_limit: { global_rpm: 1000, auth_rpm: 1000, pair_rpm: 1000 },
    },
  });
  return fastify;
}

function registerUser(
  fastify: FastifyInstance,
  payload: { email: string; password: string; name?: string },
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
