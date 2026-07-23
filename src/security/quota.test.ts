/**
 * Tests for per-tenant quota enforcement (#238)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  checkQuota,
  consumeQuota,
  getQuotaStatus,
  setQuotaLimit,
  resetQuotaUsage,
  getCurrentPeriod,
  resetQuotaTableFlag,
  QUOTA_RESOURCES,
} from './quota.js';

let tmpDir: string;

beforeEach(() => {
  ({ tmpDir } = setupTestDb());
  resetQuotaTableFlag();
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

// ---------------------------------------------------------------------------
// getCurrentPeriod
// ---------------------------------------------------------------------------

describe('getCurrentPeriod()', () => {
  it('returns a YYYY-MM string', () => {
    const period = getCurrentPeriod();
    expect(period).toMatch(/^\d{4}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// checkQuota
// ---------------------------------------------------------------------------

describe('checkQuota()', () => {
  it('returns allowed=true and limit=null when no limit is configured', () => {
    const result = checkQuota('tenant-a', 'tokens', 100);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
    expect(result.remaining).toBeNull();
    expect(result.used).toBe(0);
  });

  it('returns allowed=true when under limit', () => {
    setQuotaLimit('tenant-a', 'tokens', 1000);
    const result = checkQuota('tenant-a', 'tokens', 100);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(1000);
    expect(result.remaining).toBe(1000);
  });

  it('returns allowed=false when check amount would exceed limit', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    consumeQuota('tenant-a', 'tokens', 90);
    const result = checkQuota('tenant-a', 'tokens', 20); // 90 + 20 > 100
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(90);
    expect(result.remaining).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// consumeQuota
// ---------------------------------------------------------------------------

describe('consumeQuota()', () => {
  it('increments usage when no limit is set (unlimited)', () => {
    const result = consumeQuota('tenant-a', 'api_calls', 5);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(5);
    expect(result.limit).toBeNull();
  });

  it('increments usage when under limit', () => {
    setQuotaLimit('tenant-a', 'tokens', 1000);
    const r1 = consumeQuota('tenant-a', 'tokens', 300);
    expect(r1.allowed).toBe(true);
    expect(r1.used).toBe(300);

    const r2 = consumeQuota('tenant-a', 'tokens', 500);
    expect(r2.allowed).toBe(true);
    expect(r2.used).toBe(800);
  });

  it('denies when limit would be exceeded', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    consumeQuota('tenant-a', 'tokens', 80);
    const result = consumeQuota('tenant-a', 'tokens', 30); // 80 + 30 > 100
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(80); // usage not changed
    expect(result.limit).toBe(100);
  });

  it('allows consuming exactly up to the limit', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    const result = consumeQuota('tenant-a', 'tokens', 100);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(100);
  });

  it('denies any further consumption after limit is reached', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    consumeQuota('tenant-a', 'tokens', 100);
    const result = consumeQuota('tenant-a', 'tokens', 1);
    expect(result.allowed).toBe(false);
  });

  it('accepts a custom period', () => {
    setQuotaLimit('tenant-a', 'tokens', 1000);
    const r = consumeQuota('tenant-a', 'tokens', 50, '2025-01');
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// getQuotaStatus
// ---------------------------------------------------------------------------

describe('getQuotaStatus()', () => {
  it('returns empty array when no usage or limits', () => {
    const status = getQuotaStatus('tenant-a');
    expect(status).toHaveLength(0);
  });

  it('includes resources with usage', () => {
    consumeQuota('tenant-a', 'api_calls', 5);
    const status = getQuotaStatus('tenant-a');
    const entry = status.find((s) => s.resource === 'api_calls');
    expect(entry).toBeDefined();
    expect(entry!.used).toBe(5);
  });

  it('includes resources with limits but no usage', () => {
    setQuotaLimit('tenant-a', 'tokens', 1000);
    const status = getQuotaStatus('tenant-a');
    const entry = status.find((s) => s.resource === 'tokens');
    expect(entry).toBeDefined();
    expect(entry!.used).toBe(0);
    expect(entry!.limit).toBe(1000);
    expect(entry!.remaining).toBe(1000);
  });

  it('each entry has resource, period, used, limit, remaining fields', () => {
    setQuotaLimit('tenant-a', 'tokens', 500);
    consumeQuota('tenant-a', 'tokens', 200);
    const status = getQuotaStatus('tenant-a');
    const entry = status[0];
    expect(entry).toHaveProperty('resource');
    expect(entry).toHaveProperty('period');
    expect(entry).toHaveProperty('used');
    expect(entry).toHaveProperty('limit');
    expect(entry).toHaveProperty('remaining');
    expect(entry.remaining).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// setQuotaLimit
// ---------------------------------------------------------------------------

describe('setQuotaLimit()', () => {
  it('sets a new limit', () => {
    setQuotaLimit('tenant-a', 'tokens', 5000);
    const result = checkQuota('tenant-a', 'tokens', 0);
    expect(result.limit).toBe(5000);
  });

  it('updates an existing limit', () => {
    setQuotaLimit('tenant-a', 'tokens', 1000);
    setQuotaLimit('tenant-a', 'tokens', 2000);
    const result = checkQuota('tenant-a', 'tokens', 0);
    expect(result.limit).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// resetQuotaUsage
// ---------------------------------------------------------------------------

describe('resetQuotaUsage()', () => {
  it('resets all usage for a tenant', () => {
    consumeQuota('tenant-a', 'tokens', 100);
    consumeQuota('tenant-a', 'api_calls', 50);
    const count = resetQuotaUsage('tenant-a');
    expect(count).toBe(2);
    const status = getQuotaStatus('tenant-a');
    const usedRows = status.filter((s) => s.used > 0);
    expect(usedRows).toHaveLength(0);
  });

  it('resets only the specified resource', () => {
    consumeQuota('tenant-a', 'tokens', 100);
    consumeQuota('tenant-a', 'api_calls', 50);
    resetQuotaUsage('tenant-a', 'tokens');
    const tokensResult = checkQuota('tenant-a', 'tokens', 0);
    expect(tokensResult.used).toBe(0);
    const callsResult = checkQuota('tenant-a', 'api_calls', 0);
    expect(callsResult.used).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------

describe('Cross-tenant isolation', () => {
  it('tenant A quota does not affect tenant B', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    setQuotaLimit('tenant-b', 'tokens', 100);

    consumeQuota('tenant-a', 'tokens', 100);

    // tenant-a is at limit
    const aResult = consumeQuota('tenant-a', 'tokens', 1);
    expect(aResult.allowed).toBe(false);

    // tenant-b still has full quota
    const bResult = consumeQuota('tenant-b', 'tokens', 100);
    expect(bResult.allowed).toBe(true);
  });

  it('resetQuotaUsage only resets own tenant', () => {
    consumeQuota('tenant-a', 'tokens', 50);
    consumeQuota('tenant-b', 'tokens', 50);
    resetQuotaUsage('tenant-a');
    const bStatus = getQuotaStatus('tenant-b');
    const bTokens = bStatus.find((s) => s.resource === 'tokens');
    expect(bTokens?.used).toBe(50);
  });

  it('limits for tenant A do not apply to tenant B', () => {
    setQuotaLimit('tenant-a', 'tokens', 50);
    // tenant-b has no limit — should succeed
    const result = consumeQuota('tenant-b', 'tokens', 999);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Period rollover
// ---------------------------------------------------------------------------

describe('Period rollover', () => {
  it('usage in different periods is independent', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    consumeQuota('tenant-a', 'tokens', 80, '2025-12');
    // Start fresh in a new period
    const result = consumeQuota('tenant-a', 'tokens', 80, '2026-01');
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(80);
  });

  it('checkQuota only looks at the current period', () => {
    setQuotaLimit('tenant-a', 'tokens', 100);
    // Consume usage in a past period (should not affect current)
    consumeQuota('tenant-a', 'tokens', 100, '2020-01');
    const result = checkQuota('tenant-a', 'tokens', 50);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QUOTA_RESOURCES constants
// ---------------------------------------------------------------------------

describe('QUOTA_RESOURCES', () => {
  it('defines standard resource names', () => {
    expect(QUOTA_RESOURCES.LLM_CALLS).toBe('llm_calls');
    expect(QUOTA_RESOURCES.TOKENS_USED).toBe('tokens_used');
    expect(QUOTA_RESOURCES.STORAGE_BYTES).toBe('storage_bytes');
    expect(QUOTA_RESOURCES.CONCURRENT_SESSIONS).toBe('concurrent_sessions');
  });
});
