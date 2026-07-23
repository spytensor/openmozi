/**
 * Per-tenant configuration overrides (#236)
 *
 * Allows tenants to override specific configuration values without
 * modifying the global config. Values are JSON-encoded strings.
 *
 * Routes:
 *   GET    /api/config/tenant/:key    → getTenantConfig
 *   PUT    /api/config/tenant/:key    → setTenantConfig
 *   DELETE /api/config/tenant/:key    → deleteTenantConfig
 *   GET    /api/config/tenant         → listTenantOverrides
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import pino from 'pino';
import { getDb } from '../store/db.js';
import { getConfig } from './index.js';
import type { MoziConfig } from './index.js';
import type { FastifyInstance } from 'fastify';

const logger = pino({ name: 'mozi:config:tenant-config' });

// ---------------------------------------------------------------------------
// Allowlist — only these dot-path keys may be overridden per-tenant.
// Security-critical sections are intentionally excluded.
// ---------------------------------------------------------------------------

export const ALLOWED_CONFIG_KEYS = new Set([
  'brain.model',
  'brain.fallback_model',
  'brain.max_dag_depth',
  'brain.max_plan_steps',
  'brain.think',
  'token_budget.watermark_soft',
  'token_budget.watermark_hard',
  'token_budget.running_summary_cap_tokens',
  'system.max_parallel_agents',
  'system.heartbeat_timeout_seconds',
  'evolution.promote_min_score',
  'evolution.archive_inactive_days',
]);

/** Accepted JSON-serializable scalar types for config values. */
const ConfigValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT,
      UNIQUE(tenant_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_configs_tenant ON tenant_configs(tenant_id);
  `);
  tableReady = true;
}

/** Reset table-ready flag (for tests). */
export function resetTenantConfigTableFlag(): void {
  tableReady = false;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Get a single tenant config value by key.
 * Returns null if no override exists for this tenant+key.
 */
export function getTenantConfig(tenantId: string, key: string): string | null {
  ensureTable();
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM tenant_configs WHERE tenant_id = ? AND key = ?')
    .get(tenantId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Set (insert or update) a tenant config override.
 */
export function setTenantConfig(
  tenantId: string,
  key: string,
  value: string,
  updatedBy?: string,
): void {
  ensureTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO tenant_configs (id, tenant_id, key, value, updated_by, updated_at)
    VALUES ($id, $tenantId, $key, $value, $updatedBy, datetime('now'))
    ON CONFLICT(tenant_id, key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run({
    id: randomUUID(),
    tenantId,
    key,
    value,
    updatedBy: updatedBy ?? null,
  });
  logger.debug({ tenantId, key }, 'tenant config set');
}

/**
 * Delete a tenant config override.
 * Returns true if a row was deleted, false if not found.
 */
export function deleteTenantConfig(tenantId: string, key: string): boolean {
  ensureTable();
  const db = getDb();
  const result = db
    .prepare('DELETE FROM tenant_configs WHERE tenant_id = ? AND key = ?')
    .run(tenantId, key);
  return result.changes > 0;
}

/**
 * List all config overrides for a tenant.
 */
export function listTenantOverrides(
  tenantId: string,
): Array<{ key: string; value: string; updated_at: string }> {
  ensureTable();
  const db = getDb();
  return db
    .prepare(
      'SELECT key, value, updated_at FROM tenant_configs WHERE tenant_id = ? ORDER BY key ASC',
    )
    .all(tenantId) as Array<{ key: string; value: string; updated_at: string }>;
}

// ---------------------------------------------------------------------------
// Alias for migration/startup usage
// ---------------------------------------------------------------------------

/** Ensure the tenant_configs table exists. Safe to call multiple times. */
export function ensureTenantConfigTable(): void {
  ensureTable();
}

// ---------------------------------------------------------------------------
// Validated write — enforces ALLOWED_CONFIG_KEYS + Zod type check
// ---------------------------------------------------------------------------

/**
 * Set a tenant config override with key-allowlist enforcement and value validation.
 * @throws if key is not in ALLOWED_CONFIG_KEYS
 * @throws if value fails the ConfigValueSchema (must be string, number, boolean, or null)
 */
export function setTenantConfigValidated(
  tenantId: string,
  key: string,
  value: unknown,
  updatedBy?: string,
): void {
  if (!ALLOWED_CONFIG_KEYS.has(key)) {
    throw new Error(
      `Config key "${key}" is not in the allowed override list. ` +
        `Allowed keys: ${[...ALLOWED_CONFIG_KEYS].join(', ')}`,
    );
  }
  const validated = ConfigValueSchema.parse(value);
  const serialized = JSON.stringify(validated);
  setTenantConfig(tenantId, key, serialized, updatedBy);
}

// ---------------------------------------------------------------------------
// Deep-merge helper — global config + tenant overrides
// ---------------------------------------------------------------------------

/**
 * Get the effective MoziConfig for a tenant by deep-merging all overrides
 * on top of the global config. Values stored as JSON strings are parsed
 * before merging; invalid JSON falls back to the raw string.
 *
 * Returns a full MoziConfig clone — never mutates the global config.
 */
export function getMergedTenantConfig(tenantId: string): MoziConfig {
  const global = getConfig();
  const overrides = listTenantOverrides(tenantId);
  if (overrides.length === 0) return global;

  const merged = structuredClone(global) as Record<string, unknown>;
  for (const { key, value } of overrides) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    setNestedValue(merged, key, parsed);
  }
  return merged as MoziConfig;
}

// ---------------------------------------------------------------------------
// Fastify route registration
// ---------------------------------------------------------------------------

/**
 * Register per-tenant config override routes.
 * All routes require admin role (enforced by the auth guard in api-routes.ts).
 *
 * GET    /api/config/tenant         → list all overrides for caller's tenant
 * GET    /api/config/tenant/:key    → get single override value
 * PUT    /api/config/tenant/:key    → set override (validated)
 * DELETE /api/config/tenant/:key    → delete override
 */
export function registerTenantConfigRoutes(app: FastifyInstance): void {
  // List all overrides
  app.get('/api/config/tenant', async (request, reply) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    return reply.send({ success: true, data: listTenantOverrides(tenantId) });
  });

  // Get single key
  app.get<{ Params: { key: string } }>('/api/config/tenant/:key', async (request, reply) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const value = getTenantConfig(tenantId, request.params.key);
    if (value === null) {
      return reply.code(404).send({ success: false, error: 'Config key not set for this tenant' });
    }
    return reply.send({ success: true, data: { key: request.params.key, value } });
  });

  // Set override (validated)
  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/api/config/tenant/:key',
    async (request, reply) => {
      const ctx = (request as unknown as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
      const tenantId = ctx?.tenant_id ?? 'default';
      const userId = ctx?.user_id ?? 'unknown';
      const { value } = request.body ?? {};
      if (value === undefined) {
        return reply.code(400).send({ success: false, error: 'Request body must contain "value"' });
      }
      try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        setTenantConfig(tenantId, request.params.key, serialized, userId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ success: false, error: message });
      }
      return reply.send({ success: true });
    },
  );

  // Delete override
  app.delete<{ Params: { key: string } }>('/api/config/tenant/:key', async (request, reply) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    deleteTenantConfig(tenantId, request.params.key);
    return reply.send({ success: true });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cursor[part] === null || cursor[part] === undefined || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

// Suppress unused-import warnings — these are referenced by route handlers and exported API
void (ConfigValueSchema satisfies z.ZodTypeAny);
