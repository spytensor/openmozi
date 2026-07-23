import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb } from '../store/db.js';
import { runMigrations } from '../store/migrate.js';
import { registerTaskTemplateRoutes } from './task-template-routes.js';

let dir = '';

function appFor(tenantId: string, userId: string) {
  const app = Fastify();
  app.addHook('preHandler', async request => {
    (request as unknown as { tenantContext: { tenant_id: string; user_id: string; roles: string[] } }).tenantContext = {
      tenant_id: tenantId,
      user_id: userId,
      roles: ['viewer'],
    };
  });
  registerTaskTemplateRoutes(app);
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mozi-task-template-api-'));
  runMigrations(join(dir, 'test.db'));
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('task template routes', () => {
  it('persists and reorders templates for the authenticated owner', async () => {
    const app = appFor('tenant-a', 'user-a');
    const first = await app.inject({ method: 'POST', url: '/api/task-templates', payload: { title: 'Email', instructions: 'Summarize email' } });
    const second = await app.inject({ method: 'POST', url: '/api/task-templates', payload: { title: 'Translate', instructions: 'Translate draft' } });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().template.id as string;
    const secondId = second.json().template.id as string;

    const reordered = await app.inject({ method: 'PUT', url: '/api/task-templates/reorder', payload: { ids: [secondId, firstId] } });
    expect(reordered.json().templates.map((item: { id: string }) => item.id)).toEqual([secondId, firstId]);
    await app.close();
  });

  it('returns 404 for same-tenant and cross-tenant ownership violations', async () => {
    const owner = appFor('tenant-a', 'user-a');
    const created = await owner.inject({ method: 'POST', url: '/api/task-templates', payload: { title: 'Private', instructions: 'Secret rules' } });
    const id = created.json().template.id as string;
    await owner.close();

    for (const [tenantId, userId] of [['tenant-a', 'user-b'], ['tenant-b', 'user-a']]) {
      const foreign = appFor(tenantId, userId);
      expect((await foreign.inject({ method: 'GET', url: `/api/task-templates/${id}` })).statusCode).toBe(404);
      expect((await foreign.inject({ method: 'PUT', url: `/api/task-templates/${id}`, payload: { title: 'Stolen', instructions: 'No' } })).statusCode).toBe(404);
      expect((await foreign.inject({ method: 'DELETE', url: `/api/task-templates/${id}` })).statusCode).toBe(404);
      await foreign.close();
    }
  });

  it('rejects client attempts to supply identity fields', async () => {
    const app = appFor('tenant-a', 'user-a');
    const response = await app.inject({
      method: 'POST', url: '/api/task-templates',
      payload: { title: 'Spoof', instructions: 'No', tenant_id: 'tenant-b', user_id: 'user-b' },
    });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/task-templates' })).json().templates).toEqual([]);
    await app.close();
  });
});
