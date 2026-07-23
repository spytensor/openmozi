import { createSign, generateKeyPairSync } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { sign } from './jwt.js';
import {
  authenticate,
  authenticateApiKey,
  createOidcProvider,
  createOidcStub,
  generateApiKey,
  getApiKey,
  listApiKeys,
  resetEnterpriseAuthCaches,
  resetTableFlag,
  revokeApiKey,
  type EnterpriseAuthConfig,
} from './enterprise-auth.js';

let tmpDir: string;
const SECRET = 'test-secret-for-enterprise-auth';

function toBase64Url(value: Buffer | string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf-8');
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKeyPem: string,
  kid = 'test-kid',
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${toBase64Url(signature)}`;
}

function buildOidcFetchMock(issuer: string, jwksUri: string, jwks: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: jwksUri,
        scopes_supported: ['openid', 'profile', 'email'],
      }), { status: 200 });
    }
    if (url === jwksUri) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function buildSignedSamlAssertion(
  privateKeyPem: string,
  overrides?: {
    issuer?: string;
    audience?: string;
    notBefore?: string;
    notOnOrAfter?: string;
    tenantId?: string;
    userId?: string;
    roles?: string;
  },
): string {
  const issuer = overrides?.issuer ?? 'urn:test:idp';
  const audience = overrides?.audience ?? 'urn:mozi:sp';
  const notBefore = overrides?.notBefore ?? new Date(Date.now() - 60_000).toISOString();
  const notOnOrAfter = overrides?.notOnOrAfter ?? new Date(Date.now() + 60_000).toISOString();
  const tenantId = overrides?.tenantId ?? 'tenant-saml';
  const userId = overrides?.userId ?? 'user-saml';
  const roles = overrides?.roles ?? 'admin,operator';

  const assertionWithoutSignature = [
    '<saml:Assertion ID="assertion-1" Version="2.0">',
    `<saml:Issuer>${issuer}</saml:Issuer>`,
    '<saml:Subject><saml:NameID>nameid-user</saml:NameID></saml:Subject>',
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">`,
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`,
    '</saml:Conditions>',
    '<saml:AuthnStatement SessionIndex="session-1"></saml:AuthnStatement>',
    '<saml:AttributeStatement>',
    `<saml:Attribute Name="tenant_id"><saml:AttributeValue>${tenantId}</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="user_id"><saml:AttributeValue>${userId}</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="roles"><saml:AttributeValue>${roles}</saml:AttributeValue></saml:Attribute>`,
    '</saml:AttributeStatement>',
    '</saml:Assertion>',
  ].join('');
  const normalizedPayload = assertionWithoutSignature.replace(/\s+/g, ' ').trim();

  const signer = createSign('RSA-SHA256');
  signer.update(normalizedPayload);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64');

  const withSignature = assertionWithoutSignature.replace(
    '</saml:Issuer>',
    `</saml:Issuer><ds:Signature><ds:SignatureValue>${signature}</ds:SignatureValue></ds:Signature>`,
  );

  return Buffer.from(withSignature, 'utf-8').toString('base64');
}

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  resetTableFlag();
  resetEnterpriseAuthCaches();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  resetTableFlag();
  resetEnterpriseAuthCaches();
});

describe('security/enterprise-auth', () => {
  describe('OIDC provider', () => {
    it('discovers provider metadata and validates RS256 token via JWKS', async () => {
      const issuer = 'https://idp.example.com';
      const jwksUri = `${issuer}/jwks`;
      const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
      const jwks = { keys: [{ ...publicJwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] };
      const fetchMock = buildOidcFetchMock(issuer, jwksUri, jwks);

      const provider = createOidcProvider({ fetchFn: fetchMock });
      const discovery = await provider.discover(issuer);
      expect(discovery.jwks_uri).toBe(jwksUri);

      const token = signRs256Jwt({
        sub: 'oidc-user',
        iss: issuer,
        aud: 'mozi-api',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        tenant_key: 'tenant-oidc',
        role_list: ['admin'],
      }, privateKeyPem);

      const claims = await provider.validateToken(token, jwksUri, {
        issuer,
        audience: 'mozi-api',
      });
      expect(claims).not.toBeNull();

      const ctx = provider.extractContext(claims!, {
        tenant_claim: 'tenant_key',
        roles_claim: 'role_list',
        fallback_tenant_id: 'fallback-tenant',
      });
      expect(ctx.tenant_id).toBe('tenant-oidc');
      expect(ctx.user_id).toBe('oidc-user');
      expect(ctx.roles).toEqual(['admin']);
    });

    it('maintains backward compatibility via createOidcStub alias', () => {
      const provider = createOidcStub();
      expect(provider.discover).toBeDefined();
      expect(provider.validateToken).toBeDefined();
      expect(provider.extractContext).toBeDefined();
    });

    it('rejects expired token, forged signature, and issuer mismatch', async () => {
      const issuer = 'https://idp-security.example.com';
      const jwksUri = `${issuer}/jwks`;
      const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
      const jwks = { keys: [{ ...publicJwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] };
      const fetchMock = buildOidcFetchMock(issuer, jwksUri, jwks);
      const provider = createOidcProvider({ fetchFn: fetchMock });

      const expiredToken = signRs256Jwt({
        sub: 'expired-user',
        iss: issuer,
        aud: 'mozi-api',
        exp: Math.floor(Date.now() / 1000) - 10,
      }, privateKeyPem);
      const expiredClaims = await provider.validateToken(expiredToken, jwksUri, {
        issuer,
        audience: 'mozi-api',
      });
      expect(expiredClaims).toBeNull();

      const validPayload = {
        sub: 'forged-user',
        iss: issuer,
        aud: 'mozi-api',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const validToken = signRs256Jwt(validPayload, privateKeyPem);
      const [encodedHeader, encodedPayload, encodedSignature] = validToken.split('.');
      const forgedSignature = `${encodedSignature[0] === 'A' ? 'B' : 'A'}${encodedSignature.slice(1)}`;
      const forgedToken = `${encodedHeader}.${encodedPayload}.${forgedSignature}`;
      const forgedClaims = await provider.validateToken(forgedToken, jwksUri, {
        issuer,
        audience: 'mozi-api',
      });
      expect(forgedClaims).toBeNull();

      const issuerMismatchClaims = await provider.validateToken(validToken, jwksUri, {
        issuer: 'https://other-issuer.example.com',
        audience: 'mozi-api',
      });
      expect(issuerMismatchClaims).toBeNull();
    });
  });

  describe('API key management', () => {
    it('generates and authenticates API keys', () => {
      const { rawKey, record } = generateApiKey('tenant-1', 'user-1', 'test-key', ['admin']);
      expect(rawKey).toMatch(/^mozi_[a-f0-9]{64}$/);
      expect(record.tenant_id).toBe('tenant-1');
      expect(record.roles).toEqual(['admin']);

      const ctx = authenticateApiKey(rawKey);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('tenant-1');
    });

    it('handles revoke/get/list flows', () => {
      const { rawKey, record } = generateApiKey('tenant-2', 'user-2', 'ops-key', ['operator']);
      expect(getApiKey(record.id)?.name).toBe('ops-key');
      expect(listApiKeys('tenant-2').length).toBeGreaterThanOrEqual(1);
      expect(revokeApiKey(record.id, 'tenant-2')).toBe(true);
      expect(authenticateApiKey(rawKey)).toBeNull();
    });
  });

  describe('unified authenticate', () => {
    it('authenticates local JWT first', async () => {
      const token = sign('jwt-user', SECRET, 3600, {
        tenant_id: 'jwt-tenant',
        roles: ['admin'],
      });
      const ctx = await authenticate(token, SECRET);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('jwt-tenant');
    });

    it('authenticates OIDC JWT with tenant mapping config', async () => {
      const issuer = 'https://idp-auth.example.com';
      const jwksUri = `${issuer}/jwks`;
      const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
      const jwks = { keys: [{ ...publicJwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] };
      const fetchMock = buildOidcFetchMock(issuer, jwksUri, jwks);

      const token = signRs256Jwt({
        sub: 'oidc-auth-user',
        iss: issuer,
        aud: 'mozi-api',
        exp: Math.floor(Date.now() / 1000) + 3600,
        account_tenant: 'tenant-from-claim',
        custom_roles: 'operator admin',
      }, privateKeyPem);

      const config: EnterpriseAuthConfig = {
        oidc: {
          issuers: [{
            tenant_id: 'tenant-fallback',
            issuer,
            audience: 'mozi-api',
            tenant_claim: 'account_tenant',
            user_claim: 'sub',
            roles_claim: 'custom_roles',
          }],
        },
      };

      const ctx = await authenticate(token, SECRET, config, { fetchFn: fetchMock });
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('tenant-from-claim');
      expect(ctx!.user_id).toBe('oidc-auth-user');
      expect(ctx!.roles).toEqual(['operator', 'admin']);
    });

    it('authenticates minimal signed SAML assertion', async () => {
      const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const samlBase64 = buildSignedSamlAssertion(privateKeyPem);

      const config: EnterpriseAuthConfig = {
        saml: {
          idps: [{
            tenant_id: 'tenant-saml',
            entity_id: 'urn:test:idp',
            certificate: publicKeyPem,
            audience: 'urn:mozi:sp',
            tenant_attribute: 'tenant_id',
            user_attribute: 'user_id',
            roles_attribute: 'roles',
          }],
        },
      };

      const ctx = await authenticate(`saml:${samlBase64}`, SECRET, config);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenant_id).toBe('tenant-saml');
      expect(ctx!.user_id).toBe('user-saml');
      expect(ctx!.roles).toEqual(['admin', 'operator']);
    });

    it('rejects forged SAML signature', async () => {
      const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const samlBase64 = buildSignedSamlAssertion(privateKeyPem);
      const tampered = Buffer.from(samlBase64, 'base64')
        .toString('utf-8')
        .replace('tenant-saml', 'tenant-hijack');
      const tamperedBase64 = Buffer.from(tampered, 'utf-8').toString('base64');

      const config: EnterpriseAuthConfig = {
        saml: {
          idps: [{
            tenant_id: 'tenant-saml',
            entity_id: 'urn:test:idp',
            certificate: publicKeyPem,
            audience: 'urn:mozi:sp',
          }],
        },
      };

      const ctx = await authenticate(`saml:${tamperedBase64}`, SECRET, config);
      expect(ctx).toBeNull();
    });
  });
});
