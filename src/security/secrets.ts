/**
 * Secrets management — encrypted storage for API keys and sensitive values.
 *
 * Uses AES-256-GCM with scrypt key derivation. Master key is stored
 * in `~/.mozi/.master-key` (mode 0o400) or provided via `MOZI_MASTER_PASSWORD`.
 *
 * File format: [1B version][16B salt][12B IV][16B authTag][ciphertext]
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import {
  ensureMoziHome,
  getSecretsPath,
  getMasterKeyPath,
  getEnvPath,
  getJwtSecretPath,
} from '../paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Patterns that identify secret env var names. */
export const SECRET_PATTERNS: RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /^SEARCH1API_KEY$/i,
  /^TELEGRAM_BOT_TOKEN$/i,
];

// ---------------------------------------------------------------------------
// Encryption primitives
// ---------------------------------------------------------------------------

/** Derive an AES-256 key from the master key and a random salt. */
function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/** Encrypt plaintext using AES-256-GCM. Returns a Buffer in the file format. */
export function encrypt(plaintext: string, masterKey: Buffer): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(masterKey, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // [version][salt][iv][authTag][ciphertext]
  return Buffer.concat([
    Buffer.from([VERSION]),
    salt,
    iv,
    authTag,
    encrypted,
  ]);
}

/** Decrypt a ciphertext buffer using AES-256-GCM. */
export function decrypt(ciphertext: Buffer, masterKey: Buffer): string {
  if (ciphertext.length < 1 + SALT_LEN + IV_LEN + AUTH_TAG_LEN) {
    throw new Error('Invalid secrets file: too short');
  }

  const version = ciphertext[0];
  if (version !== VERSION) {
    throw new Error(`Unsupported secrets file version: ${version}`);
  }

  let offset = 1;
  const salt = ciphertext.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = ciphertext.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const authTag = ciphertext.subarray(offset, offset + AUTH_TAG_LEN);
  offset += AUTH_TAG_LEN;
  const encrypted = ciphertext.subarray(offset);

  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Master key management
// ---------------------------------------------------------------------------

/**
 * Resolve the master key for encryption/decryption.
 * Checks `MOZI_MASTER_PASSWORD` env var first, then reads `~/.mozi/.master-key`.
 * Returns null if no master key is available.
 */
export function resolveMasterKey(): Buffer | null {
  const envKey = process.env.MOZI_MASTER_PASSWORD;
  if (envKey) {
    return Buffer.from(envKey, 'hex');
  }

  const keyPath = getMasterKeyPath();
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }

  return null;
}

/**
 * Generate a new 32-byte master key and write it to `~/.mozi/.master-key`
 * with restrictive permissions (0o400 — owner read only).
 */
export function generateMasterKey(): Buffer {
  ensureMoziHome();
  const key = randomBytes(KEY_LEN);
  const keyPath = getMasterKeyPath();
  writeFileSync(keyPath, key, { mode: 0o400 });
  return key;
}

export function resolveTenantMasterSecret(options: { createIfMissing?: boolean } = {}): string | null {
  const envSecret = process.env.MOZI_MASTER_PASSWORD?.trim();
  if (envSecret) return envSecret;

  const existingKey = resolveMasterKey();
  if (existingKey) return existingKey.toString('hex');

  if (options.createIfMissing) {
    return generateMasterKey().toString('hex');
  }
  return null;
}

// ---------------------------------------------------------------------------
// JWT secret persistence
// ---------------------------------------------------------------------------

/**
 * Resolve the JWT signing secret, persisting it across restarts.
 *
 * Resolution order:
 * 1. Read from `MOZI_JWT_SECRET_PATH` (or default `~/.mozi/jwt-secret`) if file exists.
 * 2. Generate a cryptographically secure 64-byte hex secret, write to file (mode 0600), return it.
 *
 * The directory is created if it doesn't exist.
 */
export function resolveJwtSecret(): string {
  const secretPath = getJwtSecretPath();
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf-8').trim();
  }
  ensureMoziHome();
  const secret = randomBytes(64).toString('hex');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

