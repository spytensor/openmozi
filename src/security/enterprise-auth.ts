/**
 * Enterprise Auth — OIDC/JWKS + SAML basic validation + API key fallback.
 *
 * Supports:
 * - OIDC discovery + JWKS verification (RS256)
 * - Claim mapping into TenantContext
 * - Minimal SAML assertion signature validation
 * - API key fallback for non-enterprise deployments
 */

import {
  createHash,
  createPublicKey,
  createVerify,
  randomUUID,
  randomBytes,
  type webcrypto,
} from 'node:crypto';
import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { type TenantContext, payloadToContext } from '../tenants/index.js';
import { verify as verifyJwt, type JwtPayload } from './jwt.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:security:enterprise-auth' });
type JsonWebKey = webcrypto.JsonWebKey & {
  kid?: string;
  kty?: string;
};

// ---------------------------------------------------------------------------
// OIDC interfaces + implementation
// ---------------------------------------------------------------------------

/** OIDC provider configuration (from discovery endpoint) */
export interface OidcProviderConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  scopes_supported: string[];
}

/** OIDC authentication result */
export interface OidcAuthResult {
  tenant_context: TenantContext;
  id_token: string;
  access_token: string;
  expires_at: number;
}

export interface OidcClaimMapping {
  tenant_claim?: string;
  user_claim?: string;
  roles_claim?: string;
  fallback_tenant_id?: string;
}

export interface OidcTenantConfig extends OidcClaimMapping {
  tenant_id: string;
  issuer: string;
  jwks_uri?: string;
  audience?: string;
}

export interface OidcValidationExpect {
  issuer?: string;
  audience?: string;
}

interface OidcValidationOptions extends OidcValidationExpect {
  nowMs?: number;
}

interface OidcProviderRuntimeOptions {
  fetchFn?: typeof fetch;
  nowMs?: number;
}

interface CachedEntry<T> {
  value: T;
  expiresAt: number;
}

interface JwksDocument {
  keys: JsonWebKey[];
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 5 * 60 * 1000;
const discoveryCache = new Map<string, CachedEntry<OidcProviderConfig>>();
const jwksCache = new Map<string, CachedEntry<JwksDocument>>();

/**
 * OIDC provider interface.
 */
export interface OidcProvider {
  /** Discover OIDC configuration from the provider's well-known endpoint */
  discover(issuerUrl: string): Promise<OidcProviderConfig>;
  /** Validate a JWT token against the provider's JWKS */
  validateToken(token: string, jwksUri: string, expect?: OidcValidationExpect): Promise<JwtPayload | null>;
  /** Extract TenantContext from validated OIDC claims */
  extractContext(claims: JwtPayload, mapping?: OidcClaimMapping): TenantContext;
}

/**
 * Built-in OIDC provider implementation using discovery + JWKS + RS256 verification.
 */
export function createOidcProvider(runtimeOptions: OidcProviderRuntimeOptions = {}): OidcProvider {
  const nowMs = () => runtimeOptions.nowMs ?? Date.now();
  const fetchFn = runtimeOptions.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new Error('OIDC requires global fetch (Node.js 18+) or a custom fetchFn');
  }

