import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { logAudit } from '../security/audit.js';
import {
  exportAuditLog,
  queryAuditEntries,
  redactEntry,
  redactObject,
} from './audit.js';

let tmpDir: string;
const fakeSecret = (...parts: string[]) => parts.join('-');

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;

  // Seed some events for audit export tests
  logAudit({
    tenant_id: 'audit-tenant',
    user_id: 'user-1',
    action: 'session.create',
    resource_type: 'session',
    resource_id: 'task-1',
    details: { title: 'Test task' },
    outcome: 'success',
  });
  logAudit({
    tenant_id: 'audit-tenant',
    user_id: 'user-1',
    action: 'session.delete',
    resource_type: 'session',
    resource_id: 'task-1',
    details: { result: 'success' },
    outcome: 'success',
  });
  logAudit({
    tenant_id: 'audit-tenant',
    user_id: 'admin-1',
    action: 'token.revoke',
    resource_type: 'security',
    resource_id: 'key-1',
    details: {
      tenant_id: 'audit-tenant',
      name: 'test-key',
      token: fakeSecret('secret', 'value'),
    },
    outcome: 'success',
  });
  logAudit({
    tenant_id: 'audit-tenant',
    user_id: 'user-1',
    action: 'config.update',
    resource_type: 'billing',
    resource_id: 'call-1',
    details: {
      model: 'gpt-4',
      api_key: fakeSecret('sk', '1234567890'),
    },
    outcome: 'success',
  });
  logAudit({
    tenant_id: 'other-tenant',
    user_id: 'user-2',
    action: 'session.create',
    resource_type: 'session',
    resource_id: 'task-other',
    details: { title: 'Other' },
    outcome: 'success',
  });
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('tenants/audit', () => {
  describe('queryAuditEntries', () => {
    it('returns entries for a specific tenant', () => {
      const entries = queryAuditEntries('audit-tenant');
      expect(entries.length).toBeGreaterThanOrEqual(4);
      for (const e of entries) {
        expect(e.tenant_id).toBe('audit-tenant');
      }
    });

    it('does not include entries from other tenants', () => {
      const entries = queryAuditEntries('audit-tenant');
      const otherEntries = entries.filter(e => e.resource_id === 'task-other');
      expect(otherEntries.length).toBe(0);
    });

    it('filters by action', () => {
      const entries = queryAuditEntries('audit-tenant', undefined, undefined, 100, 'session.create');
      expect(entries.length).toBeGreaterThanOrEqual(1);
      for (const e of entries) {
        expect(e.action).toBe('session.create');
      }
    });

    it('respects limit', () => {
      const entries = queryAuditEntries('audit-tenant', undefined, undefined, 2);
      expect(entries.length).toBeLessThanOrEqual(2);
    });
  });

  describe('exportAuditLog', () => {
    it('exports as JSON', () => {
      const result = exportAuditLog({
        tenant_id: 'audit-tenant',
        format: 'json',
      });
      expect(result.format).toBe('json');
      expect(result.record_count).toBeGreaterThan(0);
      const parsed = JSON.parse(result.data);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('exports as CSV', () => {
      const result = exportAuditLog({
        tenant_id: 'audit-tenant',
        format: 'csv',
      });
      expect(result.format).toBe('csv');
      expect(result.record_count).toBeGreaterThan(0);
      // CSV should have header line
      const lines = result.data.split('\n');
      expect(lines[0]).toContain('id,timestamp,tenant_id,user_id,action');
      expect(lines.length).toBeGreaterThan(1);
    });

    it('redacts sensitive data in export', () => {
      const result = exportAuditLog({
        tenant_id: 'audit-tenant',
        format: 'json',
      });
      const parsed = JSON.parse(result.data);
      // Find the entry with api_key
      const keyEntry = parsed.find((e: any) => e.resource_id === 'call-1');
      if (keyEntry) {
        expect(keyEntry.details.api_key).toBe('***REDACTED***');
      }
    });

    it('returns empty result for unknown tenant', () => {
      const result = exportAuditLog({
        tenant_id: 'nonexistent',
        format: 'json',
      });
      expect(result.record_count).toBe(0);
    });
  });

  describe('redactObject', () => {
    it('redacts sensitive keys', () => {
      const result = redactObject({
        name: 'visible',
        token: fakeSecret('secret', 'token', 'value'),
        api_key: fakeSecret('sk', '12345'),
        password: 'hunter2',
      });
      expect(result.name).toBe('visible');
      expect(result.token).toBe('***REDACTED***');
      expect(result.api_key).toBe('***REDACTED***');
      expect(result.password).toBe('***REDACTED***');
    });

    it('masks JWT-looking values even in non-sensitive keys', () => {
      const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'signature'].join('.');
      const result = redactObject({
        auth_header: fakeJwt,
      });
      expect(result.auth_header).toContain('***');
      expect(result.auth_header).not.toContain('eyJzdWIiOiJ0ZXN0In0');
    });

    it('redacts nested objects', () => {
      const result = redactObject({
        config: {
          api_key: 'secret',
          host: 'example.com',
        },
      });
      expect((result.config as any).api_key).toBe('***REDACTED***');
      expect((result.config as any).host).toBe('example.com');
    });

    it('preserves non-sensitive data', () => {
      const result = redactObject({
        task_id: 'task-1',
        status: 'completed',
        count: 42,
      });
      expect(result.task_id).toBe('task-1');
      expect(result.status).toBe('completed');
      expect(result.count).toBe(42);
    });
  });

  describe('redactEntry', () => {
    it('returns entry with redacted payload', () => {
      const entry = {
        id: 1,
        timestamp: '2026-01-01',
        tenant_id: 'test',
        user_id: 'user-1',
        action: 'test',
        resource_type: 'test',
        resource_id: 'test',
        details: { secret: 'hidden', visible: 'shown' },
        ip_address: null,
        user_agent: null,
        outcome: 'success',
      };
      const redacted = redactEntry(entry);
      expect(redacted.details?.secret).toBe('***REDACTED***');
      expect(redacted.details?.visible).toBe('shown');
    });
  });
});