// ---------------------------------------------------------------------------
// Secret CRUD operations
// ---------------------------------------------------------------------------

/** Load all secrets from the encrypted store. Returns empty object if file doesn't exist. */
export function loadSecrets(masterKey: Buffer): Record<string, string> {
  const secretsPath = getSecretsPath();
  if (!existsSync(secretsPath)) {
    return {};
  }
  const ciphertext = readFileSync(secretsPath);
  const json = decrypt(ciphertext, masterKey);
  return JSON.parse(json) as Record<string, string>;
}

/** Save secrets to the encrypted store (atomic write via temp+rename). */
export function saveSecrets(
  secrets: Record<string, string>,
  masterKey: Buffer,
): void {
  ensureMoziHome();
  const secretsPath = getSecretsPath();
  const json = JSON.stringify(secrets);
  const ciphertext = encrypt(json, masterKey);

  // Atomic write: write to temp file then rename
  const tmpPath = secretsPath + '.tmp';
  writeFileSync(tmpPath, ciphertext, { mode: 0o600 });
  renameSync(tmpPath, secretsPath);
}

/** Set a single secret in the encrypted store. */
export function setSecret(
  key: string,
  value: string,
  masterKey: Buffer,
): void {
  const secrets = loadSecrets(masterKey);
  secrets[key] = value;
  saveSecrets(secrets, masterKey);
}

/** Get a single secret from the encrypted store. Returns null if not found. */
export function getSecret(key: string, masterKey: Buffer): string | null {
  const secrets = loadSecrets(masterKey);
  return secrets[key] ?? null;
}

/** Delete a single secret from the encrypted store. Returns true if it existed. */
export function deleteSecret(key: string, masterKey: Buffer): boolean {
  const secrets = loadSecrets(masterKey);
  if (!(key in secrets)) return false;
  delete secrets[key];
  saveSecrets(secrets, masterKey);
  return true;
}

/** List all secret key names (no values). */
export function listSecretKeys(masterKey: Buffer): string[] {
  const secrets = loadSecrets(masterKey);
  return Object.keys(secrets);
}

// ---------------------------------------------------------------------------
// Startup entrypoint
// ---------------------------------------------------------------------------

/** Parse a .env file into key-value pairs (handles comments, empty lines). */
function parseEnvContent(content: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      entries.push({
        key: trimmed.slice(0, eqIdx),
        value: trimmed.slice(eqIdx + 1),
      });
    }
  }
  return entries;
}

/**
 * Load .env (non-secret vars) and encrypted secrets into process.env.
 *
 * 1. Reads `~/.mozi/.env` for non-secret configuration
 * 2. If `secrets.enc` exists and a master key is available, decrypts and
 *    injects secrets into process.env (only if key not already set)
 * 3. Falls back gracefully if no encrypted store exists
 */
