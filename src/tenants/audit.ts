/**
 * Audit Log Export — export audit_log filtered by tenant, date range, and format.
 *
 * Supports JSON and CSV output formats.
 * Sensitive data (API keys, tokens) is redacted before export.
 */

import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tenants:audit' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number;
  timestamp: string;
  tenant_id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  outcome: string;
}

export interface AuditExportOptions {
  tenant_id: string;
  from?: string;    // ISO date string, e.g. "2026-01-01"
  to?: string;      // ISO date string
  format?: 'json' | 'csv';
  limit?: number;   // max records (default 10000)
  action?: string;  // filter by audit action
  user_id?: string;
  outcome?: 'success' | 'failure';
}

export interface AuditExportResult {
  format: 'json' | 'csv';
  record_count: number;
  data: string;
}

// ---------------------------------------------------------------------------
// Sensitive data patterns for redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  'token', 'api_key', 'apikey', 'api_secret', 'secret',
  'password', 'credential', 'key_hash', 'raw_key',
  'authorization', 'access_token', 'refresh_token',
]);

const SENSITIVE_VALUE_PATTERNS = [
  /^mozi_[a-f0-9]{64}$/i,        // API keys
  /^eyJ[A-Za-z0-9_-]+\./,        // JWT tokens
  /^sk-[a-zA-Z0-9]+/,            // OpenAI keys
  /^sk-ant-[a-zA-Z0-9]+/,        // Anthropic keys
];

// ---------------------------------------------------------------------------
// Export functions
// ---------------------------------------------------------------------------

/**
 * Export audit log entries for a tenant.
 */
export function exportAuditLog(options: AuditExportOptions): AuditExportResult {
  const {
    tenant_id,
    from,
    to,
    format = 'json',
    limit = 10000,
    action,
    user_id,
    outcome,
  } = options;

  const entries = queryAuditEntries(tenant_id, from, to, limit, action, user_id, outcome);

  // Redact sensitive data
  const redacted = entries.map(redactEntry);

  const data = format === 'csv'
    ? entriesToCsv(redacted)
    : JSON.stringify(redacted, null, 2);

  logger.info({
    tenant_id,
    format,
    record_count: redacted.length,
    from,
    to,
  }, 'Audit log exported');

  return {
    format,
    record_count: redacted.length,
    data,
  };
}

/**
 * Query raw audit entries from the audit_log table.
 */
export function queryAuditEntries(
  tenantId: string,
  from?: string,
  to?: string,
  limit = 10000,
  action?: string,
  userId?: string,
  outcome?: 'success' | 'failure',
): AuditEntry[] {
  const db = getDb();
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];

  if (from) {
    conditions.push('timestamp >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('timestamp <= ?');
    params.push(to);
  }
  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (outcome) {
    conditions.push('outcome = ?');
    params.push(outcome);
  }

  params.push(Math.min(Math.max(limit, 1), 10000));

  const rows = db.prepare(`
    SELECT id, timestamp, tenant_id, user_id, action, resource_type, resource_id,
           details, ip_address, user_agent, outcome
    FROM audit_log
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp ASC, id ASC
    LIMIT ?
  `).all(...params) as Array<{
    id: number;
    timestamp: string;
    tenant_id: string;
    user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    details: string | null;
    ip_address: string | null;
    user_agent: string | null;
    outcome: string;
  }>;

  return rows.map(row => ({
    ...row,
    details: row.details ? safeJsonParse(row.details) : null,
  }));
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from an audit entry.
 */
export function redactEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    details: entry.details ? redactObject(entry.details) : null,
  };
}

/**
 * Recursively redact sensitive keys and values in an object.
 */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '***REDACTED***';
    } else if (typeof value === 'string' && isSensitiveValue(value)) {
      result[key] = maskValue(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? redactObject(item as Record<string, unknown>)
          : typeof item === 'string' && isSensitiveValue(item)
            ? maskValue(item)
            : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

function entriesToCsv(entries: AuditEntry[]): string {
  const headers = [
    'id',
    'timestamp',
    'tenant_id',
    'user_id',
    'action',
    'resource_type',
    'resource_id',
    'details',
    'ip_address',
    'user_agent',
    'outcome',
  ];
  const lines = [headers.join(',')];

  for (const entry of entries) {
    const row = [
      String(entry.id),
      csvEscape(entry.timestamp),
      csvEscape(entry.tenant_id),
      csvEscape(entry.user_id ?? ''),
      csvEscape(entry.action),
      csvEscape(entry.resource_type),
      csvEscape(entry.resource_id ?? ''),
      csvEscape(JSON.stringify(entry.details)),
      csvEscape(entry.ip_address ?? ''),
      csvEscape(entry.user_agent ?? ''),
      csvEscape(entry.outcome),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

function maskValue(value: string): string {
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***' + value.slice(-4);
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}
