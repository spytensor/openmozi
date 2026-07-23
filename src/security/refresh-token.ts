/**
 * Refresh Token Management (#232)
 *
 * Implements short-lived access tokens (15 min) + long-lived refresh tokens (7 days).
 * Refresh tokens rotate on use: the old token is revoked and a new pair is issued.
 *
 * Storage: `refresh_tokens` SQLite table (declared in schema.sql).
 * Transport: separate httpOnly cookie (`mozi_refresh`).
 */

import { randomBytes, createHash } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';
import { sign as jwtSign } from './jwt.js';
import { logAudit } from './audit.js';

const logger = pino({ name: 'mozi:security:refresh-token' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;       // 15 minutes
/** Default refresh lifetime; override per-deployment via `security.refresh_token_ttl_days`. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const REFRESH_COOKIE_NAME = 'mozi_refresh';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefreshToken {
  id: string;
  tenant_id: string;
  token_hash: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  device_info: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access token expiry (unix seconds) */
  accessExpiresAt: number;
  /** Refresh token expiry (unix seconds) */
  refreshExpiresAt: number;
}

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      device_info TEXT
    )
  `);
  tableReady = true;
}

export function resetRefreshTokenTableFlag(): void {
  tableReady = false;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Issue a new token pair (access + refresh) for a user.
 *
 * @param userId     - User ID (becomes JWT `sub`)
 * @param tenantId   - Tenant scope
 * @param jwtSecret  - HMAC secret for signing access token
 * @param extraClaims - Additional JWT claims (e.g. role, email)
 * @param deviceInfo - Optional device/UA string for audit
 * @param refreshTtlSeconds - Refresh token lifetime (default: REFRESH_TOKEN_TTL_SECONDS)
 */
export function issueTokenPair(
  userId: string,
  tenantId: string,
  jwtSecret: string,
  extraClaims?: Record<string, unknown>,
  deviceInfo?: string,
  refreshTtlSeconds = REFRESH_TOKEN_TTL_SECONDS,
): TokenPair {
  ensureTable();

  // Short-lived access token (15 min)
  const accessToken = jwtSign(userId, jwtSecret, ACCESS_TOKEN_TTL_SECONDS, {
    tenant_id: tenantId,
    ...extraClaims,
  });

  // Long-lived refresh token (opaque random bytes)
  const rawRefreshToken = randomBytes(48).toString('hex');
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const id = randomBytes(16).toString('hex');
  const refreshExpiresAt = new Date(Date.now() + refreshTtlSeconds * 1000).toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO refresh_tokens (id, tenant_id, token_hash, user_id, expires_at, device_info)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, tokenHash, userId, refreshExpiresAt, deviceInfo ?? null);

  logger.info({ userId, tenantId }, 'Token pair issued');

  const accessExpiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  const refreshExpiresSec = Math.floor(new Date(refreshExpiresAt).getTime() / 1000);

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    accessExpiresAt,
    refreshExpiresAt: refreshExpiresSec,
  };
}

/**
 * Rotate a refresh token: validate the incoming token, revoke it, and issue a fresh pair.
 * Returns null if the token is invalid, expired, or already revoked.
 */
export function rotateRefreshToken(
  rawRefreshToken: string,
  jwtSecret: string,
  extraClaimsBuilder?: (userId: string, tenantId: string) => Record<string, unknown>,
  deviceInfo?: string,
  refreshTtlSeconds = REFRESH_TOKEN_TTL_SECONDS,
): TokenPair | null {
  ensureTable();
  const db = getDb();
  const tokenHash = hashRefreshToken(rawRefreshToken);

  const row = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND expires_at > datetime('now')
  `).get(tokenHash) as Record<string, unknown> | undefined;

  if (!row) {
    logger.warn({ tokenHash: tokenHash.slice(0, 8) }, 'Refresh token invalid, expired, or already revoked');
    return null;
  }

  const userId = row.user_id as string;
  const tenantId = row.tenant_id as string;

  // Revoke the consumed token (rotation: one-time use)
  db.prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?").run(row.id as string);

  logAudit({
    tenant_id: tenantId,
    user_id: userId,
    action: 'token.revoke',
    resource_type: 'refresh_token',
    resource_id: row.id as string,
    details: { reason: 'rotation' },
    outcome: 'success',
  });

  const extraClaims = extraClaimsBuilder ? extraClaimsBuilder(userId, tenantId) : {};
  const pair = issueTokenPair(userId, tenantId, jwtSecret, extraClaims, deviceInfo, refreshTtlSeconds);
  logger.info({ userId, tenantId }, 'Refresh token rotated');
  return pair;
}

/**
 * Look up an active refresh-token row without rotating it.
 *
 * Used when a route must inspect the owning user before deciding whether
 * rotation is allowed.
 */
export function getActiveRefreshToken(rawRefreshToken: string): RefreshToken | null {
  ensureTable();
  const db = getDb();
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const row = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND expires_at > datetime('now')
  `).get(tokenHash) as Record<string, unknown> | undefined;

  return row ? deserializeRefreshToken(row) : null;
}

/**
 * Revoke a specific refresh token (e.g. on logout).
 */
export function revokeRefreshToken(rawRefreshToken: string, tenantId?: string): boolean {
  ensureTable();
  const db = getDb();
  const tokenHash = hashRefreshToken(rawRefreshToken);

  const query = tenantId
    ? db.prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND tenant_id = ? AND revoked_at IS NULL")
    : db.prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL");

  const result = tenantId ? query.run(tokenHash, tenantId) : query.run(tokenHash);
  if (result.changes > 0) {
    logger.info('Refresh token revoked');
    return true;
  }
  return false;
}

/**
 * Revoke all refresh tokens for a user (e.g. password change, account suspension).
 */
export function revokeAllUserRefreshTokens(userId: string, tenantId: string): number {
  ensureTable();
  const db = getDb();
  const result = db.prepare(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL",
  ).run(userId, tenantId);

  if (result.changes > 0) {
    logAudit({
      tenant_id: tenantId,
      user_id: userId,
      action: 'token.revoke',
      resource_type: 'refresh_token',
      details: { reason: 'revoke_all', count: result.changes },
      outcome: 'success',
    });
    logger.info({ userId, tenantId, count: result.changes }, 'All refresh tokens revoked for user');
  }
  return result.changes;
}

/** Purge expired refresh tokens (housekeeping, safe to call periodically). */
export function purgeExpiredRefreshTokens(): number {
  ensureTable();
  const db = getDb();
  const result = db.prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')").run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function deserializeRefreshToken(row: Record<string, unknown>): RefreshToken {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    token_hash: row.token_hash as string,
    user_id: row.user_id as string,
    expires_at: row.expires_at as string,
    created_at: row.created_at as string,
    revoked_at: (row.revoked_at as string | null) ?? null,
    device_info: (row.device_info as string | null) ?? null,
  };
}
