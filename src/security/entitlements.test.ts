import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { loadConfig } from '../config/index.js';
import {
  ModelNotAllowedError,
  QuotaExceededError,
  isModelAllowed,
  precheckTenantTokenQuota,
  resolveAllowedModels,
} from './entitlements.js';

let tmpDir = '';
const configDirs: string[] = [];

beforeEach(() => {
  const setup = setupTestDb();
  tmpDir = setup.tmpDir;
  loadAuthMode('local');
});

afterEach(() => {
  if (tmpDir) {
    teardownTestDb(tmpDir);
    tmpDir = '';
  }
  for (const dir of configDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  loadConfig('/nonexistent/mozi.json');
});

describe('security/entitlements', () => {
  it('returns unrestricted when tenant ceiling and user grant are both null', () => {
    seedUser('tenant-a', 'user-a', null);

    expect(resolveAllowedModels('tenant-a', 'user-a')).toEqual({
      models: null,
      source: 'unrestricted',
    });
    expect(isModelAllowed('tenant-a', 'user-a', 'gpt-4.1')).toBe(true);
  });

  it('uses the tenant ceiling when the user grant is null', () => {
    seedTenantCeiling('tenant-a', ['gpt-4.1-mini', 'claude-sonnet-4-20250514']);
    seedUser('tenant-a', 'user-a', null);

    expect(resolveAllowedModels('tenant-a', 'user-a')).toEqual({
      models: ['gpt-4.1-mini', 'claude-sonnet-4-20250514'],
      source: 'tenant_ceiling',
    });
    expect(isModelAllowed('tenant-a', 'user-a', 'gpt-4.1-mini')).toBe(true);
    expect(isModelAllowed('tenant-a', 'user-a', 'gpt-4.1')).toBe(false);
  });

  it('uses the user grant when the tenant ceiling is unrestricted', () => {
    seedUser('tenant-a', 'user-a', ['gpt-4.1-mini', 'claude-sonnet-4-20250514']);

    expect(resolveAllowedModels('tenant-a', 'user-a')).toEqual({
      models: ['gpt-4.1-mini', 'claude-sonnet-4-20250514'],
      source: 'user_grant',
    });
  });

  it('intersects tenant ceiling and user grant', () => {
    seedTenantCeiling('tenant-a', ['gpt-4.1', 'gpt-4.1-mini']);
    seedUser('tenant-a', 'user-a', ['gpt-4.1-mini', 'claude-sonnet-4-20250514']);

    expect(resolveAllowedModels('tenant-a', 'user-a')).toEqual({
      models: ['gpt-4.1-mini'],
      source: 'intersection',
    });
  });

  it('returns an empty effective set for disjoint tenant and user grants', () => {
    seedTenantCeiling('tenant-a', ['gpt-4.1']);
    seedUser('tenant-a', 'user-a', ['claude-sonnet-4-20250514']);

    const resolved = resolveAllowedModels('tenant-a', 'user-a');
    expect(resolved).toEqual({ models: [], source: 'intersection' });
    expect(() => {
      if (!isModelAllowed('tenant-a', 'user-a', 'gpt-4.1')) {
        throw new ModelNotAllowedError('tenant-a', 'user-a', 'gpt-4.1', resolved.models);
      }
    }).toThrow(/Allowed models: none/);
  });

  it('returns unrestricted in personal auth mode when no tenant quota row exists', () => {
    loadAuthMode('none');

    expect(resolveAllowedModels('default', 'local-user')).toEqual({
      models: null,
      source: 'personal_mode',
    });
    expect(isModelAllowed('default', 'local-user', 'any-model')).toBe(true);
    expect(precheckTenantTokenQuota('default')).toEqual({
      checked: false,
      dailyTokens: 0,
      monthlyTokens: 0,
    });
  });

  it('applies tenant model grants in personal auth mode and skips user grants', () => {
    loadAuthMode('none');
    seedTenantCeiling('default', ['gpt-4.1-mini']);
    seedUser('default', 'local-user', ['gpt-4.1']);

    expect(resolveAllowedModels('default', 'local-user')).toEqual({
      models: ['gpt-4.1-mini'],
      source: 'tenant_ceiling',
    });
    expect(isModelAllowed('default', 'local-user', 'gpt-4.1-mini')).toBe(true);
    expect(isModelAllowed('default', 'local-user', 'gpt-4.1')).toBe(false);
  });

  it('throws a typed quota error when daily usage is already over the limit', () => {
    seedTokenLimits('tenant-q', { daily: 100 });
    seedBilling('tenant-q', 80, 20);

    try {
      precheckTenantTokenQuota('tenant-q');
      throw new Error('expected quota error');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect(err).toMatchObject({
        code: 'quota_exceeded',
        limit: 'daily',
        limitTokens: 100,
        usedTokens: 100,
      });
      expect((err as QuotaExceededError).resetAt).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it('passes under-limit token quota checks and returns the per-turn sums', () => {
    seedTokenLimits('tenant-q-ok', { daily: 1000, monthly: 2000 });
    seedBilling('tenant-q-ok', 100, 50);

    expect(precheckTenantTokenQuota('tenant-q-ok')).toEqual({
      checked: true,
      dailyTokens: 150,
      monthlyTokens: 150,
    });
  });
});

function loadAuthMode(authMode: 'local' | 'none'): void {
  const dir = mkdtempSync(join(tmpdir(), 'mozi-entitlements-config-'));
  configDirs.push(dir);
  const configPath = join(dir, 'mozi.json');
  writeFileSync(configPath, JSON.stringify({ server: { auth_mode: authMode } }));
  loadConfig(configPath);
}

function seedTenantCeiling(tenantId: string, models: string[] | null): void {
  getDb().prepare(`
    INSERT INTO tenant_quotas (tenant_id, allowed_models)
    VALUES (?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET allowed_models = excluded.allowed_models
  `).run(tenantId, models === null ? null : JSON.stringify(models));
}

function seedTokenLimits(tenantId: string, limits: { daily?: number; monthly?: number }): void {
  getDb().prepare(`
    INSERT INTO tenant_quotas (tenant_id, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      daily_token_limit = excluded.daily_token_limit,
      monthly_token_limit = excluded.monthly_token_limit
  `).run(tenantId, limits.daily ?? 0, limits.monthly ?? 0);
}

function seedBilling(tenantId: string, inputTokens: number, outputTokens: number): void {
  getDb().prepare(`
    INSERT INTO billing_records (tenant_id, record_type, model, input_tokens, output_tokens, cost_usd, created_at)
    VALUES (?, 'llm_call', 'gpt-4.1-mini', ?, ?, 0, datetime('now'))
  `).run(tenantId, inputTokens, outputTokens);
}

function seedUser(tenantId: string, userId: string, models: string[] | null): void {
  getDb().prepare(`
    INSERT INTO users (id, tenant_id, email, auth_provider, provider_id, role, status, allowed_models)
    VALUES (?, ?, ?, 'local', ?, 'viewer', 'active', ?)
  `).run(
    userId,
    tenantId,
    `${userId}@example.com`,
    userId,
    models === null ? null : JSON.stringify(models),
  );
}