  async function discover(issuerUrl: string): Promise<OidcProviderConfig> {
    const normalizedIssuer = normalizeIssuer(issuerUrl);
    const cached = discoveryCache.get(normalizedIssuer);
    if (cached && cached.expiresAt > nowMs()) {
      return cached.value;
    }

    const response = await fetchFn(`${normalizedIssuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed (${response.status}) for issuer ${normalizedIssuer}`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const config = normalizeDiscoveryPayload(payload, normalizedIssuer);
    discoveryCache.set(normalizedIssuer, { value: config, expiresAt: nowMs() + DISCOVERY_TTL_MS });
    return config;
  }

  async function validateToken(
    token: string,
    jwksUri: string,
    expect?: OidcValidationExpect,
  ): Promise<JwtPayload | null> {
    const decoded = decodeJwt(token);
    if (!decoded) return null;
    if (decoded.header.alg !== 'RS256') {
      logger.warn({ alg: decoded.header.alg }, 'Unsupported OIDC JWT alg');
      return null;
    }

    const jwks = await loadJwks(jwksUri, fetchFn, nowMs);
    const key = selectJwk(jwks, decoded.header.kid);
    if (!key) {
      logger.warn({ kid: decoded.header.kid, jwksUri }, 'OIDC JWT kid not found in JWKS');
      return null;
    }

    if (!verifyRs256(decoded.signingInput, decoded.signature, key)) {
      logger.warn({ kid: decoded.header.kid }, 'OIDC JWT signature verification failed');
      return null;
    }

    const claims = decoded.payload;
    if (!validateRegisteredClaims(claims, { ...expect, nowMs: nowMs() })) {
      return null;
    }
    return claims;
  }

  function extractContext(claims: JwtPayload, mapping?: OidcClaimMapping): TenantContext {
    return extractOidcContext(claims, mapping);
  }

  return {
    discover,
    validateToken,
    extractContext,
  };
}

/**
 * Backward-compatible alias (previously a stub).
 */
export function createOidcStub(): OidcProvider {
  return createOidcProvider();
}

// ---------------------------------------------------------------------------
// SAML interface + minimal implementation
// ---------------------------------------------------------------------------

/** SAML service provider configuration */
export interface SamlSpConfig {
  entity_id: string;
  acs_url: string;
  slo_url: string;
  certificate: string;
}

/** SAML identity provider configuration */
export interface SamlIdpConfig {
  entity_id: string;
  sso_url: string;
  slo_url: string;
  certificate: string;
}

/** SAML authentication result */
export interface SamlAuthResult {
  tenant_context: TenantContext;
  name_id: string;
  session_index: string;
  attributes: Record<string, string>;
}

export interface SamlTenantConfig {
  tenant_id: string;
  entity_id: string;
  certificate: string;
  audience?: string;
  tenant_attribute?: string;
  user_attribute?: string;
  roles_attribute?: string;
}

/**
 * SAML provider interface.
 */
export interface SamlProvider {
  configure(sp: SamlSpConfig, idp: SamlIdpConfig): void;
  validateAssertion(samlResponse: string): Promise<SamlAuthResult>;
  generateAuthnRequest(): string;
}

export interface EnterpriseAuthConfig {
  oidc?: {
    issuers?: OidcTenantConfig[];
  };
  saml?: {
    idps?: SamlTenantConfig[];
  };
}

export interface EnterpriseAuthRuntimeOptions {
  fetchFn?: typeof fetch;
  nowMs?: number;
}

/**
 * Minimal SAML provider:
 * - validates issuer/audience/time window
 * - verifies SignatureValue over assertion text with configured certificate/public key
 * - maps attributes to TenantContext
 *
 * Note: this is intentionally minimal and supports a constrained assertion shape.
 */
export function createSamlBasicProvider(bindings: SamlTenantConfig[] = []): SamlProvider {
  let activeBindings = [...bindings];
  let activeSp: SamlSpConfig | null = null;
  let activeIdp: SamlIdpConfig | null = null;

  return {
    configure(sp: SamlSpConfig, idp: SamlIdpConfig): void {
      activeSp = sp;
      activeIdp = idp;
      activeBindings = [{
        tenant_id: 'default',
        entity_id: idp.entity_id,
        certificate: idp.certificate,
        audience: sp.entity_id,
      }];
    },

    async validateAssertion(samlResponse: string): Promise<SamlAuthResult> {
      const result = await validateSamlAssertion(
        samlResponse,
        activeBindings,
        Date.now(),
      );
      if (!result) {
        throw new Error('SAML assertion validation failed');
      }
      return result;
    },

    generateAuthnRequest(): string {
      const requestId = `_${randomUUID().replace(/-/g, '')}`;
      const issueInstant = new Date().toISOString();
      const acsUrl = activeSp?.acs_url ?? '';
      const issuer = activeSp?.entity_id ?? 'mozi';
      const destination = activeIdp?.sso_url ?? '';

      return [
        `<samlp:AuthnRequest ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}"`,
        ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
        ` AssertionConsumerServiceURL="${acsUrl}" Destination="${destination}">`,
        `<saml:Issuer>${issuer}</saml:Issuer>`,
        `</samlp:AuthnRequest>`,
      ].join('');
    },
  };
}

// ---------------------------------------------------------------------------
// API Key auth (MVP fallback)
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  key_hash: string;
  name: string;
  user_id: string;
  roles: string[];
  status: 'active' | 'revoked';
  last_used_at: string | null;
  created_at: string;
}

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '["viewer"]',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  tableEnsured = true;
}

