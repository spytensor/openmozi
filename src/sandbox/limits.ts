/**
 * Resource limits per user/tenant (#242)
 *
 * Defines and resolves per-user resource limits used by Docker containers
 * and native execution sandboxing.
 *
 * Priority: user-level override > tenant-level override > DEFAULT_LIMITS
 */

import pino from 'pino';

const logger = pino({ name: 'mozi:sandbox:limits' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceLimits {
  /** Maximum RAM available to the container/process (MB). */
  memory_mb: number;
  /** CPU share weight (relative to other containers). 1024 = 1 full CPU. */
  cpu_shares: number;
  /** Maximum disk space in the workspace (MB). Not enforced at OS level — advisory. */
  disk_mb: number;
  /** Maximum number of processes/threads (pids limit). */
  max_processes: number;
  /** Whether outbound network is allowed. */
  network_enabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Sensible default limits for a sandboxed user session. */
export const DEFAULT_LIMITS: ResourceLimits = {
  memory_mb: 512,
  cpu_shares: 512,   // half a logical CPU
  disk_mb: 1024,
  max_processes: 50,
  network_enabled: false,
};

/** Permissive limits for trusted users or admin operations. */
export const TRUSTED_LIMITS: ResourceLimits = {
  memory_mb: 2048,
  cpu_shares: 1024,
  disk_mb: 4096,
  max_processes: 200,
  network_enabled: true,
};

// ---------------------------------------------------------------------------
// Tenant / user limit registry (in-memory, sourced from tenant config)
// ---------------------------------------------------------------------------

/**
 * In-memory override registry.
 * Key: `tenant:${tenantId}` or `user:${tenantId}:${userId}`
 */
const limitOverrides = new Map<string, Partial<ResourceLimits>>();

/** Set a tenant-level resource limit override. */
export function setTenantLimits(tenantId: string, limits: Partial<ResourceLimits>): void {
  limitOverrides.set(`tenant:${tenantId}`, limits);
  logger.debug({ tenantId, limits }, 'tenant limits updated');
}

/** Set a user-level resource limit override. */
export function setUserLimits(tenantId: string, userId: string, limits: Partial<ResourceLimits>): void {
  limitOverrides.set(`user:${tenantId}:${userId}`, limits);
  logger.debug({ tenantId, userId, limits }, 'user limits updated');
}

/** Clear all in-memory overrides (for tests). */
export function clearLimitOverrides(): void {
  limitOverrides.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Get the effective resource limits for a tenant+user combination.
 * Priority: user override > tenant override > DEFAULT_LIMITS
 */
export function getResourceLimits(tenantId: string, userId?: string): ResourceLimits {
  const base = { ...DEFAULT_LIMITS };

  // Apply tenant-level overrides
  const tenantKey = `tenant:${tenantId}`;
  const tenantOverride = limitOverrides.get(tenantKey);
  if (tenantOverride) Object.assign(base, tenantOverride);

  // Apply user-level overrides
  if (userId) {
    const userKey = `user:${tenantId}:${userId}`;
    const userOverride = limitOverrides.get(userKey);
    if (userOverride) Object.assign(base, userOverride);
  }

  return base;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a ResourceLimits object to safe minimums to prevent DoS via
 * accidentally zero or negative limits.
 */
export function clampLimits(limits: ResourceLimits): ResourceLimits {
  return {
    memory_mb: Math.max(64, limits.memory_mb),
    cpu_shares: Math.max(64, limits.cpu_shares),
    disk_mb: Math.max(128, limits.disk_mb),
    max_processes: Math.max(5, limits.max_processes),
    network_enabled: limits.network_enabled,
  };
}
