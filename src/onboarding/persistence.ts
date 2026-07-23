import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureMoziHome, getConfigPath, getEnvPath } from '../paths.js';
import { readConfigWithLegacyFallback, writeConfigObject } from '../config/storage.js';
import { getSecret, isSecretKey, resolveMasterKey, setSecret } from '../security/secrets.js';

type RawConfig = Record<string, unknown>;

export interface OnboardingWriteContractInput {
  workspaceDir: string;
  requiredEnvKeys?: string[];
  configPath?: string;
  envPath?: string;
}

export interface OnboardingWriteContractResult {
  ok: boolean;
  errors: string[];
}

function parseConfig(configPath: string): RawConfig {
  return readConfigWithLegacyFallback(configPath).config;
}

function writeConfig(configPath: string, config: RawConfig): void {
  writeConfigObject(configPath, config);
}

function ensureObject(root: RawConfig, key: string): RawConfig {
  const current = root[key];
  if (!current || typeof current !== 'object') {
    root[key] = {};
  }
  return root[key] as RawConfig;
}

export function saveWorkspaceDirToConfig(workspaceDir: string, configPath = getConfigPath()): void {
  const config = parseConfig(configPath);
  const workspace = ensureObject(config, 'workspace');
  workspace.dir = workspaceDir;
  writeConfig(configPath, config);
}

export function saveServerDefaultsToConfig(configPath = getConfigPath()): void {
  const config = parseConfig(configPath);
  const server = ensureObject(config, 'server');
  if (!server.host) server.host = '127.0.0.1';
  if (!server.port) server.port = 9210;
  if (!server.auth_mode) server.auth_mode = 'token';
  writeConfig(configPath, config);
}

export function saveWizardRuntimeConfig(workspaceDir: string, configPath = getConfigPath()): void {
  const config = parseConfig(configPath);
  const workspace = ensureObject(config, 'workspace');
  workspace.dir = workspaceDir;
  const server = ensureObject(config, 'server');
  if (!server.host) server.host = '127.0.0.1';
  if (!server.port) server.port = 9210;
  if (!server.auth_mode) server.auth_mode = 'token';
  writeConfig(configPath, config);
}

function parseEnvFile(envPath: string): string[] {
  if (!existsSync(envPath)) return [];
  return readFileSync(envPath, 'utf-8').split(/\r?\n/);
}

export function readEnvVar(key: string, envPath = getEnvPath()): string | null {
  const lines = parseEnvFile(envPath);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const k = line.slice(0, idx);
    if (k === key) {
      return line.slice(idx + 1);
    }
  }
  return null;
}

export function upsertEnvVar(key: string, value: string, envPath = getEnvPath()): void {
  ensureMoziHome();
  const lines = parseEnvFile(envPath);
  const next = `${key}=${value}`;
  let replaced = false;

  const updated = lines.map((line) => {
    if (!line || line.startsWith('#')) return line;
    const idx = line.indexOf('=');
    if (idx <= 0) return line;
    const k = line.slice(0, idx);
    if (k !== key) return line;
    replaced = true;
    return next;
  });

  if (!replaced) updated.push(next);
  const output = `${updated.join('\n').replace(/\n*$/, '\n')}`;
  writeFileSync(envPath, output, { mode: 0o600 });
}

/**
 * Persist a named env entry to the right store.
 * Secret-looking keys go to encrypted storage when available; everything else
 * stays in ~/.mozi/.env. Always mirrors the value into process.env.
 */
export function persistEnvValue(key: string, value: string, envPath = getEnvPath()): void {
  process.env[key] = value;
  if (isSecretKey(key)) {
    upsertSecret(key, value, envPath);
    return;
  }
  upsertEnvVar(key, value, envPath);
}

/**
 * Persist a secret into the encrypted store whenever a master key is available.
 * Falls back to plaintext .env only when no encrypted-secret capability exists yet.
 * Always sets process.env.
 */
export function upsertSecret(key: string, value: string, envPath = getEnvPath()): void {
  const masterKey = resolveMasterKey();
  if (masterKey) {
    setSecret(key, value, masterKey);
    process.env[key] = value;
    return;
  }
  // Fallback to plaintext .env
  upsertEnvVar(key, value, envPath);
  process.env[key] = value;
}

export function persistSearchKey(value: string, envPath = getEnvPath()): void {
  persistEnvValue('SEARCH1API_KEY', value, envPath);
}

export function persistTelegramBotToken(value: string, envPath = getEnvPath()): void {
  persistEnvValue('TELEGRAM_BOT_TOKEN', value, envPath);
}

export function persistWeChatBotToken(value: string, envPath = getEnvPath()): void {
  persistEnvValue('WECHAT_BOT_TOKEN', value, envPath);
}

export function readPersistedSecret(key: string, envPath = getEnvPath()): string | null {
  const envValue = readEnvVar(key, envPath);
  if (envValue) {
    return envValue;
  }

  const masterKey = resolveMasterKey();
  if (!masterKey) {
    return null;
  }

  try {
    return getSecret(key, masterKey);
  } catch {
    return null;
  }
}

export function validateOnboardingWriteContract(input: OnboardingWriteContractInput): OnboardingWriteContractResult {
  const configPath = input.configPath ?? getConfigPath();
  const envPath = input.envPath ?? getEnvPath();
  const errors: string[] = [];

  const config = parseConfig(configPath);
  const workspace = (config.workspace ?? {}) as RawConfig;
  if (workspace.dir !== input.workspaceDir) {
    errors.push(`workspace.dir mismatch: expected "${input.workspaceDir}", got "${String(workspace.dir ?? '')}"`);
  }

  const server = (config.server ?? {}) as RawConfig;
  if (!server.host || typeof server.host !== 'string') {
    errors.push('server.host missing');
  }
  if (typeof server.port !== 'number') {
    errors.push('server.port missing');
  }
  if (!server.auth_mode || typeof server.auth_mode !== 'string') {
    errors.push('server.auth_mode missing');
  }

  for (const key of input.requiredEnvKeys ?? []) {
    const value = readPersistedSecret(key, envPath);
    if (!value) {
      errors.push(`${key} missing in persisted secret storage`);
    }
  }

  return { ok: errors.length === 0, errors };
}