/** Reset table flag (for testing) */
export function resetTableFlag(): void {
  tableEnsured = false;
}

/**
 * Generate a new API key for a tenant.
 * Returns the raw key (only shown once) and the stored record.
 */
export function generateApiKey(
  tenantId: string,
  userId: string,
  name: string,
  roles: string[] = ['viewer'],
): { rawKey: string; record: ApiKeyRecord } {
  ensureTable();
  const db = getDb();
  const id = randomUUID();
  const rawKey = `mozi_${randomBytes(32).toString('hex')}`;
  const keyHash = hashKey(rawKey);

  db.prepare(`
    INSERT INTO api_keys (id, tenant_id, key_hash, name, user_id, roles, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
  `).run(id, tenantId, keyHash, name, userId, JSON.stringify(roles));

  logEvent('api_key_created', 'security', id, { tenant_id: tenantId, name, user_id: userId }, tenantId);
  logger.info({ tenant_id: tenantId, key_id: id, name }, 'API key generated');

  const record = getApiKey(id)!;
  return { rawKey, record };
}

/**
 * Authenticate using an API key.
 * Returns TenantContext or null if the key is invalid/revoked.
 */
export function authenticateApiKey(rawKey: string): TenantContext | null {
  ensureTable();
  const db = getDb();
  const keyHash = hashKey(rawKey);

  const row = db.prepare(`
    SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'
  `).get(keyHash) as Record<string, unknown> | undefined;

  if (!row) return null;

  // Update last_used_at
  db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(row.id as string);

  const roles = parseRoles(row.roles as string);
  return {
    tenant_id: row.tenant_id as string,
    user_id: row.user_id as string,
    roles,
  };
}

/**
 * Revoke an API key.
 */
export function revokeApiKey(keyId: string, tenantId = 'default'): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare(
    'UPDATE api_keys SET status = \'revoked\' WHERE id = ? AND tenant_id = ?',
  ).run(keyId, tenantId);

  if (result.changes > 0) {
    logEvent('api_key_revoked', 'security', keyId, { tenant_id: tenantId }, tenantId);
    logger.info({ key_id: keyId, tenant_id: tenantId }, 'API key revoked');
    return true;
  }
  return false;
}

/**
 * Get an API key record by ID.
 */
export function getApiKey(keyId: string): ApiKeyRecord | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return deserializeApiKey(row);
}

/**
 * List API keys for a tenant.
 */
export function listApiKeys(tenantId = 'default'): ApiKeyRecord[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
  ).all(tenantId) as Record<string, unknown>[];
  return rows.map(deserializeApiKey);
}

// ---------------------------------------------------------------------------
// Unified auth: local JWT -> enterprise OIDC/SAML -> API key
// ---------------------------------------------------------------------------

/**
 * Authenticate a request using local JWT, enterprise OIDC/SAML, or API key.
 *
 * @param authValue - Bearer token or API key string
 * @param jwtSecret - Secret for JWT verification
 * @param enterpriseConfig - Optional enterprise auth config (OIDC/SAML)
 * @param runtimeOptions - Optional fetch/time overrides (for tests)
 * @returns TenantContext or null
 */
