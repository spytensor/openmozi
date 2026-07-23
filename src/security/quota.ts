/**
 * Per-tenant quota enforcement (#238)
 *
 * Tracks resource usage per tenant and enforces limits configured
 * in tenant_quota_limits. Quota periods default to monthly (YYYY-MM).
 *
 * Routes:
 *   GET /api/quotas              → getQuotaStatus (own tenant)
 *   PUT /api/quotas/:tenantId    → setQuotaLimit (admin only)
 */

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';

const logger = pino({ name: 'mozi:security:quota' });

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_quota_limits (
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      limit_value REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(tenant_id, resource)
    );
    CREATE TABLE IF NOT EXISTS quota_usage (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      period TEXT NOT NULL,
      used REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, resource, period)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_usage_tenant ON quota_usage(tenant_id, resource, period);
  `);
  tableReady = true;
}

/** Reset table-ready flag (for tests). */
export function resetQuotaTableFlag(): void {
  tableReady = false;
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current period as a YYYY-MM string (e.g. '2026-03').
 */
export function getCurrentPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export interface QuotaConsumeResult {
  allowed: boolean;
  used: number;
  limit: number | null;
}

export interface QuotaStatusEntry {
  resource: string;
  period: string;
  used: number;
  limit: number | null;
  remaining: number | null;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Check current usage for a resource WITHOUT consuming quota.
 * Returns whether the requested amount would be allowed.
 */
export function checkQuota(
  tenantId: string,
  resource: string,
  amount = 0,
): QuotaCheckResult {
  ensureTable();
  const db = getDb();
  const period = getCurrentPeriod();

  const usageRow = db
    .prepare(
      'SELECT used FROM quota_usage WHERE tenant_id = ? AND resource = ? AND period = ?',
    )
    .get(tenantId, resource, period) as { used: number } | undefined;
  const used = usageRow?.used ?? 0;

  const limitRow = db
    .prepare('SELECT limit_value FROM tenant_quota_limits WHERE tenant_id = ? AND resource = ?')
    .get(tenantId, resource) as { limit_value: number } | undefined;
  const limit = limitRow?.limit_value ?? null;

  if (limit === null) {
    // No limit configured → unlimited
    return { allowed: true, used, limit: null, remaining: null };
  }

  const remaining = Math.max(0, limit - used);
  const allowed = used + amount <= limit;
  return { allowed, used, limit, remaining };
}

/**
 * Atomically consume quota for a resource.
 * Checks usage before consuming — returns allowed: false if limit would be exceeded.
 * Uses a SQLite transaction to prevent race conditions.
 */
export function consumeQuota(
  tenantId: string,
  resource: string,
  amount: number,
  period?: string,
): QuotaConsumeResult {
  ensureTable();
  const db = getDb();
  const effectivePeriod = period ?? getCurrentPeriod();

  const transact = db.transaction((): QuotaConsumeResult => {
    // Get current usage
    const usageRow = db
      .prepare(
        'SELECT used FROM quota_usage WHERE tenant_id = ? AND resource = ? AND period = ?',
      )
      .get(tenantId, resource, effectivePeriod) as { used: number } | undefined;
    const currentUsed = usageRow?.used ?? 0;

    // Get limit
    const limitRow = db
      .prepare(
        'SELECT limit_value FROM tenant_quota_limits WHERE tenant_id = ? AND resource = ?',
      )
      .get(tenantId, resource) as { limit_value: number } | undefined;
    const limit = limitRow?.limit_value ?? null;

    // Check if consuming would exceed the limit
    if (limit !== null && currentUsed + amount > limit) {
      return { allowed: false, used: currentUsed, limit };
    }

    // Atomically increment usage
    const newUsed = currentUsed + amount;
    db.prepare(`
      INSERT INTO quota_usage (id, tenant_id, resource, period, used, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(tenant_id, resource, period) DO UPDATE SET
        used = used + ?,
        updated_at = datetime('now')
    `).run(randomUUID(), tenantId, resource, effectivePeriod, amount, amount);

    return { allowed: true, used: newUsed, limit };
  });

  return transact();
}

/**
 * Get current quota status for all resources tracked by a tenant in the current period.
 */
export function getQuotaStatus(tenantId: string): QuotaStatusEntry[] {
  ensureTable();
  const db = getDb();
  const period = getCurrentPeriod();

  // Get all resources that either have usage or a limit for this tenant
  const rows = db.prepare(`
    SELECT
      COALESCE(u.resource, l.resource) AS resource,
      COALESCE(u.period, ?) AS period,
      COALESCE(u.used, 0) AS used,
      l.limit_value AS limit_value
    FROM quota_usage u
    FULL OUTER JOIN tenant_quota_limits l
      ON u.tenant_id = l.tenant_id AND u.resource = l.resource AND u.period = ?
    WHERE COALESCE(u.tenant_id, l.tenant_id) = ?
    ORDER BY resource ASC
  `).all(period, period, tenantId) as Array<{
    resource: string;
    period: string;
    used: number;
    limit_value: number | null;
  }>;

  return rows.map((row) => ({
    resource: row.resource,
    period: row.period,
    used: row.used,
    limit: row.limit_value ?? null,
    remaining: row.limit_value !== null ? Math.max(0, row.limit_value - row.used) : null,
  }));
}

/**
 * Set the quota limit for a resource for a tenant.
 */
export function setQuotaLimit(tenantId: string, resource: string, limitValue: number): void {
  ensureTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO tenant_quota_limits (tenant_id, resource, limit_value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, resource) DO UPDATE SET
      limit_value = excluded.limit_value,
      updated_at = datetime('now')
  `).run(tenantId, resource, limitValue);
  logger.debug({ tenantId, resource, limitValue }, 'quota limit set');
}

