/**
 * Simple JWT sign/verify for WebSocket authentication.
 *
 * Uses HMAC-SHA256 with a configurable secret. No external JWT library needed.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';

const logger = pino({ name: 'mozi:security:jwt' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;         // Subject (user/tenant ID)
  iat: number;         // Issued at (unix timestamp)
  exp: number;         // Expiration (unix timestamp)
  jti?: string;        // JWT ID (unique token identifier for revocation)
  [key: string]: unknown;
}

export interface JwtOptions {
  secret: string;
  expiresInSeconds?: number;  // Default: 24 hours
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign a JWT with HMAC-SHA256.
 *
 * Every token includes a unique `jti` claim for revocation support.
 *
 * @param subject - The subject (user/tenant ID)
 * @param secret  - The HMAC secret
 * @param expiresInSeconds - Token lifetime (default: 86400 = 24h)
 * @param extraClaims - Additional claims to include
 * @returns The JWT string
 */
export function sign(
  subject: string,
  secret: string,
  expiresInSeconds = 86400,
  extraClaims?: Record<string, unknown>,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: subject,
    iat: now,
    exp: now + expiresInSeconds,
    jti: randomUUID(),
    ...extraClaims,
  };

  const headerStr = base64urlEncode(JSON.stringify(header));
  const payloadStr = base64urlEncode(JSON.stringify(payload));
  const data = `${headerStr}.${payloadStr}`;

  const signature = createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${data}.${signature}`;
}

/**
 * Verify and decode a JWT token.
 *
 * Returns null if the token is invalid, expired, or revoked.
 *
 * @param token  - The JWT string
 * @param secret - The HMAC secret
 * @returns The decoded payload, or null if invalid/expired/revoked
 */
export function verify(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    logger.warn('JWT: invalid token format');
    return null;
  }

  const [headerStr, payloadStr, signatureStr] = parts;

  // Verify signature
  const data = `${headerStr}.${payloadStr}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expectedSignature, 'utf-8');
  const actualBuf = Buffer.from(signatureStr, 'utf-8');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    logger.warn('JWT: invalid signature');
    return null;
  }

  // Decode payload
  try {
    const payload = JSON.parse(base64urlDecode(payloadStr)) as JwtPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      logger.warn({ sub: payload.sub }, 'JWT: token expired');
      return null;
    }

    // Check revocation blacklist
    if (payload.jti && isRevoked(payload.jti)) {
      logger.warn({ sub: payload.sub, jti: payload.jti }, 'JWT: token revoked');
      return null;
    }

    return payload;
  } catch {
    logger.warn('JWT: failed to decode payload');
    return null;
  }
}

/**
 * Revoke a JWT by its `jti` claim.
 *
 * @param jti - The JWT ID to revoke
 * @param expiresAt - ISO datetime when this token expires (for cleanup)
 * @param reason - Optional human-readable reason for revocation
 */
export function revokeToken(jti: string, expiresAt: string, reason?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO revoked_tokens (jti, revoked_at, reason, expires_at)
    VALUES (?, datetime('now'), ?, ?)
  `).run(jti, reason ?? null, expiresAt);
  logger.info({ jti, reason }, 'JWT: token revoked');
}

/**
 * Check whether a `jti` has been revoked.
 */
export function isRevoked(jti: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM revoked_tokens WHERE jti = ?",
  ).get(jti);
  return row !== undefined;
}

/**
 * Remove revocation records for tokens that have already expired.
 * Call this periodically (e.g. via scheduler) to keep the table small.
 */
export function cleanupExpiredRevocations(): number {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM revoked_tokens WHERE expires_at <= datetime('now')",
  ).run();
  if (result.changes > 0) {
    logger.info({ removed: result.changes }, 'JWT: cleaned up expired revocation records');
  }
  return result.changes;
}