export async function authenticate(
  authValue: string,
  jwtSecret: string,
  enterpriseConfig?: EnterpriseAuthConfig,
  runtimeOptions: EnterpriseAuthRuntimeOptions = {},
): Promise<TenantContext | null> {
  const credential = authValue.trim();
  if (!credential) return null;

  // 1) API key shortcut
  if (credential.startsWith('mozi_')) {
    return authenticateApiKey(credential);
  }

  // 2) Local HS256 JWT
  const localJwtPayload = verifyJwt(credential, jwtSecret);
  if (localJwtPayload) {
    return payloadToContext(localJwtPayload);
  }

  // 3) OIDC JWT validation against configured issuers
  const oidcIssuers = enterpriseConfig?.oidc?.issuers ?? [];
  if (oidcIssuers.length > 0 && looksLikeJwt(credential)) {
    const oidcProvider = createOidcProvider({
      fetchFn: runtimeOptions.fetchFn,
      nowMs: runtimeOptions.nowMs,
    });
    for (const issuerConfig of oidcIssuers) {
      try {
        const discovery = issuerConfig.jwks_uri
          ? null
          : await oidcProvider.discover(issuerConfig.issuer);
        const jwksUri = issuerConfig.jwks_uri ?? discovery?.jwks_uri;
        if (!jwksUri) continue;

        const claims = await oidcProvider.validateToken(
          credential,
          jwksUri,
          {
            issuer: normalizeIssuer(issuerConfig.issuer),
            audience: issuerConfig.audience,
          },
        );
        if (!claims) continue;

        return oidcProvider.extractContext(claims, {
          tenant_claim: issuerConfig.tenant_claim,
          user_claim: issuerConfig.user_claim,
          roles_claim: issuerConfig.roles_claim,
          fallback_tenant_id: issuerConfig.tenant_id,
        });
      } catch (err) {
        logger.warn({
          issuer: issuerConfig.issuer,
          err: err instanceof Error ? err.message : String(err),
        }, 'OIDC issuer validation failed');
      }
    }
  }

  // 4) Minimal SAML assertion path
  const samlBindings = enterpriseConfig?.saml?.idps ?? [];
  if (samlBindings.length > 0 && credential.startsWith('saml:')) {
    const encoded = credential.slice('saml:'.length).trim();
    const samlResult = await validateSamlAssertion(
      encoded,
      samlBindings,
      runtimeOptions.nowMs ?? Date.now(),
    );
    if (samlResult) {
      return samlResult.tenant_context;
    }
  }

  // 5) Final fallback: treat unknown credential as API key format
  return authenticateApiKey(credential);
}

export function resetEnterpriseAuthCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DecodedJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
  [key: string]: unknown;
}

interface DecodedJwt {
  header: DecodedJwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Buffer;
}

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

function normalizeDiscoveryPayload(payload: Record<string, unknown>, fallbackIssuer: string): OidcProviderConfig {
  const issuer = typeof payload.issuer === 'string' && payload.issuer.length > 0
    ? normalizeIssuer(payload.issuer)
    : fallbackIssuer;
  const jwksUri = typeof payload.jwks_uri === 'string' && payload.jwks_uri.length > 0
    ? payload.jwks_uri
    : '';
  if (!jwksUri) {
    throw new Error(`OIDC discovery payload missing jwks_uri for issuer ${issuer}`);
  }

  return {
    issuer,
    authorization_endpoint: asOptionalString(payload.authorization_endpoint),
    token_endpoint: asOptionalString(payload.token_endpoint),
    userinfo_endpoint: asOptionalString(payload.userinfo_endpoint),
    jwks_uri: jwksUri,
    scopes_supported: Array.isArray(payload.scopes_supported)
      ? payload.scopes_supported.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function asOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function base64urlToBuffer(value: string): Buffer {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const header = JSON.parse(base64urlToBuffer(headerPart).toString('utf-8')) as DecodedJwtHeader;
    const payload = JSON.parse(base64urlToBuffer(payloadPart).toString('utf-8')) as JwtPayload;
    return {
      header,
      payload,
      signingInput: `${headerPart}.${payloadPart}`,
      signature: base64urlToBuffer(signaturePart),
    };
  } catch {
    return null;
  }
}

async function loadJwks(
  jwksUri: string,
  fetchFn: typeof fetch,
  nowMs: () => number,
): Promise<JwksDocument> {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > nowMs()) {
    return cached.value;
  }

  const response = await fetchFn(jwksUri);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed (${response.status}) for ${jwksUri}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const keys = Array.isArray(payload.keys)
    ? payload.keys.filter((key): key is JsonWebKey => Boolean(key) && typeof key === 'object')
    : [];
  if (keys.length === 0) {
    throw new Error(`JWKS contains no keys: ${jwksUri}`);
  }

  const document: JwksDocument = { keys };
  jwksCache.set(jwksUri, { value: document, expiresAt: nowMs() + JWKS_TTL_MS });
  return document;
}

