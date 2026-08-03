/**
 * CLI OAuth Credential Reader
 *
 * Reads OAuth credentials stored by CLI tools (Claude Code, Codex CLI)
 * and resolves them to API configurations, enabling direct API calls
 * instead of spawning CLI subprocesses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pino from 'pino';

const logger = pino({ name: 'mozi:cli-credentials' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface ResolvedCliOAuth {
  accessToken: string;
  apiMode: 'anthropic' | 'openai-compat';
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: CliCredentials | null;
  timestamp: number;
}

interface CodexAuthFile {
  oauth: CliCredentials | null;
  hasApiKey: boolean;
}

interface CodexAuthCacheEntry {
  value: CodexAuthFile | null;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
let codexAuthCache: CodexAuthCacheEntry | undefined;

function getCached(key: string): CliCredentials | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(key: string, value: CliCredentials | null): void {
  cache.set(key, { value, timestamp: Date.now() });
}

/** Clear the credential cache (exposed for testing). */
export function clearCredentialCache(): void {
  cache.clear();
  codexAuthCache = undefined;
}

// ---------------------------------------------------------------------------
// Credential readers
// ---------------------------------------------------------------------------

/**
 * Read OAuth credentials stored by Claude Code CLI.
 * File: ~/.claude/.credentials.json
 * Shape: { claudeAiOauth: { accessToken, refreshToken, expiresAt } }
 */
export function readClaudeCliCredentials(): CliCredentials | null {
  const cacheKey = 'claude-cli';
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const filePath = join(homedir(), '.claude', '.credentials.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;
    if (!oauth?.accessToken) {
      setCache(cacheKey, null);
      return null;
    }
    const creds: CliCredentials = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    };
    setCache(cacheKey, creds);
    return creds;
  } catch {
    setCache(cacheKey, null);
    return null;
  }
}

function readCodexAuthFile(): CodexAuthFile | null {
  if (codexAuthCache && Date.now() - codexAuthCache.timestamp <= CACHE_TTL_MS) {
    return codexAuthCache.value;
  }
  try {
    const filePath = join(homedir(), '.codex', 'auth.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const tokens = data?.tokens;
    const value: CodexAuthFile = {
      oauth: tokens?.access_token ? {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      } : null,
      hasApiKey: typeof data?.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim().length > 0,
    };
    codexAuthCache = { value, timestamp: Date.now() };
    return value;
  } catch {
    codexAuthCache = { value: null, timestamp: Date.now() };
    return null;
  }
}

/**
 * Read OAuth credentials stored by Codex CLI for the optional direct-API path.
 * API-key authentication is intentionally not returned as OAuth credentials.
 */
export function readCodexCliCredentials(): CliCredentials | null {
  return readCodexAuthFile()?.oauth ?? null;
}

/** True when Codex CLI can authenticate through OAuth or an API key. */
export function hasCodexCliAuthentication(env: NodeJS.ProcessEnv = process.env): boolean {
  const auth = readCodexAuthFile();
  return Boolean(auth?.oauth || auth?.hasApiKey || env.OPENAI_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Resolver — maps CLI provider to API config
// ---------------------------------------------------------------------------

const CLI_OAUTH_MAP: Record<string, {
  reader: () => CliCredentials | null;
  apiMode: 'anthropic' | 'openai-compat';
  baseUrl: string;
  credentialFile: string;
}> = {
  'claude-cli': {
    reader: readClaudeCliCredentials,
    apiMode: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    credentialFile: '~/.claude/.credentials.json',
  },
  'codex-cli': {
    reader: readCodexCliCredentials,
    apiMode: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    credentialFile: '~/.codex/auth.json',
  },
};

/** Buffer before actual expiry to avoid race conditions (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Attempt to resolve OAuth credentials for a CLI provider.
 * Returns API config if credentials are found and not expired, null otherwise.
 */
export function resolveCliOAuthKey(provider: string): ResolvedCliOAuth | null {
  const mapping = CLI_OAUTH_MAP[provider];
  if (!mapping) return null;

  const creds = mapping.reader();
  if (!creds) {
    logger.warn(`No OAuth credentials found for ${provider}; falling back to CLI subprocess`);
    return null;
  }

  // Check token expiration — fall back to CLI subprocess if expired or about to expire
  if (creds.expiresAt) {
    const expiresAtMs = creds.expiresAt * (creds.expiresAt < 1e12 ? 1000 : 1);
    if (Date.now() >= expiresAtMs - EXPIRY_BUFFER_MS) {
      logger.warn({ provider, expiresAt: new Date(expiresAtMs).toISOString() },
        'OAuth token expired or expiring soon; falling back to CLI subprocess');
      // Invalidate the credential cache so next call re-reads from disk
      // (the CLI may have refreshed the token in the meantime)
      clearCredentialCache();
      return null;
    }
  }

  logger.debug(`CLI provider using direct API (OAuth credentials from ${mapping.credentialFile})`);
  return {
    accessToken: creds.accessToken,
    apiMode: mapping.apiMode,
    baseUrl: mapping.baseUrl,
  };
}
