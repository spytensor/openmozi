import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  encrypt,
  decrypt,
  generateMasterKey,
  resolveMasterKey,
  loadSecrets,
  saveSecrets,
  setSecret,
  getSecret,
  listSecretKeys,
  loadEnvAndSecrets,
  migrateFromEnv,
  isSecretKey,
  SECRET_PATTERNS,
  resolveJwtSecret,
  resolveTenantMasterSecret,
} from './secrets.js';
import { getEnvPath, getSecretsPath, getMasterKeyPath, getJwtSecretPath } from '../paths.js';

let tmpHome = '';
let moziHomeBackup: string | undefined;
let masterPasswordBackup: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mozi-secrets-'));
  moziHomeBackup = process.env.MOZI_HOME;
  masterPasswordBackup = process.env.MOZI_MASTER_PASSWORD;
  process.env.MOZI_HOME = tmpHome;
  delete process.env.MOZI_MASTER_PASSWORD;
});

afterEach(() => {
  if (moziHomeBackup === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = moziHomeBackup;
  if (masterPasswordBackup === undefined) delete process.env.MOZI_MASTER_PASSWORD;
  else process.env.MOZI_MASTER_PASSWORD = masterPasswordBackup;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('encrypt/decrypt', () => {
  it('round-trips plaintext of various sizes', () => {
    const masterKey = randomBytes(32);
    for (const text of ['', 'hello', 'x'.repeat(1000), '中文测试', '{"key":"value"}']) {
      const ciphertext = encrypt(text, masterKey);
      const decrypted = decrypt(ciphertext, masterKey);
      expect(decrypted).toBe(text);
    }
  });

  it('fails with wrong master key', () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const ciphertext = encrypt('secret data', key1);
    expect(() => decrypt(ciphertext, key2)).toThrow();
  });

  it('fails with tampered ciphertext', () => {
    const masterKey = randomBytes(32);
    const ciphertext = encrypt('secret data', masterKey);
    // Tamper with a byte in the encrypted portion
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decrypt(tampered, masterKey)).toThrow();
  });

  it('fails with truncated ciphertext', () => {
    const masterKey = randomBytes(32);
    const ciphertext = encrypt('secret data', masterKey);
    const truncated = ciphertext.subarray(0, 10);
    expect(() => decrypt(truncated, masterKey)).toThrow(/too short/);
  });

  it('includes version byte', () => {
    const masterKey = randomBytes(32);
    const ciphertext = encrypt('test', masterKey);
    expect(ciphertext[0]).toBe(0x01);
  });

  it('produces different ciphertext each time (random IV/salt)', () => {
    const masterKey = randomBytes(32);
    const ct1 = encrypt('same', masterKey);
    const ct2 = encrypt('same', masterKey);
    expect(ct1.equals(ct2)).toBe(false);
  });
});

describe('master key management', () => {
  it('generateMasterKey creates a 32-byte key file with restricted permissions', () => {
    const key = generateMasterKey();
    expect(key.length).toBe(32);
    const keyPath = getMasterKeyPath();
    expect(existsSync(keyPath)).toBe(true);
    const stats = statSync(keyPath);
    // 0o400 = owner read only (on macOS/Linux)
    expect(stats.mode & 0o777).toBe(0o400);
  });

  it('resolveMasterKey reads from file', () => {
    const generated = generateMasterKey();
    const resolved = resolveMasterKey();
    expect(resolved).not.toBeNull();
    expect(resolved!.equals(generated)).toBe(true);
  });

  it('resolveMasterKey prefers env var over file', () => {
    generateMasterKey();
    const envKey = randomBytes(32);
    process.env.MOZI_MASTER_PASSWORD = envKey.toString('hex');
    const resolved = resolveMasterKey();
    expect(resolved).not.toBeNull();
    expect(resolved!.equals(envKey)).toBe(true);
  });

  it('resolveMasterKey returns null when nothing available', () => {
    expect(resolveMasterKey()).toBeNull();
  });

  it('resolveTenantMasterSecret does not generate a key for read-only lookups', () => {
    expect(resolveTenantMasterSecret()).toBeNull();
    expect(existsSync(getMasterKeyPath())).toBe(false);
  });

  it('resolveTenantMasterSecret generates and persists a key when requested', () => {
    const first = resolveTenantMasterSecret({ createIfMissing: true });
    const second = resolveTenantMasterSecret();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(existsSync(getMasterKeyPath())).toBe(true);
  });
});

describe('secret CRUD', () => {
  let masterKey: Buffer;

  beforeEach(() => {
    masterKey = generateMasterKey();
  });

  it('save and load round-trips multiple secrets', () => {
    const secrets = { API_KEY: 'abc123', TOKEN: 'xyz789', PASSWORD: 'p@ss' };
    saveSecrets(secrets, masterKey);
    const loaded = loadSecrets(masterKey);
    expect(loaded).toEqual(secrets);
  });

  it('loadSecrets returns empty object when no file exists', () => {
    const loaded = loadSecrets(masterKey);
    expect(loaded).toEqual({});
  });

  it('setSecret adds and updates secrets', () => {
    setSecret('MY_API_KEY', 'first', masterKey);
    expect(getSecret('MY_API_KEY', masterKey)).toBe('first');

    setSecret('MY_API_KEY', 'second', masterKey);
    expect(getSecret('MY_API_KEY', masterKey)).toBe('second');
  });

  it('getSecret returns null for missing keys', () => {
    expect(getSecret('NONEXISTENT', masterKey)).toBeNull();
  });

  it('listSecretKeys returns all key names', () => {
    saveSecrets({ A_KEY: '1', B_TOKEN: '2', C_SECRET: '3' }, masterKey);
    const keys = listSecretKeys(masterKey);
    expect(keys.sort()).toEqual(['A_KEY', 'B_TOKEN', 'C_SECRET']);
  });

  it('saveSecrets overwrites atomically', () => {
    saveSecrets({ KEY1: 'v1' }, masterKey);
    saveSecrets({ KEY2: 'v2' }, masterKey);
    const loaded = loadSecrets(masterKey);
    expect(loaded).toEqual({ KEY2: 'v2' });
    expect(loaded.KEY1).toBeUndefined();
  });
});

describe('isSecretKey', () => {
  it('matches API key patterns', () => {
    expect(isSecretKey('OPENAI_API_KEY')).toBe(true);
    expect(isSecretKey('MINIMAX_API_KEY')).toBe(true);
    expect(isSecretKey('GROQ_API_KEY')).toBe(true);
  });

  it('matches token patterns', () => {
    expect(isSecretKey('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(isSecretKey('AUTH_TOKEN')).toBe(true);
  });

  it('matches secret and password patterns', () => {
    expect(isSecretKey('JWT_SECRET')).toBe(true);
    expect(isSecretKey('DB_PASSWORD')).toBe(true);
  });

  it('does not match non-secret keys', () => {
    expect(isSecretKey('NODE_ENV')).toBe(false);
    expect(isSecretKey('PORT')).toBe(false);
    expect(isSecretKey('LOG_LEVEL')).toBe(false);
    expect(isSecretKey('MOZI_HOME')).toBe(false);
  });
});

describe('migrateFromEnv', () => {
  let masterKey: Buffer;

  beforeEach(() => {
    masterKey = generateMasterKey();
  });

  it('migrates secret keys and keeps non-secrets in .env', () => {
    const envPath = getEnvPath();
    writeFileSync(envPath, [
      '# Config comment',
      'NODE_ENV=production',
      'OPENAI_API_KEY=sk-abc123',
      'TELEGRAM_BOT_TOKEN=bot:xyz',
      'LOG_LEVEL=info',
      'JWT_SECRET=mysecret',
    ].join('\n'), { mode: 0o600 });

    const result = migrateFromEnv(masterKey);

    expect(result.migrated.sort()).toEqual(['JWT_SECRET', 'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(result.kept.sort()).toEqual(['LOG_LEVEL', 'NODE_ENV']);

    // Verify secrets.enc was created with the right content
    const secrets = loadSecrets(masterKey);
    expect(secrets.OPENAI_API_KEY).toBe('sk-abc123');
    expect(secrets.TELEGRAM_BOT_TOKEN).toBe('bot:xyz');
    expect(secrets.JWT_SECRET).toBe('mysecret');

    // Verify .env no longer contains secrets
    const envContent = readFileSync(envPath, 'utf-8');
    expect(envContent).toContain('NODE_ENV=production');
    expect(envContent).toContain('LOG_LEVEL=info');
    expect(envContent).toContain('# Config comment');
    expect(envContent).not.toContain('OPENAI_API_KEY');
    expect(envContent).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(envContent).not.toContain('JWT_SECRET');
  });

  it('returns empty result when no .env exists', () => {
    const result = migrateFromEnv(masterKey);
    expect(result.migrated).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('merges with existing secrets', () => {
    // Pre-populate with an existing secret
    saveSecrets({ EXISTING_API_KEY: 'old-value' }, masterKey);

    const envPath = getEnvPath();
    writeFileSync(envPath, 'NEW_API_KEY=new-value\n', { mode: 0o600 });

    migrateFromEnv(masterKey);

    const secrets = loadSecrets(masterKey);
    expect(secrets.EXISTING_API_KEY).toBe('old-value');
    expect(secrets.NEW_API_KEY).toBe('new-value');
  });
});

describe('loadEnvAndSecrets', () => {
  it('loads .env when no secrets.enc exists (backward compat)', () => {
    const envPath = getEnvPath();
    const testKey = `TEST_COMPAT_${Date.now()}`;
    writeFileSync(envPath, `${testKey}=hello\n`, { mode: 0o600 });

    // Clear any existing value
    delete process.env[testKey];

    loadEnvAndSecrets();

    expect(process.env[testKey]).toBe('hello');

    // Cleanup
    delete process.env[testKey];
  });

  it('loads both .env and encrypted secrets', () => {
    const masterKey = generateMasterKey();
    const envKey = `TEST_ENV_${Date.now()}`;
    const secretKey = `TEST_SECRET_${Date.now()}`;

    // Write non-secret to .env
    const envPath = getEnvPath();
    writeFileSync(envPath, `${envKey}=env-value\n`, { mode: 0o600 });

    // Write secret to encrypted store
    saveSecrets({ [secretKey]: 'secret-value' }, masterKey);

    // Clear any existing values
    delete process.env[envKey];
    delete process.env[secretKey];

    loadEnvAndSecrets();

    expect(process.env[envKey]).toBe('env-value');
    expect(process.env[secretKey]).toBe('secret-value');

    // Cleanup
    delete process.env[envKey];
    delete process.env[secretKey];
  });

  it('does not overwrite existing process.env values', () => {
    const masterKey = generateMasterKey();
    const testKey = `TEST_NOOVERWRITE_${Date.now()}`;

    saveSecrets({ [testKey]: 'from-secrets' }, masterKey);
    process.env[testKey] = 'already-set';

    loadEnvAndSecrets();

    expect(process.env[testKey]).toBe('already-set');

    // Cleanup
    delete process.env[testKey];
  });

  it('handles missing master key gracefully when secrets.enc exists', () => {
    // Create secrets.enc with a temporary key, then remove the key
    const tempKey = randomBytes(32);
    const secretsPath = getSecretsPath();
    const ciphertext = encrypt('{"DUMMY":"val"}', tempKey);
    writeFileSync(secretsPath, ciphertext, { mode: 0o600 });

    // No master key file, no env var — should not throw
    expect(() => loadEnvAndSecrets()).not.toThrow();
  });
});

describe('resolveJwtSecret', () => {
  let jwtSecretPathBackup: string | undefined;

  beforeEach(() => {
    jwtSecretPathBackup = process.env.MOZI_JWT_SECRET_PATH;
    // Point to a path inside tmpHome so tests stay isolated
    process.env.MOZI_JWT_SECRET_PATH = join(tmpHome, 'jwt-secret');
  });

  afterEach(() => {
    if (jwtSecretPathBackup === undefined) delete process.env.MOZI_JWT_SECRET_PATH;
    else process.env.MOZI_JWT_SECRET_PATH = jwtSecretPathBackup;
  });

  it('generates a 128-char hex secret on first call', () => {
    const secret = resolveJwtSecret();
    expect(typeof secret).toBe('string');
    expect(secret).toHaveLength(128); // 64 bytes = 128 hex chars
    expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
  });

  it('persists the secret to disk with mode 0600', () => {
    resolveJwtSecret();
    const secretPath = getJwtSecretPath();
    expect(existsSync(secretPath)).toBe(true);
    const stat = statSync(secretPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns the same secret on subsequent calls', () => {
    const first = resolveJwtSecret();
    const second = resolveJwtSecret();
    expect(second).toBe(first);
  });

  it('reads an existing secret file without overwriting it', () => {
    const secretPath = getJwtSecretPath();
    const existing = 'a'.repeat(128);
    writeFileSync(secretPath, existing, { mode: 0o600 });

    const resolved = resolveJwtSecret();
    expect(resolved).toBe(existing);
  });

  it('respects MOZI_JWT_SECRET_PATH env var', () => {
    const customPath = join(tmpHome, 'custom-jwt-secret');
    process.env.MOZI_JWT_SECRET_PATH = customPath;

    const secret = resolveJwtSecret();
    expect(existsSync(customPath)).toBe(true);
    expect(readFileSync(customPath, 'utf-8').trim()).toBe(secret);
  });
});
