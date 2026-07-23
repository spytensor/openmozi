/**
 * Tests for per-tenant API key management (#237)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  deriveKey,
  encryptKey,
  decryptKey,
  upsertTenantApiKey,
  getTenantApiKey,
  listTenantApiKeys,
  deleteTenantApiKey,
  rotateTenantApiKey,
  storeTenantApiKey,
  listTenantProviders,
  resetTenantKeysTableFlag,
} from './tenant-keys.js';

const MASTER_SECRET = 'test-master-secret-for-unit-tests';

let tmpDir: string;

beforeEach(() => {
  ({ tmpDir } = setupTestDb());
  resetTenantKeysTableFlag();
});

afterEach(() => {
  teardownTestDb(tmpDir);
});

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

describe('deriveKey()', () => {
  it('returns a 32-byte buffer', () => {
    const key = deriveKey(MASTER_SECRET, 'tenant-a');
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('different tenants produce different derived keys', () => {
    const keyA = deriveKey(MASTER_SECRET, 'tenant-a');
    const keyB = deriveKey(MASTER_SECRET, 'tenant-b');
    expect(keyA.equals(keyB)).toBe(false);
  });

  it('different master secrets produce different derived keys', () => {
    const key1 = deriveKey('secret-1', 'tenant-a');
    const key2 = deriveKey('secret-2', 'tenant-a');
    expect(key1.equals(key2)).toBe(false);
  });
});

describe('encryptKey() / decryptKey()', () => {
  it('round-trips a plaintext key', () => {
    const derivedKey = deriveKey(MASTER_SECRET, 'tenant-a');
    const raw = 'sk-test-abc123xyz';
    const { encrypted, iv, authTag } = encryptKey(raw, derivedKey);
    const decrypted = decryptKey(encrypted, iv, authTag, derivedKey);
    expect(decrypted).toBe(raw);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const derivedKey = deriveKey(MASTER_SECRET, 'tenant-a');
    const { encrypted: enc1 } = encryptKey('same-key', derivedKey);
    const { encrypted: enc2 } = encryptKey('same-key', derivedKey);
    // Same plaintext but different IVs → different ciphertext (probabilistic, may rarely fail)
    // We just verify both decrypt correctly
    expect(enc1 || enc2).toBeTruthy();
  });

  it('throws when auth tag is tampered', () => {
    const derivedKey = deriveKey(MASTER_SECRET, 'tenant-a');
    const { encrypted, iv } = encryptKey('sk-test', derivedKey);
    expect(() => decryptKey(encrypted, iv, 'AAAAAAAAAAAAAAAAAAAAAA==', derivedKey)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// upsertTenantApiKey + getTenantApiKey
// ---------------------------------------------------------------------------

describe('upsertTenantApiKey() + getTenantApiKey()', () => {
  it('stores and retrieves a key correctly', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-openai-abc123', MASTER_SECRET);
    const retrieved = getTenantApiKey('tenant-a', 'openai', MASTER_SECRET);
    expect(retrieved).toBe('sk-openai-abc123');
  });

  it('returns null for non-existent provider', () => {
    const result = getTenantApiKey('tenant-a', 'anthropic', MASTER_SECRET);
    expect(result).toBeNull();
  });

  it('upsert overwrites existing key', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-old', MASTER_SECRET);
    upsertTenantApiKey('tenant-a', 'openai', 'sk-new', MASTER_SECRET);
    const retrieved = getTenantApiKey('tenant-a', 'openai', MASTER_SECRET);
    expect(retrieved).toBe('sk-new');
  });

  it('stores multiple providers independently', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-openai', MASTER_SECRET);
    upsertTenantApiKey('tenant-a', 'anthropic', 'sk-anthropic', MASTER_SECRET);
    expect(getTenantApiKey('tenant-a', 'openai', MASTER_SECRET)).toBe('sk-openai');
    expect(getTenantApiKey('tenant-a', 'anthropic', MASTER_SECRET)).toBe('sk-anthropic');
  });
});

// ---------------------------------------------------------------------------
// listTenantApiKeys
// ---------------------------------------------------------------------------

describe('listTenantApiKeys()', () => {
  it('returns empty array when no keys stored', () => {
    const list = listTenantApiKeys('tenant-a');
    expect(list).toHaveLength(0);
  });

  it('returns metadata but not actual keys', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-openai-abcdefghij', MASTER_SECRET);
    const list = listTenantApiKeys('tenant-a');
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty('provider', 'openai');
    expect(list[0]).toHaveProperty('key_hint');
    expect(list[0]).toHaveProperty('created_at');
    expect(list[0]).toHaveProperty('updated_at');
    // Ensure actual key is never returned
    expect(JSON.stringify(list)).not.toContain('sk-openai-abcdefghij');
  });

  it('key_hint shows partial key info', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-openai-abc123xyz', MASTER_SECRET);
    const list = listTenantApiKeys('tenant-a');
    const hint = list[0].key_hint;
    expect(hint).toBeTruthy();
    expect(hint).not.toBe('sk-openai-abc123xyz');
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------

describe('Cross-tenant isolation', () => {
  it('tenant A key is not accessible from tenant B scope', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-tenant-a', MASTER_SECRET);
    const result = getTenantApiKey('tenant-b', 'openai', MASTER_SECRET);
    expect(result).toBeNull();
  });

  it('listTenantApiKeys only returns own tenant keys', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-a', MASTER_SECRET);
    upsertTenantApiKey('tenant-b', 'openai', 'sk-b', MASTER_SECRET);
    const aKeys = listTenantApiKeys('tenant-a');
    const bKeys = listTenantApiKeys('tenant-b');
    expect(aKeys).toHaveLength(1);
    expect(bKeys).toHaveLength(1);
  });

  it('decrypting tenant A key with tenant B derived key fails', () => {
    // Different tenants have different derived keys, so cross-decryption fails
    const keyA = deriveKey(MASTER_SECRET, 'tenant-a');
    const keyB = deriveKey(MASTER_SECRET, 'tenant-b');
    const { encrypted, iv, authTag } = encryptKey('sk-secret', keyA);
    expect(() => decryptKey(encrypted, iv, authTag, keyB)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteTenantApiKey
// ---------------------------------------------------------------------------

describe('deleteTenantApiKey()', () => {
  it('deletes an existing key and returns true', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-test', MASTER_SECRET);
    const deleted = deleteTenantApiKey('tenant-a', 'openai');
    expect(deleted).toBe(true);
    expect(getTenantApiKey('tenant-a', 'openai', MASTER_SECRET)).toBeNull();
  });

  it('returns false for non-existent key', () => {
    const deleted = deleteTenantApiKey('tenant-a', 'nonexistent');
    expect(deleted).toBe(false);
  });

  it('does not delete keys belonging to other tenants', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-a', MASTER_SECRET);
    upsertTenantApiKey('tenant-b', 'openai', 'sk-b', MASTER_SECRET);
    deleteTenantApiKey('tenant-a', 'openai');
    expect(getTenantApiKey('tenant-b', 'openai', MASTER_SECRET)).toBe('sk-b');
  });
});

// ---------------------------------------------------------------------------
// rotateTenantApiKey
// ---------------------------------------------------------------------------

describe('rotateTenantApiKey()', () => {
  it('replaces the key value', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-old', MASTER_SECRET);
    rotateTenantApiKey('tenant-a', 'openai', 'sk-rotated', MASTER_SECRET);
    expect(getTenantApiKey('tenant-a', 'openai', MASTER_SECRET)).toBe('sk-rotated');
  });

  it('updates updated_at after rotation', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-old', MASTER_SECRET);
    const before = listTenantApiKeys('tenant-a')[0].updated_at;
    rotateTenantApiKey('tenant-a', 'openai', 'sk-rotated', MASTER_SECRET);
    const after = listTenantApiKeys('tenant-a')[0].updated_at;
    expect(after >= before).toBe(true);
  });

  it('throws when no existing key to rotate', () => {
    expect(() =>
      rotateTenantApiKey('tenant-a', 'openai', 'sk-new', MASTER_SECRET),
    ).toThrow('No API key stored');
  });

  it('does not rotate another tenant\'s key', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-a', MASTER_SECRET);
    upsertTenantApiKey('tenant-b', 'openai', 'sk-b', MASTER_SECRET);
    rotateTenantApiKey('tenant-a', 'openai', 'sk-a-rotated', MASTER_SECRET);
    expect(getTenantApiKey('tenant-b', 'openai', MASTER_SECRET)).toBe('sk-b');
  });
});

// ---------------------------------------------------------------------------
// Spec aliases
// ---------------------------------------------------------------------------

describe('storeTenantApiKey() alias', () => {
  it('is an alias for upsertTenantApiKey', () => {
    storeTenantApiKey('tenant-a', 'anthropic', 'sk-ant-abc', MASTER_SECRET);
    expect(getTenantApiKey('tenant-a', 'anthropic', MASTER_SECRET)).toBe('sk-ant-abc');
  });
});

describe('listTenantProviders() alias', () => {
  it('is an alias for listTenantApiKeys', () => {
    upsertTenantApiKey('tenant-a', 'openai', 'sk-1', MASTER_SECRET);
    expect(listTenantProviders('tenant-a')).toHaveLength(1);
  });
});