/**
 * Admin: reset usage counters for a tenant (all resources, or a specific one).
 * Returns the number of rows deleted.
 */
export function resetQuotaUsage(tenantId: string, resource?: string): number {
  ensureTable();
  const db = getDb();
  let result;
  if (resource !== undefined) {
    result = db
      .prepare('DELETE FROM quota_usage WHERE tenant_id = ? AND resource = ?')
      .run(tenantId, resource);
  } else {
    result = db
      .prepare('DELETE FROM quota_usage WHERE tenant_id = ?')
      .run(tenantId);
  }
  return result.changes;
}

// ---------------------------------------------------------------------------
// Standard resource names (spec §238)
// ---------------------------------------------------------------------------

export const QUOTA_RESOURCES = {
  LLM_CALLS: 'llm_calls',
  TOKENS_USED: 'tokens_used',
  STORAGE_BYTES: 'storage_bytes',
  CONCURRENT_SESSIONS: 'concurrent_sessions',
} as const;

// ---------------------------------------------------------------------------
// Fastify preHandler hook factory
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Returns a Fastify preHandler that checks and consumes quota for a given resource
 * before allowing the request through.
 *
 * Usage:
 *   app.post('/api/chat', { preHandler: quotaPreHandler('llm_calls', () => 1) }, handler)
 *
 * @param resource - The quota resource name to check (e.g. 'llm_calls')
 * @param getAmount - Function called with the request to determine consumption amount
 */
export function quotaPreHandler(
  resource: string,
  getAmount: (req: FastifyRequest) => number = () => 1,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = (req as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx?.tenant_id) return; // Unauthenticated — skip

    const tenantId = ctx.tenant_id;
    const amount = getAmount(req);

    const result = consumeQuota(tenantId, resource, amount);
    if (!result.allowed) {
      await reply.code(429).send({
        success: false,
        error: `Quota exceeded for resource "${resource}"`,
        quota: {
          resource,
          used: result.used,
          limit: result.limit,
        },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Fastify route registration
// ---------------------------------------------------------------------------

/**
 * Register quota management routes.
 *
 * GET /api/quotas              → quota status for caller's tenant (viewer+)
 * PUT /api/quotas/:tenantId    → set quota limit for a tenant (admin only)
 */
export function registerQuotaRoutes(app: FastifyInstance): void {
  // Get quota status for caller's tenant
  app.get('/api/quotas', async (request, reply) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const status = getQuotaStatus(tenantId);
    return reply.send({ success: true, data: status });
  });

  // Admin: set quota limit for a tenant
  app.put<{
    Params: { tenantId: string };
    Body: { resource: string; limit: number };
  }>(
    '/api/quotas/:tenantId',
    async (request, reply) => {
      const { tenantId } = request.params;
      const { resource, limit } = request.body ?? {};

      if (!resource || typeof resource !== 'string') {
        return reply.code(400).send({ success: false, error: '"resource" string is required' });
      }
      if (typeof limit !== 'number' || limit < 0) {
        return reply.code(400).send({ success: false, error: '"limit" must be a non-negative number' });
      }

      setQuotaLimit(tenantId, resource, limit);
      return reply.send({ success: true });
    },
  );
}