function selectJwk(jwks: JwksDocument, kid?: string): JsonWebKey | null {
  if (kid) {
    const byKid = jwks.keys.find(key => key.kid === kid && key.kty === 'RSA');
    if (byKid) return byKid;
  }
  return jwks.keys.find(key => key.kty === 'RSA') ?? null;
}

function verifyRs256(signingInput: string, signature: Buffer, jwk: JsonWebKey): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

function validateRegisteredClaims(claims: JwtPayload, options: OidcValidationOptions): boolean {
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp === 'number' && claims.exp <= nowSec) {
    logger.warn({ exp: claims.exp }, 'OIDC token expired');
    return false;
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec) {
    logger.warn({ nbf: claims.nbf }, 'OIDC token not yet valid');
    return false;
  }

  if (options.issuer) {
    const tokenIssuer = typeof claims.iss === 'string' ? normalizeIssuer(claims.iss) : '';
    if (tokenIssuer !== normalizeIssuer(options.issuer)) {
      logger.warn({ tokenIssuer, expectedIssuer: options.issuer }, 'OIDC issuer mismatch');
      return false;
    }
  }

  if (options.audience) {
    const aud = claims.aud;
    const audienceMatched = Array.isArray(aud)
      ? aud.some(value => value === options.audience)
      : aud === options.audience;
    if (!audienceMatched) {
      logger.warn({ aud, expectedAudience: options.audience }, 'OIDC audience mismatch');
      return false;
    }
  }

  return true;
}

function parseRolesClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    const roles = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return roles.length > 0 ? roles : ['viewer'];
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const roles = value
      .split(/[,\s]+/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
    return roles.length > 0 ? roles : ['viewer'];
  }
  return ['viewer'];
}

function extractOidcContext(claims: JwtPayload, mapping?: OidcClaimMapping): TenantContext {
  const tenantClaim = mapping?.tenant_claim ?? 'tenant_id';
  const userClaim = mapping?.user_claim ?? 'sub';
  const rolesClaim = mapping?.roles_claim ?? 'roles';

  const tenantFromClaim = claims[tenantClaim];
  const userFromClaim = claims[userClaim];
  const rolesFromClaim = claims[rolesClaim];

  const tenantId = typeof tenantFromClaim === 'string' && tenantFromClaim.trim().length > 0
    ? tenantFromClaim
    : mapping?.fallback_tenant_id ?? 'default';
  const userId = typeof userFromClaim === 'string' && userFromClaim.trim().length > 0
    ? userFromClaim
    : claims.sub ?? 'unknown';

  return {
    tenant_id: tenantId,
    user_id: userId,
    roles: parseRolesClaim(rolesFromClaim),
  };
}

async function validateSamlAssertion(
  samlResponse: string,
  bindings: SamlTenantConfig[],
  nowMs: number,
): Promise<SamlAuthResult | null> {
  if (bindings.length === 0) return null;
  const xml = decodeSamlResponse(samlResponse);
  if (!xml) return null;

  const issuer = extractXmlTagValue(xml, 'Issuer');
  if (!issuer) {
    logger.warn('SAML assertion missing Issuer');
    return null;
  }

  const binding = bindings.find(entry => entry.entity_id === issuer);
  if (!binding) {
    logger.warn({ issuer }, 'SAML issuer not configured');
    return null;
  }

  if (!validateSamlTimeWindow(xml, nowMs)) {
    return null;
  }

  if (binding.audience) {
    const audience = extractXmlTagValue(xml, 'Audience');
    if (audience !== binding.audience) {
      logger.warn({ audience, expectedAudience: binding.audience }, 'SAML audience mismatch');
      return null;
    }
  }

  const signatureValue = extractXmlTagValue(xml, 'SignatureValue');
  if (!signatureValue) {
    logger.warn('SAML assertion missing SignatureValue');
    return null;
  }

  const signedPayload = removeXmlSignatureBlock(xml);
  if (!verifySamlSignature(signedPayload, signatureValue, binding.certificate)) {
    logger.warn({ issuer }, 'SAML signature verification failed');
    return null;
  }

  const attributes = extractSamlAttributes(xml);
  const nameId = extractXmlTagValue(xml, 'NameID') ?? '';
  const sessionIndex = extractXmlAttribute(xml, 'AuthnStatement', 'SessionIndex') ?? '';

  const tenantAttribute = binding.tenant_attribute ?? 'tenant_id';
  const userAttribute = binding.user_attribute ?? 'user_id';
  const rolesAttribute = binding.roles_attribute ?? 'roles';

  const tenantId = attributes[tenantAttribute] ?? binding.tenant_id;
  const userId = attributes[userAttribute] ?? nameId;
  const roles = parseRolesClaim(attributes[rolesAttribute]);
  if (!tenantId || !userId) {
    logger.warn({ issuer }, 'SAML context mapping missing tenant/user');
    return null;
  }

  return {
    tenant_context: {
      tenant_id: tenantId,
      user_id: userId,
      roles,
    },
    name_id: nameId,
    session_index: sessionIndex,
    attributes,
  };
}

