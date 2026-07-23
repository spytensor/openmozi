/**
 * Tenant isolation through the production stores.
 *
 * There is intentionally no generic SQL wrapper: every production store owns
 * its tenant predicate, and these tests exercise those real entry points.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createSession, getSession, listSessions } from '../memory/sessions.js';
import {
  getTenantApiKey,
  listTenantApiKeys,
  resetTenantKeysTableFlag,
  upsertTenantApiKey,
} from '../security/tenant-keys.js';
import {
  checkQuota,
  consumeQuota,
  resetQuotaTableFlag,
  setQuotaLimit,
} from '../security/quota.js';

let tmpDir: string;

beforeEach(() => {
  ({ tmpDir } = setupTestDb());
  resetTenantKeysTableFlag();
  resetQuotaTableFlag();
});

afterEach(() => teardownTestDb(tmpDir));

describe('production tenant isolation', () => {
  it('scopes session reads and lists by tenant', () => {
    const alpha = createSession('shared-user', 'alpha', 'tenant-alpha');
    const beta = createSession('shared-user', 'beta', 'tenant-beta');

    expect(getSession(alpha.id, 'tenant-beta')).toBeNull();
    expect(getSession(beta.id, 'tenant-alpha')).toBeNull();
    expect(listSessions('shared-user', { tenantId: 'tenant-alpha' }).map((row) => row.id)).toEqual([alpha.id]);
    expect(listSessions('shared-user', { tenantId: 'tenant-beta' }).map((row) => row.id)).toEqual([beta.id]);
  });

  it('never exposes another tenant API key through production key APIs', () => {
    const master = 'tenant-isolation-test-master-secret';
    upsertTenantApiKey('tenant-alpha', 'openai', 'sk-alpha-secret', master);
    upsertTenantApiKey('tenant-beta', 'openai', 'sk-beta-secret', master);

    expect(getTenantApiKey('tenant-alpha', 'openai', master)).toBe('sk-alpha-secret');
    expect(getTenantApiKey('tenant-beta', 'openai', master)).toBe('sk-beta-secret');
    expect(listTenantApiKeys('tenant-alpha')).toHaveLength(1);
    expect(listTenantApiKeys('tenant-beta')).toHaveLength(1);
  });

  it('accounts and enforces quota independently per tenant', () => {
    setQuotaLimit('tenant-alpha', 'tokens', 10);
    setQuotaLimit('tenant-beta', 'tokens', 100);
    expect(consumeQuota('tenant-alpha', 'tokens', 8).allowed).toBe(true);
    expect(consumeQuota('tenant-alpha', 'tokens', 3).allowed).toBe(false);
    expect(checkQuota('tenant-beta', 'tokens', 50)).toMatchObject({ allowed: true, used: 0, limit: 100 });
  });
});
