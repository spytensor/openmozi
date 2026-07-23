/**
 * Blackboard — shared context store for inter-agent communication.
 *
 * Agents write context summaries (findings, partial results, state) to scoped keys.
 * Other agents read these instead of passing full token context via IPC.
 *
 * Scopes:
 * - 'global' — visible to all agents in the tenant
 * - 'task:{task_id}' — scoped to a specific task
 * - 'agent:{agent_id}' — private to a specific agent
 */

import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:blackboard' });

export interface BlackboardEntry {
  key: string;
  value: string;
  scope: string;
  written_by: string | null;
  ttl_seconds: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Write a key-value pair to the blackboard.
 * Uses UPSERT — overwrites existing key in the same scope.
 */
export function write(
  key: string,
  value: string,
  options: {
    scope?: string;
    written_by?: string;
    ttl_seconds?: number;
    tenant_id?: string;
  } = {},
): void {
  const scope = options.scope ?? 'global';
  const tenantId = options.tenant_id ?? 'default';
  const db = getDb();

  db.prepare(`
    INSERT INTO blackboard (tenant_id, scope, key, value, written_by, ttl_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, scope, key) DO UPDATE SET
      value = excluded.value,
      written_by = excluded.written_by,
      ttl_seconds = excluded.ttl_seconds,
      updated_at = datetime('now')
  `).run(tenantId, scope, key, value, options.written_by ?? null, options.ttl_seconds ?? null);

  logger.debug({ tenant_id: tenantId, scope, key, written_by: options.written_by }, 'Blackboard write');
}

/**
 * Read a specific key from the blackboard.
 * Returns null if key not found or expired.
 */
export function read(
  key: string,
  options: { scope?: string; tenant_id?: string } = {},
): string | null {
  const scope = options.scope ?? 'global';
  const tenantId = options.tenant_id ?? 'default';
  const db = getDb();

  const row = db.prepare(`
    SELECT value, ttl_seconds, created_at FROM blackboard
    WHERE tenant_id = ? AND scope = ? AND key = ?
  `).get(tenantId, scope, key) as { value: string; ttl_seconds: number | null; created_at: string } | undefined;

  if (!row) return null;

  // Check TTL expiration
  if (row.ttl_seconds !== null) {
    const createdAt = new Date(row.created_at + 'Z').getTime();
    const now = Date.now();
    if (now - createdAt > row.ttl_seconds * 1000) {
      // Expired — clean up and return null
      db.prepare('DELETE FROM blackboard WHERE tenant_id = ? AND scope = ? AND key = ?')
        .run(tenantId, scope, key);
      return null;
    }
  }

  return row.value;
}

/**
 * List all non-expired entries in a scope.
 */
export function list(
  options: { scope?: string; tenant_id?: string } = {},
): BlackboardEntry[] {
  const scope = options.scope ?? 'global';
  const tenantId = options.tenant_id ?? 'default';
  const db = getDb();

  const rows = db.prepare(`
    SELECT key, value, scope, written_by, ttl_seconds, created_at, updated_at
    FROM blackboard
    WHERE tenant_id = ? AND scope = ?
    ORDER BY updated_at DESC
  `).all(tenantId, scope) as BlackboardEntry[];

  // Filter out expired entries
  const now = Date.now();
  return rows.filter(row => {
    if (row.ttl_seconds === null) return true;
    const createdAt = new Date(row.created_at + 'Z').getTime();
    return now - createdAt <= row.ttl_seconds * 1000;
  });
}

/**
 * Delete a key from the blackboard.
 * Returns true if key was found and deleted.
 */
export function remove(
  key: string,
  options: { scope?: string; tenant_id?: string } = {},
): boolean {
  const scope = options.scope ?? 'global';
  const tenantId = options.tenant_id ?? 'default';
  const db = getDb();

  const result = db.prepare(
    'DELETE FROM blackboard WHERE tenant_id = ? AND scope = ? AND key = ?',
  ).run(tenantId, scope, key);

  return result.changes > 0;
}

/**
 * Clean up all expired entries.
 * Returns the number of entries removed.
 */
export function cleanup(tenantId?: string): number {
  const db = getDb();

  const query = tenantId
    ? `DELETE FROM blackboard WHERE tenant_id = ? AND ttl_seconds IS NOT NULL
       AND (julianday('now') - julianday(created_at)) * 86400 > ttl_seconds`
    : `DELETE FROM blackboard WHERE ttl_seconds IS NOT NULL
       AND (julianday('now') - julianday(created_at)) * 86400 > ttl_seconds`;

  const result = tenantId
    ? db.prepare(query).run(tenantId)
    : db.prepare(query).run();

  if (result.changes > 0) {
    logger.info({ removed: result.changes, tenantId }, 'Blackboard cleanup');
  }

  return result.changes;
}
