/**
 * Tests for resource limits (#242)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LIMITS,
  TRUSTED_LIMITS,
  getResourceLimits,
  setTenantLimits,
  setUserLimits,
  clearLimitOverrides,
  clampLimits,
} from './limits.js';

beforeEach(() => {
  clearLimitOverrides();
});

describe('DEFAULT_LIMITS', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_LIMITS.memory_mb).toBe(512);
    expect(DEFAULT_LIMITS.cpu_shares).toBe(512);
    expect(DEFAULT_LIMITS.disk_mb).toBe(1024);
    expect(DEFAULT_LIMITS.max_processes).toBe(50);
    expect(DEFAULT_LIMITS.network_enabled).toBe(false);
  });
});

describe('getResourceLimits()', () => {
  it('returns DEFAULT_LIMITS when no overrides set', () => {
    const limits = getResourceLimits('tenant-x');
    expect(limits).toEqual(DEFAULT_LIMITS);
  });

  it('applies tenant-level overrides', () => {
    setTenantLimits('tenant-a', { memory_mb: 1024 });
    const limits = getResourceLimits('tenant-a');
    expect(limits.memory_mb).toBe(1024);
    // Other fields still default
    expect(limits.max_processes).toBe(DEFAULT_LIMITS.max_processes);
  });

  it('applies user-level overrides on top of tenant', () => {
    setTenantLimits('tenant-a', { memory_mb: 1024, cpu_shares: 512 });
    setUserLimits('tenant-a', 'power-user', { memory_mb: 2048 });
    const limits = getResourceLimits('tenant-a', 'power-user');
    expect(limits.memory_mb).toBe(2048); // user wins
    expect(limits.cpu_shares).toBe(512); // tenant wins over default
  });

  it('user override does not affect other users in same tenant', () => {
    setUserLimits('tenant-a', 'user-x', { network_enabled: true });
    const regularLimits = getResourceLimits('tenant-a', 'other-user');
    expect(regularLimits.network_enabled).toBe(DEFAULT_LIMITS.network_enabled);
  });

  it('tenant override does not affect other tenants', () => {
    setTenantLimits('tenant-a', { memory_mb: 128 });
    const bLimits = getResourceLimits('tenant-b');
    expect(bLimits.memory_mb).toBe(DEFAULT_LIMITS.memory_mb);
  });

  it('handles missing userId gracefully', () => {
    setTenantLimits('tenant-a', { memory_mb: 256 });
    const limits = getResourceLimits('tenant-a');
    expect(limits.memory_mb).toBe(256);
  });
});

describe('clampLimits()', () => {
  it('clamps memory to minimum 64 MB', () => {
    const clamped = clampLimits({ ...DEFAULT_LIMITS, memory_mb: 0 });
    expect(clamped.memory_mb).toBe(64);
  });

  it('clamps max_processes to minimum 5', () => {
    const clamped = clampLimits({ ...DEFAULT_LIMITS, max_processes: 0 });
    expect(clamped.max_processes).toBe(5);
  });

  it('does not change values already above minimums', () => {
    const clamped = clampLimits(TRUSTED_LIMITS);
    expect(clamped.memory_mb).toBe(TRUSTED_LIMITS.memory_mb);
  });
});
