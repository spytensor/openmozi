import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sign, verify, revokeToken, isRevoked, cleanupExpiredRevocations } from './jwt.js';
import { initDb, closeDb } from '../store/db.js';
import { runMigrations } from '../store/migrate.js';

const TEST_SECRET = 'test-secret-key-for-jwt-tests';

// Use a fresh in-memory database for each test
beforeEach(() => {
  closeDb();
  initDb(':memory:');
  runMigrations(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('security/jwt', () => {
  describe('sign', () => {
    it('creates a valid JWT string', () => {
      const token = sign('user-1', TEST_SECRET);
      expect(token).toBeTruthy();
      expect(token.split('.')).toHaveLength(3);
    });

    it('includes extra claims', () => {
      const token = sign('user-1', TEST_SECRET, 3600, { role: 'admin' });
      const payload = verify(token, TEST_SECRET);
      expect(payload).toBeTruthy();
      expect(payload!.role).toBe('admin');
    });

    it('includes a unique jti claim', () => {
      const token1 = sign('user-1', TEST_SECRET);
      const token2 = sign('user-1', TEST_SECRET);
      const payload1 = verify(token1, TEST_SECRET);
      const payload2 = verify(token2, TEST_SECRET);
      expect(payload1!.jti).toBeTruthy();
      expect(payload2!.jti).toBeTruthy();
      expect(payload1!.jti).not.toBe(payload2!.jti);
    });
  });

  describe('verify', () => {
    it('verifies a valid token', () => {
      const token = sign('user-1', TEST_SECRET);
      const payload = verify(token, TEST_SECRET);

      expect(payload).toBeTruthy();
      expect(payload!.sub).toBe('user-1');
      expect(payload!.iat).toBeTypeOf('number');
      expect(payload!.exp).toBeTypeOf('number');
    });

    it('returns null for wrong secret', () => {
      const token = sign('user-1', TEST_SECRET);
      const payload = verify(token, 'wrong-secret');
      expect(payload).toBeNull();
    });

    it('returns null for expired token', () => {
      const token = sign('user-1', TEST_SECRET, -10); // Already expired
      const payload = verify(token, TEST_SECRET);
      expect(payload).toBeNull();
    });

    it('returns null for malformed token', () => {
      expect(verify('not.a.jwt', TEST_SECRET)).toBeNull();
      expect(verify('only-one-part', TEST_SECRET)).toBeNull();
      expect(verify('', TEST_SECRET)).toBeNull();
    });

    it('returns null for tampered payload', () => {
      const token = sign('user-1', TEST_SECRET);
      const parts = token.split('.');
      // Tamper with payload
      parts[1] = parts[1] + 'x';
      const tampered = parts.join('.');
      expect(verify(tampered, TEST_SECRET)).toBeNull();
    });

    it('preserves custom claims', () => {
      const token = sign('user-1', TEST_SECRET, 3600, {
        username: 'john',
        tenant_id: 'acme',
      });
      const payload = verify(token, TEST_SECRET);
      expect(payload!.username).toBe('john');
      expect(payload!.tenant_id).toBe('acme');
    });

    it('uses constant-time comparison (timingSafeEqual)', () => {
      // Verify that the verify function rejects tokens with signatures of
      // different lengths (timingSafeEqual requires equal-length buffers,
      // so this exercises the length-check + timingSafeEqual code path)
      const token = sign('user-1', TEST_SECRET);
      const parts = token.split('.');

      // Truncated signature — different length
      parts[2] = parts[2].slice(0, 5);
      expect(verify(parts.join('.'), TEST_SECRET)).toBeNull();

      // Empty signature — different length
      parts[2] = '';
      expect(verify(parts.join('.'), TEST_SECRET)).toBeNull();

      // Same length but wrong bytes — exercises timingSafeEqual path
      const token2 = sign('user-1', TEST_SECRET);
      const parts2 = token2.split('.');
      const sigChars = parts2[2].split('');
      sigChars[0] = sigChars[0] === 'A' ? 'B' : 'A';
      parts2[2] = sigChars.join('');
      expect(verify(parts2.join('.'), TEST_SECRET)).toBeNull();
    });

    it('returns null for a revoked token', () => {
      const token = sign('user-1', TEST_SECRET, 3600);
      const payload = verify(token, TEST_SECRET);
      expect(payload).toBeTruthy();

      const expiresAt = new Date(payload!.exp * 1000).toISOString().replace('T', ' ').slice(0, 19);
      revokeToken(payload!.jti!, expiresAt, 'test revocation');

      expect(verify(token, TEST_SECRET)).toBeNull();
    });
  });

  describe('revokeToken / isRevoked', () => {
    it('marks a jti as revoked', () => {
      const jti = 'test-jti-1234';
      expect(isRevoked(jti)).toBe(false);
      revokeToken(jti, '2099-12-31 23:59:59', 'test');
      expect(isRevoked(jti)).toBe(true);
    });

    it('is idempotent — revoking twice does not error', () => {
      const jti = 'test-jti-idempotent';
      revokeToken(jti, '2099-12-31 23:59:59');
      expect(() => revokeToken(jti, '2099-12-31 23:59:59')).not.toThrow();
      expect(isRevoked(jti)).toBe(true);
    });
  });

  describe('cleanupExpiredRevocations', () => {
    it('removes expired entries and leaves active ones', () => {
      // Expired: expires_at in the past
      revokeToken('expired-jti', '2000-01-01 00:00:00', 'old');
      // Active: expires_at in the future
      revokeToken('active-jti', '2099-12-31 23:59:59', 'future');

      const removed = cleanupExpiredRevocations();
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(isRevoked('expired-jti')).toBe(false);
      expect(isRevoked('active-jti')).toBe(true);
    });

    it('returns 0 when nothing to clean up', () => {
      const removed = cleanupExpiredRevocations();
      expect(removed).toBe(0);
    });
  });
});
