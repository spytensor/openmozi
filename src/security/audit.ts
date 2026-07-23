/**
 * Audit Log — structured logging for security-sensitive operations.
 *
 * Logs auth events, config changes, role assignments, and token operations
 * into the `audit_log` SQLite table with tenant isolation.
 */

import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:security:audit' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.pair'
  | 'auth.fail'
  | 'auth.password'
  | 'audit.export'
  | 'usage.export'
  | 'usage.pricing_refresh'
  | 'config.update'
  | 'user.create'
  | 'user.update'
  | 'user.disable'
  | 'entitlement.update'
  | 'role.assign'
  | 'role.remove'
  | 'token.revoke'
  | 'session.create'
  | 'session.delete'
  | 'session.message.delete'
  | 'session.permission'
  | 'git.branch_switch'
  | 'fs_root.grant'
  | 'fs_root.revoke';

export interface AuditEvent {
  tenant_id?: string;
  user_id?: string;
  action: AuditAction;
  resource_type: string;
  resource_id?: string;
  /** Arbitrary structured context — will be JSON-stringified */
  details?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  outcome?: 'success' | 'failure';
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  tenant_id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  outcome: string;
}

export interface AuditQueryFilters {
  tenant_id?: string;
  user_id?: string;
  action?: AuditAction | string;
  resource_type?: string;
  outcome?: 'success' | 'failure';
  /** ISO datetime string — entries at or after this time */
  from?: string;
  /** ISO datetime string — entries at or before this time */
  to?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Insert a structured audit entry into `audit_log`.
 * Never throws — audit failures are logged but must not disrupt the caller.
 */
export function logAudit(event: AuditEvent): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (
        tenant_id, user_id, action, resource_type, resource_id,
        details, ip_address, user_agent, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.tenant_id ?? 'default',
      event.user_id ?? null,
      event.action,
      event.resource_type,
      event.resource_id ?? null,
      event.details !== undefined ? JSON.stringify(event.details) : null,
      event.ip_address ?? null,
      event.user_agent ?? null,
      event.outcome ?? 'success',
    );
  } catch (err) {
    logger.error({ err, event }, 'Failed to write audit log entry');
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Query audit log entries with optional filters.
 * Results are ordered by timestamp DESC (most recent first).
 */
export function queryAuditLog(filters: AuditQueryFilters = {}): {
  entries: AuditEntry[];
  total: number;
} {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.tenant_id) {
    conditions.push('a.tenant_id = ?');
    params.push(filters.tenant_id);
  }
  if (filters.user_id) {
    conditions.push('a.user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.action) {
    conditions.push('a.action = ?');
    params.push(filters.action);
  }
  if (filters.resource_type) {
    conditions.push('a.resource_type = ?');
    params.push(filters.resource_type);
  }
  if (filters.outcome) {
    conditions.push('a.outcome = ?');
    params.push(filters.outcome);
  }
  if (filters.from) {
    conditions.push('a.timestamp >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('a.timestamp <= ?');
    params.push(filters.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = filters.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM audit_log a ${where}`).get(...params) as { cnt: number }).cnt;
  const rows = db.prepare(
    `SELECT a.*, u.email AS user_email
     FROM audit_log a
     LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
     ${where} ORDER BY a.timestamp DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;

  return {
    entries: rows.map(deserializeEntry),
    total,
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function deserializeEntry(row: Record<string, unknown>): AuditEntry {
  let details: Record<string, unknown> | null = null;
  if (typeof row.details === 'string' && row.details.length > 0) {
    try {
      details = JSON.parse(row.details) as Record<string, unknown>;
    } catch {
      details = { raw: row.details };
    }
  }
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    tenant_id: row.tenant_id as string,
    user_id: (row.user_id as string | null) ?? null,
    user_email: (row.user_email as string | null) ?? null,
    action: row.action as string,
    resource_type: row.resource_type as string,
    resource_id: (row.resource_id as string | null) ?? null,
    details,
    ip_address: (row.ip_address as string | null) ?? null,
    user_agent: (row.user_agent as string | null) ?? null,
    outcome: row.outcome as string,
  };
}
