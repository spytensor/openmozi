/**
 * Pairing — only paired users can interact with the bot.
 *
 * Flow:
 * 1. First startup: generate 6-digit pairing code, log to console
 * 2. Owner sends the code via Telegram → paired
 * 3. Owner can /pair to generate new codes for additional users
 * 4. Allowlist persisted in SQLite
 *
 * Similar to ZeroClaw/OpenClaw gateway pairing.
 */

import { getDb } from '../store/db.js';
import { randomBytes, createHash } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'mozi:pairing' });

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      username TEXT,
      role TEXT NOT NULL DEFAULT 'owner',
      paired_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS pairing_tokens (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      token_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, token_hash)
    );
    CREATE TABLE IF NOT EXISTS pairing_requests (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'telegram',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_allowed_users_tenant_role
      ON allowed_users(tenant_id, role);
    CREATE INDEX IF NOT EXISTS idx_pairing_tokens_tenant_active
      ON pairing_tokens(tenant_id, used, expires_at);
    CREATE INDEX IF NOT EXISTS idx_pairing_requests_tenant_pending
      ON pairing_requests(tenant_id, approved, expires_at);
  `);
  tableEnsured = true;
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

/** Generate a cryptographically secure pairing token (mozi_pair_<32 hex chars>). */
function generateToken(): string {
  return `mozi_pair_${randomBytes(16).toString('hex')}`;
}

/** SHA-256 hash for storage (never store raw tokens). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

export function hasAnyPairedUsers(tenantId = 'default'): boolean {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM allowed_users WHERE tenant_id = ?').get(tenantId) as { count: number };
  return row.count > 0;
}

export function isAllowed(userId: string, tenantId = 'default'): boolean {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT user_id FROM allowed_users WHERE tenant_id = ? AND user_id = ?').get(tenantId, userId);
  return !!row;
}

export function addAllowedUser(userId: string, username: string, role = 'owner', tenantId = 'default'): void {
  ensureTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO allowed_users (tenant_id, user_id, username, role, paired_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, user_id) DO UPDATE SET username = excluded.username, role = excluded.role
  `).run(tenantId, userId, username, role);
  logger.info({ tenantId, userId, username, role }, 'User paired');
}

export function getAllowedUsers(tenantId = 'default'): Array<{ user_id: string; username: string; role: string }> {
  ensureTable();
  const db = getDb();
  return db.prepare('SELECT user_id, username, role FROM allowed_users WHERE tenant_id = ? ORDER BY paired_at ASC').all(tenantId) as Array<{ user_id: string; username: string; role: string }>;
}

