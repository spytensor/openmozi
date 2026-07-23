/**
 * Per-tenant API key management with AES-256-GCM encryption (#237)
 *
 * Stores provider API keys (e.g., OpenAI, Anthropic) per tenant.
 * Keys are encrypted at rest using AES-256-GCM with per-tenant key
 * derivation via HKDF (master secret + tenant_id as salt/info).
 *
 * Routes:
 *   POST   /api/keys/:provider   → upsertTenantApiKey
 *   GET    /api/keys             → listTenantApiKeys
 *   DELETE /api/keys/:provider   → deleteTenantApiKey
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from 'node:crypto';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';

const logger = pino({ name: 'mozi:security:tenant-keys' });

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      key_hint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      UNIQUE(tenant_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant ON tenant_api_keys(tenant_id);
  `);
  tableReady = true;
}

/** Reset table-ready flag (for tests). */
export function resetTenantKeysTableFlag(): void {
  tableReady = false;
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES-256 key for a specific tenant using HKDF-SHA256.
 * Uses the master secret as input keying material and tenant_id as info.
 */
export function deriveKey(masterSecret: string, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterSecret),
      Buffer.from(tenantId),       // salt
      Buffer.from('mozi-tenant-api-key-v1'),  // info
      32,
    ),
  );
}

/**
 * Encrypt a raw API key using AES-256-GCM.
 * Returns base64-encoded encrypted key, IV, and auth tag.
 */