export function loadEnvAndSecrets(): void {
  // Step 1: Load .env (same logic as before — non-secret vars)
  const envPath = getEnvPath();
  if (existsSync(envPath)) {
    const entries = parseEnvContent(readFileSync(envPath, 'utf-8'));
    for (const { key, value } of entries) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  // Step 2: Load encrypted secrets if available
  const secretsPath = getSecretsPath();
  if (!existsSync(secretsPath)) {
    return; // No encrypted store — backward compatible
  }

  const masterKey = resolveMasterKey();
  if (!masterKey) {
    // secrets.enc exists but no master key — warn but don't fail
    // This allows migration-in-progress scenarios
    return;
  }

  try {
    const secrets = loadSecrets(masterKey);
    const count = Object.keys(secrets).length;
    for (const [key, value] of Object.entries(secrets)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    // Audit log is deferred to after DB init — caller can log separately
    if (count > 0 && typeof (globalThis as Record<string, unknown>).__moziSecretsLoadedCount === 'undefined') {
      (globalThis as Record<string, unknown>).__moziSecretsLoadedCount = count;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Failed to decrypt secrets.enc: ${message}`);
    console.error('Falling back to .env only. Check master key or run: mozi secrets configure');
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrationResult {
  migrated: string[];
  kept: string[];
  total: number;
}

/** Check if an env var name matches secret patterns. */
export function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Migrate secrets from plaintext .env to encrypted store.
 *
 * 1. Reads all entries from .env
 * 2. Classifies keys as secret or non-secret
 * 3. Encrypts secret keys into secrets.enc
 * 4. Rewrites .env with only non-secret entries (preserving comments)
 */
export function migrateFromEnv(masterKey: Buffer): MigrationResult {
  const envPath = getEnvPath();
  if (!existsSync(envPath)) {
    return { migrated: [], kept: [], total: 0 };
  }

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  const secretEntries: Record<string, string> = {};
  const nonSecretLines: string[] = [];
  const migrated: string[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      nonSecretLines.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) {
      nonSecretLines.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);

    if (isSecretKey(key)) {
      secretEntries[key] = value;
      migrated.push(key);
    } else {
      nonSecretLines.push(line);
      kept.push(key);
    }
  }

  if (migrated.length > 0) {
    // Merge with any existing secrets
    const existing = existsSync(getSecretsPath()) ? loadSecrets(masterKey) : {};
    const merged = { ...existing, ...secretEntries };
    saveSecrets(merged, masterKey);

    // Rewrite .env without secret entries
    const cleanedContent = nonSecretLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
    writeFileSync(envPath, cleanedContent, { mode: 0o600 });
  }

  return {
    migrated,
    kept,
    total: migrated.length + kept.length,
  };
}

// ---------------------------------------------------------------------------
// Audit logging (best-effort — skips silently if DB unavailable)
// ---------------------------------------------------------------------------

/** Log a secret operation to the event_log. Values are NEVER logged. */
async function auditLog(eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { log } = await import('../store/events.js');
    log(eventType, 'secret', entityId, payload);
  } catch {
    // DB not initialized — skip audit silently (CLI commands may run without DB)
  }
}

// ---------------------------------------------------------------------------
// CLI command handlers
// ---------------------------------------------------------------------------

/**
 * `mozi secrets configure` — generate master key and migrate .env secrets.
 */
export async function cmdSecretsConfigure(): Promise<void> {
  const existingKey = resolveMasterKey();
  let masterKey: Buffer;

  if (existingKey) {
    console.log('Master key already exists. Using existing key.');
    masterKey = existingKey;
  } else {
    masterKey = generateMasterKey();
    console.log('Generated new master key at: ' + getMasterKeyPath());
  }

  const result = migrateFromEnv(masterKey);
  if (result.migrated.length === 0) {
    console.log('No secrets found in .env to migrate.');
  } else {
    console.log(`\nMigrated ${result.migrated.length} secret(s) to encrypted store:`);
    for (const key of result.migrated) {
      console.log(`  - ${key}`);
    }
  }
  if (result.kept.length > 0) {
    console.log(`\nKept ${result.kept.length} non-secret entry(ies) in .env:`);
    for (const key of result.kept) {
      console.log(`  - ${key}`);
    }
  }
  console.log('\nDone. Secrets are now encrypted in: ' + getSecretsPath());

  await auditLog('secret_configured', '*', { migrated: result.migrated.length, kept: result.kept.length });
}

/**
 * `mozi secrets list` — print secret key names (no values).
 */
export function cmdSecretsList(): void {
  const masterKey = resolveMasterKey();
  if (!masterKey) {
    console.error('No master key found. Run: mozi secrets configure');
    process.exit(1);
  }

  const keys = listSecretKeys(masterKey);
  if (keys.length === 0) {
    console.log('No secrets stored.');
    return;
  }

  console.log(`\nStored secrets (${keys.length}):\n`);
  for (const key of keys) {
    console.log(`  - ${key}`);
  }
  console.log('');
}

/**
 * `mozi secrets set <KEY> <VALUE>` — add or update a secret.
 */
export async function cmdSecretsSet(key: string, value: string): Promise<void> {
  const masterKey = resolveMasterKey();
  if (!masterKey) {
    console.error('No master key found. Run: mozi secrets configure');
    process.exit(1);
  }

  setSecret(key, value, masterKey);
  process.env[key] = value;
  console.log(`Secret '${key}' saved.`);

  await auditLog('secret_modified', key, { action: 'set' });
}

/**
 * `mozi secrets get <KEY>` — show a masked secret value.
 */
export async function cmdSecretsGet(key: string, reveal: boolean): Promise<void> {
  const masterKey = resolveMasterKey();
  if (!masterKey) {
    console.error('No master key found. Run: mozi secrets configure');
    process.exit(1);
  }

  const value = getSecret(key, masterKey);
  if (value === null) {
    console.error(`Secret '${key}' not found.`);
    process.exit(1);
  }

  if (reveal) {
    console.log(value);
  } else {
    const masked = value.length <= 8
      ? '****'
      : value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
    console.log(`${key}=${masked}`);
  }

  await auditLog('secret_accessed', key, { action: 'get' });
}

/**
 * `mozi secrets apply` — re-encrypt with fresh IV/salt, optionally rotate master key.
 */
export function cmdSecretsApply(rotateKey: boolean): void {
  const oldKey = resolveMasterKey();
  if (!oldKey) {
    console.error('No master key found. Run: mozi secrets configure');
    process.exit(1);
  }

  const secrets = loadSecrets(oldKey);
  if (Object.keys(secrets).length === 0) {
    console.log('No secrets to re-encrypt.');
    return;
  }

  let newKey = oldKey;
  if (rotateKey) {
    newKey = generateMasterKey();
    console.log('Master key rotated.');
  }

  saveSecrets(secrets, newKey);
  console.log(`Re-encrypted ${Object.keys(secrets).length} secret(s) with fresh IV/salt.`);
}

/**
 * `mozi secrets reload` — decrypt and re-inject into process.env.
 */
export function cmdSecretsReload(): void {
  const masterKey = resolveMasterKey();
  if (!masterKey) {
    console.error('No master key found. Run: mozi secrets configure');
    process.exit(1);
  }

  const secrets = loadSecrets(masterKey);
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
  }
  console.log(`Reloaded ${Object.keys(secrets).length} secret(s) into process.env.`);
}

/**
 * `mozi secrets export` — dump secrets to plaintext .env format (for backup/revert).
 */
export function cmdSecretsExport(): void {
  const masterKey = resolveMasterKey();
  if (!masterKey) {
    console.error('No master key found. Run: mozi secrets configure');
    process.exit(1);
  }

  const secrets = loadSecrets(masterKey);
  if (Object.keys(secrets).length === 0) {
    console.log('No secrets stored.');
    return;
  }

  console.log('# Exported secrets (plaintext)');
  for (const [key, value] of Object.entries(secrets)) {
    console.log(`${key}=${value}`);
  }
}

/**
 * `mozi secrets audit` — show audit log entries for secret operations.
 * Requires DB to be initialized first (caller must call initDatabase()).
 */
export async function cmdSecretsAudit(): Promise<void> {
  try {
    const { getDb } = await import('../store/db.js');
    const db = getDb();
    const rows = db.prepare(`
      SELECT event_type, entity_id, payload, created_at
      FROM event_log
      WHERE entity_type = 'secret'
      ORDER BY created_at DESC
      LIMIT 50
    `).all() as Array<{ event_type: string; entity_id: string; payload: string; created_at: string }>;

    if (rows.length === 0) {
      console.log('No secret audit events found.');
      return;
    }

    console.log(`\nSecret Audit Log (${rows.length} entries):\n`);
    console.log('  Time                     │ Event              │ Key            │ Details');
    console.log('  ─────────────────────────┼────────────────────┼────────────────┼─────────');
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      const details = Object.entries(payload).map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(`  ${row.created_at.padEnd(25)}│ ${row.event_type.padEnd(19)}│ ${row.entity_id.padEnd(15)}│ ${details}`);
    }
    console.log('');
  } catch {
    console.error('Database not available. Start MOZI first or run: mozi secrets configure');
  }
}