export function removeUser(userId: string, tenantId = 'default'): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare('DELETE FROM allowed_users WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Token-based pairing
// ---------------------------------------------------------------------------

/**
 * Create a pairing token. Returns the raw token (show once, never stored).
 * Token hash stored in DB with expiry.
 */
export function createPairingToken(role = 'user', expiryMinutes = 30, tenantId = 'default'): string {
  ensureTable();
  const token = generateToken();
  const hash = hashToken(token);
  const db = getDb();

  db.prepare(`
    INSERT INTO pairing_tokens (tenant_id, token_hash, role, expires_at)
    VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))
  `).run(tenantId, hash, role, expiryMinutes);

  logger.info({ tenantId, role, expiryMinutes }, 'Pairing token created');
  return token;
}

/**
 * Validate a pairing token. Returns role if valid, null if invalid/expired/used.
 * Marks token as used on success.
 */
export function validatePairingToken(token: string, tenantId = 'default'): string | null {
  ensureTable();
  const hash = hashToken(token);
  const db = getDb();

  const row = db.prepare(`
    SELECT token_hash, role FROM pairing_tokens
    WHERE tenant_id = ? AND token_hash = ? AND used = 0 AND expires_at > datetime('now')
  `).get(tenantId, hash) as { token_hash: string; role: string } | undefined;

  if (!row) return null;

  // Mark as used
  db.prepare('UPDATE pairing_tokens SET used = 1 WHERE tenant_id = ? AND token_hash = ?').run(tenantId, hash);
  return row.role;
}

// Legacy compat aliases
export function startPairing(role = 'user', tenantId = 'default'): string {
  return createPairingToken(role, 30, tenantId);
}

export function isPairingMode(tenantId = 'default'): boolean {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM pairing_tokens
    WHERE tenant_id = ? AND used = 0 AND expires_at > datetime('now')
  `).get(tenantId) as { count: number };
  return row.count > 0;
}

export function validatePairingCode(code: string, tenantId = 'default'): string | null {
  return validatePairingToken(code.trim(), tenantId);
}

export function resetTableFlag(): void {
  tableEnsured = false;
}

// ---------------------------------------------------------------------------
// Short-code pairing requests (OpenClaw style)
// ---------------------------------------------------------------------------

/** Character set excluding ambiguous chars: 0/O/1/I/L */
const SHORT_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SHORT_CODE_LENGTH = 8;
const MAX_PENDING_REQUESTS = 5;
const REQUEST_EXPIRY_MINUTES = 60;

/** Generate an 8-character short pairing code. */
function generateShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_CHARS[bytes[i] % SHORT_CODE_CHARS.length];
  }
  return code;
}

/**
 * Create a pairing request for an unknown user.
 * If the user already has a pending request, returns the existing code.
 * Rate-limited to MAX_PENDING_REQUESTS total pending requests.
 */
export function createPairingRequest(
  userId: string,
  username: string,
  channelType = 'telegram',
  tenantId = 'default',
): { code: string; isExisting: boolean } | null {
  ensureTable();
  const db = getDb();

  // Check for existing unexpired request for this user
  const existing = db.prepare(`
    SELECT code FROM pairing_requests
    WHERE tenant_id = ? AND user_id = ? AND approved = 0 AND expires_at > datetime('now')
  `).get(tenantId, userId) as { code: string } | undefined;

  if (existing) {
    return { code: existing.code, isExisting: true };
  }

  // Rate limit: max pending requests overall
  const pending = db.prepare(`
    SELECT COUNT(*) as count FROM pairing_requests
    WHERE tenant_id = ? AND approved = 0 AND expires_at > datetime('now')
  `).get(tenantId) as { count: number };

  if (pending.count >= MAX_PENDING_REQUESTS) {
    return null; // Too many pending requests
  }

  const code = generateShortCode();
  db.prepare(`
    INSERT INTO pairing_requests (tenant_id, code, user_id, username, channel_type, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+${REQUEST_EXPIRY_MINUTES} minutes'))
  `).run(tenantId, code, userId, username, channelType);

  logger.info({ tenantId, code, userId, username, channelType }, 'Pairing request created');
  return { code, isExisting: false };
}

/**
 * Approve a pairing request by code.
 * Adds the user to allowed_users and marks the request as approved.
 * Returns user info on success, null if code is invalid/expired/already approved.
 */
export function approvePairingRequest(
  code: string,
  role = 'owner',
  tenantId = 'default',
): { userId: string; username: string; chatId: string; channelType: string } | null {
  ensureTable();
  const db = getDb();
  const upperCode = code.toUpperCase().trim();

  const row = db.prepare(`
    SELECT code, user_id, username, channel_type FROM pairing_requests
    WHERE tenant_id = ? AND code = ? AND approved = 0 AND expires_at > datetime('now')
  `).get(tenantId, upperCode) as { code: string; user_id: string; username: string; channel_type: string } | undefined;

  if (!row) return null;

  // Mark as approved
  db.prepare('UPDATE pairing_requests SET approved = 1 WHERE tenant_id = ? AND code = ?').run(tenantId, upperCode);

  // Add to allowed users
  addAllowedUser(row.user_id, row.username, role, tenantId);

  logger.info({ tenantId, code: upperCode, userId: row.user_id, username: row.username, role }, 'Pairing request approved');
  return { userId: row.user_id, username: row.username, chatId: row.user_id, channelType: row.channel_type };
}

/** List all pending (unapproved, unexpired) pairing requests. */
export function listPendingRequests(tenantId?: string): Array<{
  code: string;
  userId: string;
  username: string;
  channelType: string;
  createdAt: string;
  expiresAt: string;
}> {
  ensureTable();
  const db = getDb();
  const tenantClause = tenantId ? 'tenant_id = ? AND' : '';
  const rows = db.prepare(`
    SELECT code, user_id, username, channel_type, created_at, expires_at
    FROM pairing_requests
    WHERE ${tenantClause} approved = 0 AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all(...(tenantId ? [tenantId] : [])) as Array<{
    code: string;
    user_id: string;
    username: string;
    channel_type: string;
    created_at: string;
    expires_at: string;
  }>;

  return rows.map(r => ({
    code: r.code,
    userId: r.user_id,
    username: r.username,
    channelType: r.channel_type,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/**
 * Get approved-but-not-yet-notified pairing requests, and mark them as notified.
 * Used by the bot to send Telegram notifications after CLI approval.
 */
export function consumeApprovedRequests(tenantId?: string): Array<{ userId: string; username: string; channelType: string }> {
  return consumeApprovedRequestsForTenant(tenantId);
}

export function consumeApprovedRequestsForTenant(tenantId?: string): Array<{ userId: string; username: string; channelType: string }> {
  ensureTable();
  const db = getDb();
  const tenantClause = tenantId ? 'tenant_id = ? AND' : '';

  const rows = db.prepare(`
    SELECT user_id, username, channel_type FROM pairing_requests
    WHERE ${tenantClause} approved = 1 AND notified = 0
  `).all(...(tenantId ? [tenantId] : [])) as Array<{ user_id: string; username: string; channel_type: string }>;

  if (rows.length > 0) {
    db.prepare(`
      UPDATE pairing_requests
      SET notified = 1
      WHERE ${tenantClause} approved = 1 AND notified = 0
    `).run(...(tenantId ? [tenantId] : []));
  }

  return rows.map(r => ({ userId: r.user_id, username: r.username, channelType: r.channel_type }));
}

/** Remove expired pairing requests. */
export function cleanExpiredRequests(tenantId?: string): number {
  ensureTable();
  const db = getDb();
  const tenantClause = tenantId ? 'tenant_id = ? AND' : '';
  const result = db.prepare(`
    DELETE FROM pairing_requests WHERE ${tenantClause} expires_at <= datetime('now')
  `).run(...(tenantId ? [tenantId] : []));
  if (result.changes > 0) {
    logger.info({ tenantId, cleaned: result.changes }, 'Cleaned expired pairing requests');
  }
  return result.changes;
}
