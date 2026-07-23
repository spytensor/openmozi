import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, createTempDir, removeTempDir } from '../test-helpers.js';
import {
  DEFAULT_TENANT_CONTEXT,
  extractTenantContext,
  payloadToContext,
  extractFromRequest,
  isValidTenantId,
  getTenantWorkspace,
  getTenantFilePath,
  logTenantEvent,
  type TenantContext,
} from './index.js';
import { sign } from '../security/jwt.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

const SECRET = 'test-secret-key-for-jwt';

describe('tenants/index', () => {
  describe('DEFAULT_TENANT_CONTEXT', () => {
    it('provides default context with tenant_id=default', () => {
      expect(DEFAULT_TENANT_CONTEXT.tenant_id).toBe('default');
      expect(DEFAULT_TENANT_CONTEXT.user_id).toBe('system');
      expect(DEFAULT_TENANT_CONTEXT.roles).toContain('admin');
    });
  });

  describe('isValidTenantId', () => {
    it('accepts valid tenant IDs', () => {
      expect(isValidTenantId('default')).toBe(true);
      expect(isValidTenantId('tenant-123')).toBe(true);
      expect(isValidTenantId('ACME_Corp')).toBe(true);
      expect(isValidTenantId('a')).toBe(true);
    });

    it('rejects invalid tenant IDs', () => {
      expect(isValidTenantId('')).toBe(false);
      expect(isValidTenantId('a'.repeat(65))).toBe(false);
      expect(isValidTenantId('tenant with spaces')).toBe(false);
      expect(isValidTenantId('tenant/slash')).toBe(false);
      expect(isValidTenantId('tenant.dot')).toBe(false);
    });
  });

  describe('extractTenantContext', () => {
    it('extracts context from JWT with tenant_id and roles', () => {
      const token = sign('user-1', SECRET, 3600, {
        tenant_id: 'acme',
        roles: ['admin'],
      });

      const ctx = extractTenantContext(token, SECRET);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('acme');
      expect(ctx!.user_id).toBe('user-1');
      expect(ctx!.roles).toEqual(['admin']);
    });

    it('defaults tenant_id to default when not in JWT', () => {
      const token = sign('user-2', SECRET, 3600);
      const ctx = extractTenantContext(token, SECRET);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('default');
    });

    it('defaults roles to viewer when not in JWT', () => {
      const token = sign('user-3', SECRET, 3600, { tenant_id: 'test' });
      const ctx = extractTenantContext(token, SECRET);
      expect(ctx).not.toBeNull();
      expect(ctx!.roles).toEqual(['viewer']);
    });

    it('returns null for invalid token', () => {
      expect(extractTenantContext('invalid-token', SECRET)).toBeNull();
    });

    it('returns null for expired token', () => {
      const token = sign('user-4', SECRET, -10);
      expect(extractTenantContext(token, SECRET)).toBeNull();
    });
  });

  describe('payloadToContext', () => {
    it('converts JWT payload to TenantContext', () => {
      const ctx = payloadToContext({
        sub: 'user-5',
        iat: 0,
        exp: 999999999999,
        tenant_id: 'corp-a',
        roles: ['operator', 'viewer'],
      });
      expect(ctx.tenant_id).toBe('corp-a');
      expect(ctx.user_id).toBe('user-5');
      expect(ctx.roles).toEqual(['operator', 'viewer']);
    });

    it('filters non-string roles', () => {
      const ctx = payloadToContext({
        sub: 'user-6',
        iat: 0,
        exp: 999999999999,
        roles: ['admin', 123, null, 'viewer'] as unknown as string[],
      });
      expect(ctx.roles).toEqual(['admin', 'viewer']);
    });
  });

  describe('extractFromRequest', () => {
    it('extracts from Authorization Bearer header', () => {
      const token = sign('user-7', SECRET, 3600, { tenant_id: 'from-header', roles: ['admin'] });
      const ctx = extractFromRequest(
        { authorization: `Bearer ${token}` },
        {},
        SECRET,
      );
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('from-header');
    });

    it('extracts from query token param', () => {
      const token = sign('user-8', SECRET, 3600, { tenant_id: 'from-query', roles: ['viewer'] });
      const ctx = extractFromRequest({}, { token }, SECRET);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('from-query');
    });

    it('returns null when no auth present', () => {
      expect(extractFromRequest({}, {}, SECRET)).toBeNull();
    });
  });

  describe('getTenantWorkspace', () => {
    it('creates tenant workspace directories', () => {
      const workspace = getTenantWorkspace('test-tenant-ws');
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(join(workspace, 'memory'))).toBe(true);
      expect(existsSync(join(workspace, 'skills'))).toBe(true);
      expect(existsSync(join(workspace, 'agents'))).toBe(true);
    });
  });

  describe('getTenantFilePath', () => {
    it('returns correct tenant file path', () => {
      const path = getTenantFilePath('my-tenant', 'memory', 'MEMORY.md');
      expect(path).toContain('my-tenant');
      expect(path).toContain('memory');
      expect(path).toContain('MEMORY.md');
    });
  });

  describe('logTenantEvent', () => {
    it('logs an event without throwing', () => {
      expect(() => logTenantEvent('default', 'tenant_created', { info: 'test' })).not.toThrow();
    });
  });
});
