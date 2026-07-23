/**
 * OAuth2 / OIDC Provider Integration (#230)
 *
 * Supports Google, GitHub, Azure AD, Okta, and custom OIDC providers.
 * Uses standard OIDC discovery (/.well-known/openid-configuration) where possible.
 * Implements the authorization code flow with PKCE-style state/CSRF protection.
 *
 * No external OAuth library — uses fetch + Node.js crypto.
 */

import { randomBytes, createHash } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';
import type { OAuthProviderConfig } from '../config/index.js';

const logger = pino({ name: 'mozi:security:oauth' });

// ---------------------------------------------------------------------------
// Provider endpoint definitions
// ---------------------------------------------------------------------------

interface ProviderEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

/** Well-known fixed endpoints for OAuth2-only providers (e.g. GitHub). */
const STATIC_ENDPOINTS: Partial<Record<string, ProviderEndpoints>> = {
  github: {
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    userinfo_endpoint: 'https://api.github.com/user',
  },
};

/** OIDC discovery URLs for known providers. */
function getDiscoveryUrl(cfg: OAuthProviderConfig): string | null {
  if (cfg.discovery_url) return cfg.discovery_url;
  switch (cfg.provider) {
    case 'google':
      return 'https://accounts.google.com/.well-known/openid-configuration';
    case 'azure_ad': {
      const tenant = cfg.azure_tenant ?? 'common';
      return `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
    }
    case 'okta': {
      if (!cfg.okta_domain) return null;
      return `https://${cfg.okta_domain}/.well-known/openid-configuration`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// OIDC discovery cache (in-memory, TTL 10 min)
// ---------------------------------------------------------------------------

interface CachedDiscovery {
  endpoints: ProviderEndpoints;
  expiresAt: number;
}

const discoveryCache = new Map<string, CachedDiscovery>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function discoverEndpoints(cfg: OAuthProviderConfig): Promise<ProviderEndpoints> {
  // Static (non-OIDC) providers
  const static_ = STATIC_ENDPOINTS[cfg.provider];
  if (static_) return static_;

  const discoveryUrl = getDiscoveryUrl(cfg);
  if (!discoveryUrl) {
    throw new Error(`Cannot determine discovery URL for provider '${cfg.provider}'. Set discovery_url in config.`);
  }

  const cached = discoveryCache.get(discoveryUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints;

  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed (${res.status}) for ${discoveryUrl}`);
  }
  const doc = await res.json() as Record<string, unknown>;
  const endpoints: ProviderEndpoints = {
    authorization_endpoint: doc.authorization_endpoint as string,
    token_endpoint: doc.token_endpoint as string,
    userinfo_endpoint: doc.userinfo_endpoint as string | undefined,
  };
  discoveryCache.set(discoveryUrl, { endpoints, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return endpoints;
}

// ---------------------------------------------------------------------------
// State management (CSRF protection, stored in SQLite)
// ---------------------------------------------------------------------------

let stateTableReady = false;

function ensureStateTable(): void {
  if (stateTableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      provider TEXT NOT NULL,
      redirect_uri TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);
  stateTableReady = true;
}

export function resetOAuthStateTableFlag(): void {
  stateTableReady = false;
}

function createState(provider: string, tenantId: string, redirectUri?: string): string {
  ensureStateTable();
  const db = getDb();
  const state = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  db.prepare(`
    INSERT INTO oauth_states (state, tenant_id, provider, redirect_uri, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(state, tenantId, provider, redirectUri ?? null, expiresAt);

  // Purge expired states
  db.prepare("DELETE FROM oauth_states WHERE expires_at < datetime('now')").run();
  return state;
}

function consumeState(state: string): { provider: string; tenantId: string; redirectUri: string | null } | null {
  ensureStateTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM oauth_states WHERE state = ? AND expires_at > datetime('now')
  `).get(state) as Record<string, unknown> | undefined;

  if (!row) return null;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  return {
    provider: row.provider as string,
    tenantId: row.tenant_id as string,
    redirectUri: (row.redirect_uri as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCode(
  code: string,
  cfg: OAuthProviderConfig,
  redirectUri: string,
  tokenEndpoint: string,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
  });

  // GitHub requires Accept: application/json
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

export interface OAuthUserInfo {
  provider: string;
  provider_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  raw: Record<string, unknown>;
}

async function fetchUserInfo(accessToken: string, userinfoEndpoint: string): Promise<Record<string, unknown>> {
  const res = await fetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Userinfo fetch failed (${res.status})`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeUserInfo(provider: string, raw: Record<string, unknown>): OAuthUserInfo {
  // Each provider has slightly different field names
  let id: string;
  let email: string;
  let name: string | null = null;
  let avatar: string | null = null;

  switch (provider) {
    case 'github':
      id = String(raw.id ?? raw.login ?? '');
      email = (raw.email as string | null) ?? `${raw.login}@github.noreply`;
      name = (raw.name as string | null) ?? (raw.login as string | null) ?? null;
      avatar = (raw.avatar_url as string | null) ?? null;
      break;
    case 'google':
      id = (raw.sub as string) ?? String(raw.id ?? '');
      email = (raw.email as string) ?? '';
      name = (raw.name as string | null) ?? null;
      avatar = (raw.picture as string | null) ?? null;
      break;
    case 'azure_ad':
      id = (raw.sub as string) ?? (raw.oid as string) ?? '';
      email = (raw.email as string) ?? (raw.preferred_username as string) ?? '';
      name = (raw.name as string | null) ?? null;
      avatar = null;
      break;
    case 'okta':
      id = (raw.sub as string) ?? '';
      email = (raw.email as string) ?? '';
      name = (raw.name as string | null) ?? null;
      avatar = null;
      break;
    default:
      // Generic OIDC
      id = (raw.sub as string) ?? String(raw.id ?? '');
      email = (raw.email as string) ?? '';
      name = (raw.name as string | null) ?? null;
      avatar = (raw.picture as string | null) ?? null;
  }

  if (!id) throw new Error(`Cannot determine provider_id from ${provider} user info`);
  if (!email) throw new Error(`Cannot determine email from ${provider} user info`);

  return { provider, provider_id: id, email, name, avatar_url: avatar, raw };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OAuthInitResult {
  /** Authorization URL to redirect the user to */
  authorizationUrl: string;
  /** Opaque state token (stored server-side, sent in redirect) */
  state: string;
}

/**
 * Build the authorization URL for the given provider.
 * Stores a short-lived state token in SQLite for CSRF validation.
 *
 * @param providerName - Provider key (google, github, azure_ad, okta, custom)
 * @param providers    - Array of configured providers from config
 * @param baseUrl      - Server base URL for building the redirect_uri
 * @param tenantId     - Tenant scope for JIT user provisioning
 */
export async function initiateOAuthFlow(
  providerName: string,
  providers: OAuthProviderConfig[],
  baseUrl: string,
  tenantId = 'default',
): Promise<OAuthInitResult> {
  const cfg = providers.find(p => p.provider === providerName);
  if (!cfg) {
    throw new Error(`OAuth provider '${providerName}' is not configured`);
  }

  const endpoints = await discoverEndpoints(cfg);
  const redirectUri = cfg.redirect_uri ?? `${baseUrl}/api/auth/oauth/callback`;
  const state = createState(cfg.provider, tenantId, redirectUri);

  const scopes = cfg.scopes.join(' ');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });

  const authorizationUrl = `${endpoints.authorization_endpoint}?${params.toString()}`;
  logger.info({ provider: providerName, tenantId }, 'OAuth flow initiated');
  return { authorizationUrl, state };
}

export interface OAuthCallbackResult {
  userInfo: OAuthUserInfo;
  tenantId: string;
}

/**
 * Handle the OAuth callback: validate state, exchange code, fetch user info.
 *
 * @param code     - Authorization code from provider
 * @param state    - State param from provider redirect (must match stored state)
 * @param providers - Configured providers
 * @param baseUrl  - Server base URL (to reconstruct redirect_uri)
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
  providers: OAuthProviderConfig[],
  baseUrl: string,
): Promise<OAuthCallbackResult> {
  // Validate state and consume it (one-time use)
  const stateData = consumeState(state);
  if (!stateData) {
    throw new Error('Invalid or expired OAuth state parameter');
  }

  const { provider: providerName, tenantId } = stateData;
  const cfg = providers.find(p => p.provider === providerName);
  if (!cfg) {
    throw new Error(`OAuth provider '${providerName}' is not configured`);
  }

  const endpoints = await discoverEndpoints(cfg);
  const redirectUri = stateData.redirectUri ?? cfg.redirect_uri ?? `${baseUrl}/api/auth/oauth/callback`;

  // Exchange authorization code for tokens
  const tokenResponse = await exchangeCode(code, cfg, redirectUri, endpoints.token_endpoint);
  logger.info({ provider: providerName }, 'OAuth token exchange successful');

  // Get user profile — prefer id_token claims, fall back to userinfo endpoint
  let raw: Record<string, unknown>;
  if (tokenResponse.id_token) {
    const claims = decodeJwtPayload(tokenResponse.id_token);
    if (claims) {
      raw = claims;
    } else if (endpoints.userinfo_endpoint) {
      raw = await fetchUserInfo(tokenResponse.access_token, endpoints.userinfo_endpoint);
    } else {
      throw new Error('Cannot extract user info: no id_token claims and no userinfo_endpoint');
    }
  } else if (endpoints.userinfo_endpoint) {
    raw = await fetchUserInfo(tokenResponse.access_token, endpoints.userinfo_endpoint);
  } else {
    throw new Error(`Provider '${providerName}' returned no id_token and has no userinfo_endpoint`);
  }

  const userInfo = normalizeUserInfo(providerName, raw);
  logger.info({ provider: providerName, email: userInfo.email }, 'OAuth user info resolved');

  return { userInfo, tenantId };
}

/**
 * Hash a value for stable cache keying (not security-sensitive).
 */
export function hashForCache(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Clear cached OIDC discovery documents (e.g. for testing). */
export function clearOAuthDiscoveryCache(): void {
  discoveryCache.clear();
}