function decodeSamlResponse(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('<')) return trimmed;
  try {
    return Buffer.from(trimmed, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function extractXmlTagValue(xml: string, tag: string): string | null {
  const regex = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return null;
  return match[1].trim();
}

function extractXmlAttribute(xml: string, tag: string, attribute: string): string | null {
  const regex = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)>`, 'i');
  const match = xml.match(regex);
  if (!match) return null;
  const attrRegex = new RegExp(`\\b${attribute}=\"([^\"]+)\"`, 'i');
  const attrMatch = match[1].match(attrRegex);
  return attrMatch ? attrMatch[1] : null;
}

function validateSamlTimeWindow(xml: string, nowMs: number): boolean {
  const conditionsRegex = /<(?:\w+:)?Conditions\b([^>]*)>/i;
  const conditionsMatch = xml.match(conditionsRegex);
  if (!conditionsMatch) return true;

  const attrs = conditionsMatch[1];
  const notBefore = attrs.match(/\bNotBefore=\"([^\"]+)\"/i)?.[1];
  const notOnOrAfter = attrs.match(/\bNotOnOrAfter=\"([^\"]+)\"/i)?.[1];

  if (notBefore) {
    const notBeforeMs = Date.parse(notBefore);
    if (Number.isFinite(notBeforeMs) && nowMs < notBeforeMs) {
      logger.warn({ notBefore }, 'SAML assertion not yet valid');
      return false;
    }
  }
  if (notOnOrAfter) {
    const notOnOrAfterMs = Date.parse(notOnOrAfter);
    if (Number.isFinite(notOnOrAfterMs) && nowMs >= notOnOrAfterMs) {
      logger.warn({ notOnOrAfter }, 'SAML assertion expired');
      return false;
    }
  }
  return true;
}

function removeXmlSignatureBlock(xml: string): string {
  return xml
    .replace(/<(?:\w+:)?Signature\b[\s\S]*?<\/(?:\w+:)?Signature>/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifySamlSignature(payload: string, signatureValue: string, certificate: string): boolean {
  try {
    const signature = Buffer.from(signatureValue, 'base64');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(payload);
    verifier.end();
    return verifier.verify(certificate, signature);
  } catch {
    return false;
  }
}

function extractSamlAttributes(xml: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /<(?:\w+:)?Attribute\b[^>]*Name=\"([^\"]+)\"[^>]*>\s*<(?:\w+:)?AttributeValue[^>]*>([\s\S]*?)<\/(?:\w+:)?AttributeValue>\s*<\/(?:\w+:)?Attribute>/gi;

  let match = regex.exec(xml);
  while (match) {
    attributes[match[1]] = match[2].trim();
    match = regex.exec(xml);
  }
  return attributes;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function parseRoles(rolesStr: string): string[] {
  try {
    return JSON.parse(rolesStr);
  } catch {
    return ['viewer'];
  }
}

function deserializeApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    key_hash: row.key_hash as string,
    name: (row.name as string) ?? '',
    user_id: row.user_id as string,
    roles: parseRoles(row.roles as string),
    status: row.status as 'active' | 'revoked',
    last_used_at: row.last_used_at as string | null,
    created_at: row.created_at as string,
  };
}