export function encryptKey(
  rawKey: string,
  derivedKey: Buffer,
): { encrypted: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(rawKey, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted API key.
 */
export function decryptKey(
  encrypted: string,
  iv: string,
  authTag: string,
  derivedKey: Buffer,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derivedKey,
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Key hint
// ---------------------------------------------------------------------------

/** Build a hint showing first 4 + last 4 chars, masking the middle. */
function buildHint(rawKey: string): string {
  if (rawKey.length <= 8) return '****';
  return rawKey.slice(0, 4) + '...' + rawKey.slice(-4);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Store (insert or update) a provider API key for a tenant.
 * The key is encrypted with AES-256-GCM before being stored.
 */
export function upsertTenantApiKey(
  tenantId: string,
  provider: string,
  rawApiKey: string,
  masterSecret: string,
  createdBy?: string,
): void {
  ensureTable();
  const derivedKey = deriveKey(masterSecret, tenantId);
  const { encrypted, iv, authTag } = encryptKey(rawApiKey, derivedKey);
  const hint = buildHint(rawApiKey);
  const db = getDb();
  db.prepare(`
    INSERT INTO tenant_api_keys
      (id, tenant_id, provider, encrypted_key, iv, auth_tag, key_hint, created_by, created_at, updated_at)
    VALUES
      ($id, $tenantId, $provider, $encryptedKey, $iv, $authTag, $keyHint, $createdBy, datetime('now'), datetime('now'))
    ON CONFLICT(tenant_id, provider) DO UPDATE SET
      encrypted_key = excluded.encrypted_key,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      key_hint = excluded.key_hint,
      updated_at = datetime('now')
  `).run({
    id: randomUUID(),
    tenantId,
    provider,
    encryptedKey: encrypted,
    iv,
    authTag,
    keyHint: hint,
    createdBy: createdBy ?? null,
  });
  logger.debug({ tenantId, provider }, 'tenant API key upserted');
}

/**
 * Retrieve and decrypt a provider API key for a tenant.
 * Returns null if no key is stored for this tenant+provider.
 */
export function getTenantApiKey(
  tenantId: string,
  provider: string,
  masterSecret: string,
): string | null {
  ensureTable();
  const db = getDb();
  const row = db
    .prepare(
      'SELECT encrypted_key, iv, auth_tag FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?',
    )
    .get(tenantId, provider) as
    | { encrypted_key: string; iv: string; auth_tag: string }
    | undefined;
  if (!row) return null;

  const derivedKey = deriveKey(masterSecret, tenantId);
  return decryptKey(row.encrypted_key, row.iv, row.auth_tag, derivedKey);
}

/**
 * List all stored provider keys for a tenant.
 * Never returns the actual key — only metadata.
 */
export function listTenantApiKeys(
  tenantId: string,
): Array<{
  provider: string;
  key_hint: string | null;
  created_at: string;
  updated_at: string;
}> {
  ensureTable();
  const db = getDb();
  return db
    .prepare(
      `SELECT provider, key_hint, created_at, updated_at
       FROM tenant_api_keys WHERE tenant_id = ?
       ORDER BY provider ASC`,
    )
    .all(tenantId) as Array<{
    provider: string;
    key_hint: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

/**
 * Delete a provider API key for a tenant.
 * Returns true if a row was deleted, false if not found.
 */
export function deleteTenantApiKey(tenantId: string, provider: string): boolean {
  ensureTable();
  const db = getDb();
  const result = db
    .prepare('DELETE FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?')
    .run(tenantId, provider);
  return result.changes > 0;
}

/**
 * Rotate (replace) a provider API key for a tenant.
 * Updates `updated_at` as an explicit rotation audit timestamp.
 *
 * @throws if no existing key exists for this tenant+provider (must call upsertTenantApiKey first)
 */
export function rotateTenantApiKey(
  tenantId: string,
  provider: string,
  newRawKey: string,
  masterSecret: string,
): void {
  ensureTable();
  const existing = getDb()
    .prepare('SELECT 1 FROM tenant_api_keys WHERE tenant_id = ? AND provider = ?')
    .get(tenantId, provider);

  if (!existing) {
    throw new Error(
      `No API key stored for tenant "${tenantId}" / provider "${provider}". Use upsertTenantApiKey to create one first.`,
    );
  }

  const derivedKey = deriveKey(masterSecret, tenantId);
  const { encrypted, iv, authTag } = encryptKey(newRawKey, derivedKey);
  const hint = newRawKey.length <= 8 ? '****' : newRawKey.slice(0, 4) + '...' + newRawKey.slice(-4);

  getDb().prepare(`
    UPDATE tenant_api_keys
    SET encrypted_key = $encryptedKey,
        iv            = $iv,
        auth_tag      = $authTag,
        key_hint      = $keyHint,
        updated_at    = datetime('now')
    WHERE tenant_id = $tenantId AND provider = $provider
  `).run({ encryptedKey: encrypted, iv, authTag, keyHint: hint, tenantId, provider });

  logger.debug({ tenantId, provider }, 'tenant API key rotated');
}

// ---------------------------------------------------------------------------
// Spec-compatible aliases
// ---------------------------------------------------------------------------

/** Alias for upsertTenantApiKey (spec name: storeTenantApiKey). */
export const storeTenantApiKey = upsertTenantApiKey;

/** Alias for listTenantApiKeys (spec name: listTenantProviders). */
export const listTenantProviders = listTenantApiKeys;

// ---------------------------------------------------------------------------
// Fastify route registration
// ---------------------------------------------------------------------------

import type { FastifyInstance } from 'fastify';

/**
 * Register per-tenant API key management routes.
 * All routes require admin role (enforced by auth guard in api-routes.ts).
 *
 * POST   /api/keys/:provider         → store/update key
 * GET    /api/keys                   → list providers (metadata only, no plaintext)
 * DELETE /api/keys/:provider         → delete key
 * POST   /api/keys/:provider/rotate  → rotate key with audit trail
 */
export function registerTenantKeyRoutes(
  app: FastifyInstance,
  getMasterSecret: () => string,
): void {
  // Upsert key
  app.post<{ Params: { provider: string }; Body: { key: string } }>(
    '/api/keys/:provider',
    async (request, reply) => {
      const ctx = (request as unknown as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
      const tenantId = ctx?.tenant_id ?? 'default';
      const userId = ctx?.user_id ?? 'system';
      const { key } = request.body ?? {};
      if (!key || typeof key !== 'string') {
        return reply.code(400).send({ success: false, error: '"key" string is required' });
      }
      try {
        upsertTenantApiKey(tenantId, request.params.provider, key, getMasterSecret(), userId);
      } catch (err) {
        return reply.code(500).send({ success: false, error: (err as Error).message });
      }
      return reply.code(201).send({ success: true });
    },
  );

  // List providers
  app.get('/api/keys', async (request, reply) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    return reply.send({ success: true, data: listTenantApiKeys(tenantId) });
  });

  // Delete key
  app.delete<{ Params: { provider: string } }>('/api/keys/:provider', async (request, reply) => {
    const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const deleted = deleteTenantApiKey(tenantId, request.params.provider);
    if (!deleted) {
      return reply.code(404).send({ success: false, error: 'Provider key not found' });
    }
    return reply.send({ success: true });
  });

  // Rotate key
  app.post<{ Params: { provider: string }; Body: { key: string } }>(
    '/api/keys/:provider/rotate',
    async (request, reply) => {
      const ctx = (request as unknown as { tenantContext?: { tenant_id: string } }).tenantContext;
      const tenantId = ctx?.tenant_id ?? 'default';
      const { key } = request.body ?? {};
      if (!key || typeof key !== 'string') {
        return reply.code(400).send({ success: false, error: '"key" string is required' });
      }
      try {
        rotateTenantApiKey(tenantId, request.params.provider, key, getMasterSecret());
      } catch (err) {
        const message = (err as Error).message;
        const status = message.includes('No API key stored') ? 404 : 500;
        return reply.code(status).send({ success: false, error: message });
      }
      return reply.send({ success: true });
    },
  );
}
