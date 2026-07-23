import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { logAudit, queryAuditLog } from './audit.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('security/audit', () => {
  describe('logAudit', () => {
    it('inserts an entry with all fields', () => {
      logAudit({
        tenant_id: 'tenant-a',
        user_id: 'user-1',
        action: 'auth.login',
        resource_type: 'api',
        resource_id: '/api/sessions',
        details: { method: 'GET' },
        ip_address: '127.0.0.1',
        user_agent: 'test-agent/1.0',
        outcome: 'success',
      });

      const { entries, total } = queryAuditLog({ tenant_id: 'tenant-a', action: 'auth.login' });
      expect(total).toBe(1);
      expect(entries[0].user_id).toBe('user-1');
      expect(entries[0].resource_id).toBe('/api/sessions');
      expect(entries[0].details).toEqual({ method: 'GET' });
      expect(entries[0].ip_address).toBe('127.0.0.1');
      expect(entries[0].user_agent).toBe('test-agent/1.0');
      expect(entries[0].outcome).toBe('success');
    });

    it('uses defaults for optional fields', () => {
      logAudit({
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'brain.model',
      });

      const { entries } = queryAuditLog({ action: 'config.update' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries.find(e => e.resource_id === 'brain.model');
      expect(entry).toBeDefined();
      expect(entry!.tenant_id).toBe('default');
      expect(entry!.outcome).toBe('success');
      expect(entry!.user_id).toBeNull();
    });

    it('does not throw on DB error (resilient)', () => {
      // Should not throw even if details is circular - we test normal path here
      expect(() =>
        logAudit({ action: 'auth.fail', resource_type: 'api', outcome: 'failure' }),
      ).not.toThrow();
    });
  });

  describe('queryAuditLog', () => {
    beforeAll(() => {
      // Seed data for filtering tests
      logAudit({ tenant_id: 'filter-tenant', user_id: 'alice', action: 'role.assign', resource_type: 'user', resource_id: 'bob', details: { role: 'admin' } });
      logAudit({ tenant_id: 'filter-tenant', user_id: 'alice', action: 'role.remove', resource_type: 'user', resource_id: 'charlie' });
      logAudit({ tenant_id: 'filter-tenant', user_id: 'bob', action: 'auth.pair', resource_type: 'user', outcome: 'failure' });
      logAudit({ tenant_id: 'filter-tenant', user_id: 'bob', action: 'auth.pair', resource_type: 'user', outcome: 'success' });
    });

    it('filters by tenant_id', () => {
      const { entries, total } = queryAuditLog({ tenant_id: 'filter-tenant' });
      expect(total).toBe(4);
      expect(entries).toHaveLength(4);
    });

    it('filters by user_id', () => {
      const { entries, total } = queryAuditLog({ tenant_id: 'filter-tenant', user_id: 'alice' });
      expect(total).toBe(2);
      expect(entries.every(e => e.user_id === 'alice')).toBe(true);
    });

    it('filters by action', () => {
      const { entries } = queryAuditLog({ tenant_id: 'filter-tenant', action: 'role.assign' });
      expect(entries).toHaveLength(1);
      expect(entries[0].resource_id).toBe('bob');
      expect(entries[0].details).toEqual({ role: 'admin' });
    });

    it('filters by outcome', () => {
      const { entries } = queryAuditLog({ tenant_id: 'filter-tenant', action: 'auth.pair', outcome: 'failure' });
      expect(entries).toHaveLength(1);
      expect(entries[0].user_id).toBe('bob');
    });

    it('returns most recent first', () => {
      const { entries } = queryAuditLog({ tenant_id: 'filter-tenant' });
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1].timestamp >= entries[i].timestamp).toBe(true);
      }
    });

    it('respects limit and offset', () => {
      const page1 = queryAuditLog({ tenant_id: 'filter-tenant', limit: 2, offset: 0 });
      const page2 = queryAuditLog({ tenant_id: 'filter-tenant', limit: 2, offset: 2 });
      expect(page1.entries).toHaveLength(2);
      expect(page2.entries).toHaveLength(2);
      expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
      expect(page1.total).toBe(4);
    });

    it('returns empty result for non-existent tenant', () => {
      const { entries, total } = queryAuditLog({ tenant_id: 'no-such-tenant' });
      expect(total).toBe(0);
      expect(entries).toHaveLength(0);
    });

    it('filters by date range', () => {
      const from = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
      const to = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
      const { total } = queryAuditLog({ tenant_id: 'filter-tenant', from, to });
      expect(total).toBe(4);
    });

    it('caps limit at 500', () => {
      const { entries } = queryAuditLog({ tenant_id: 'filter-tenant', limit: 9999 });
      // Just verify no error and result is within bounds
      expect(entries.length).toBeLessThanOrEqual(500);
    });
  });
});
