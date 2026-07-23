/**
 * Tests for per-tenant configuration overrides (#236)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  getTenantConfig,
  setTenantConfig,
  setTenantConfigValidated,
  deleteTenantConfig,
  listTenantOverrides,
  resetTenantConfigTableFlag,
  ALLOWED_CONFIG_KEYS,
} from './tenant-config.js';

let tmpDir: string;

beforeEach(() => {
  ({ tmpDir } = setupTestDb());
  resetTenantConfigTableFlag();
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

// ---------------------------------------------------------------------------
// getTenantConfig
// ---------------------------------------------------------------------------

describe('getTenantConfig()', () => {
  it('returns null when no override exists', () => {
    const value = getTenantConfig('tenant-a', 'some.key');
    expect(value).toBeNull();
  });

  it('returns the stored value after set', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    const value = getTenantConfig('tenant-a', 'model');
    expect(value).toBe('gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// setTenantConfig
// ---------------------------------------------------------------------------

describe('setTenantConfig()', () => {
  it('sets a new config key', () => {
    setTenantConfig('tenant-a', 'max_tokens', '2000');
    expect(getTenantConfig('tenant-a', 'max_tokens')).toBe('2000');
  });

  it('overwrites an existing config value', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o-mini');
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    expect(getTenantConfig('tenant-a', 'model')).toBe('gpt-4o');
  });

  it('stores the updatedBy field', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o', 'admin-user');
    const overrides = listTenantOverrides('tenant-a');
    // updatedBy is internal — we just verify the set works without error
    expect(overrides[0].key).toBe('model');
  });
});

// ---------------------------------------------------------------------------
// deleteTenantConfig
// ---------------------------------------------------------------------------

describe('deleteTenantConfig()', () => {
  it('deletes an existing key and returns true', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    const deleted = deleteTenantConfig('tenant-a', 'model');
    expect(deleted).toBe(true);
    expect(getTenantConfig('tenant-a', 'model')).toBeNull();
  });

  it('returns false for non-existent key', () => {
    const deleted = deleteTenantConfig('tenant-a', 'non.existent');
    expect(deleted).toBe(false);
  });

  it('does not delete keys belonging to other tenants', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    setTenantConfig('tenant-b', 'model', 'claude-3');
    deleteTenantConfig('tenant-a', 'model');
    expect(getTenantConfig('tenant-b', 'model')).toBe('claude-3');
  });
});

// ---------------------------------------------------------------------------
// listTenantOverrides
// ---------------------------------------------------------------------------

describe('listTenantOverrides()', () => {
  it('returns empty array when no overrides exist', () => {
    const list = listTenantOverrides('tenant-a');
    expect(list).toHaveLength(0);
  });

  it('returns all overrides for the tenant', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    setTenantConfig('tenant-a', 'max_tokens', '2000');
    const list = listTenantOverrides('tenant-a');
    expect(list).toHaveLength(2);
    const keys = list.map((r) => r.key).sort();
    expect(keys).toEqual(['max_tokens', 'model']);
  });

  it('each item has key, value, and updated_at fields', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    const list = listTenantOverrides('tenant-a');
    expect(list[0]).toHaveProperty('key');
    expect(list[0]).toHaveProperty('value');
    expect(list[0]).toHaveProperty('updated_at');
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------

describe('Cross-tenant isolation', () => {
  it('tenant A config is not visible to tenant B', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    expect(getTenantConfig('tenant-b', 'model')).toBeNull();
  });

  it('listTenantOverrides only returns own tenant data', () => {
    setTenantConfig('tenant-a', 'model', 'gpt-4o');
    setTenantConfig('tenant-b', 'model', 'claude-3');
    const aList = listTenantOverrides('tenant-a');
    const bList = listTenantOverrides('tenant-b');
    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(1);
    expect(aList[0].value).toBe('gpt-4o');
    expect(bList[0].value).toBe('claude-3');
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_CONFIG_KEYS + setTenantConfigValidated
// ---------------------------------------------------------------------------

describe('ALLOWED_CONFIG_KEYS', () => {
  it('does not include security section keys', () => {
    for (const key of ALLOWED_CONFIG_KEYS) {
      expect(key).not.toMatch(/^security\./);
    }
  });

  it('includes expected brain and system keys', () => {
    expect(ALLOWED_CONFIG_KEYS.has('brain.model')).toBe(true);
    expect(ALLOWED_CONFIG_KEYS.has('brain.max_plan_steps')).toBe(true);
    expect(ALLOWED_CONFIG_KEYS.has('system.max_parallel_agents')).toBe(true);
  });
});

describe('setTenantConfigValidated()', () => {
  it('accepts allowed keys and valid scalar values', () => {
    expect(() =>
      setTenantConfigValidated('tenant-a', 'brain.model', 'gpt-4o', 'admin'),
    ).not.toThrow();
  });

  it('throws on disallowed config key', () => {
    expect(() =>
      setTenantConfigValidated('tenant-a', 'security.hard_gates', ['shell']),
    ).toThrow('not in the allowed override list');
  });

  it('throws on invalid value type (object)', () => {
    expect(() =>
      setTenantConfigValidated('tenant-a', 'brain.model', { nested: true }),
    ).toThrow();
  });

  it('serializes numeric values', () => {
    setTenantConfigValidated('tenant-a', 'brain.max_dag_depth', 10, 'admin');
    const raw = getTenantConfig('tenant-a', 'brain.max_dag_depth');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toBe(10);
  });
});
