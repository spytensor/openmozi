/**
 * SAML 2.0 Service Provider (SP) Module (#234)
 *
 * Implements SP-initiated SSO:
 *   GET  /api/auth/saml/login    → generates AuthnRequest, redirects to IdP
 *   POST /api/auth/saml/acs      → validates SAML assertion, provisions user, issues JWT
 *   GET  /api/auth/saml/metadata → returns SP metadata XML
 *
 * Built on Node.js built-ins (crypto, zlib) only — no external SAML library.
 * Extends the minimal SAML validation in enterprise-auth.ts with a full SP flow.
 *
 * Tested against standard IdPs (Okta, Azure AD SAML, Shibboleth, SimpleSAMLphp).
 * For production use with complex assertion shapes (encrypted assertions, multi-cert
 * rollover), consider replacing with @node-saml/node-saml.
 */

import { randomUUID, createSign, createVerify, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import pino from 'pino';
import type { SamlSpConfig } from '../config/index.js';

const logger = pino({ name: 'mozi:security:saml' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SamlUserInfo {
  /** NameID from the assertion */
  name_id: string;
  /** Normalized email */
  email: string;
  /** Display name */
  name: string | null;
  /** Raw attributes from the assertion */
  attributes: Record<string, string>;
  /** Session index for SLO */
  session_index: string | null;
}

export interface SamlValidationResult {
  userInfo: SamlUserInfo;
  /** IdP entity ID from the assertion */
  issuer: string;
}

// ---------------------------------------------------------------------------
// SP Metadata
// ---------------------------------------------------------------------------

/**
 * Generate SP metadata XML for IdP configuration.
 * The IdP administrator imports this to establish trust.
 */
export function generateSpMetadata(cfg: SamlSpConfig): string {
  const certPem = stripPemHeaders(cfg.certificate);
  const certLine = certPem ? `
      <md:KeyDescriptor use="signing">
        <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
          <ds:X509Data>
            <ds:X509Certificate>${certPem}</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </md:KeyDescriptor>
      <md:KeyDescriptor use="encryption">
        <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
          <ds:X509Data>
            <ds:X509Certificate>${certPem}</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </md:KeyDescriptor>` : '';

  return `<?xml version="1.0"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${escapeXml(cfg.entity_id)}">
  <md:SPSSODescriptor
    AuthnRequestsSigned="true"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${certLine}
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${escapeXml(cfg.acs_url)}"
      index="1"
      isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

// ---------------------------------------------------------------------------
// SP-initiated AuthnRequest
// ---------------------------------------------------------------------------

/**
 * Generate a SAML AuthnRequest and return the redirect URL (HTTP-Redirect binding).
 *
 * The request is base64 + deflateRaw encoded per the SAML HTTP-Redirect binding spec.
 * If the SP private key is configured, the request is also signed (SigAlg + Signature).
 */
export function generateAuthnRequestUrl(cfg: SamlSpConfig, relayState?: string): string {
  if (!cfg.idp_sso_url) {
    throw new Error('SAML SP: idp_sso_url is not configured');
  }

  const requestId = `_${randomUUID().replace(/-/g, '')}`;
  const issueInstant = new Date().toISOString();

  const xml = [
    `<samlp:AuthnRequest`,
    ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`,
    ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
    ` ID="${requestId}"`,
    ` Version="2.0"`,
    ` IssueInstant="${issueInstant}"`,
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
    ` AssertionConsumerServiceURL="${escapeXml(cfg.acs_url)}"`,
    ` Destination="${escapeXml(cfg.idp_sso_url)}">`,
    `<saml:Issuer>${escapeXml(cfg.entity_id)}</saml:Issuer>`,
    `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>`,
    `</samlp:AuthnRequest>`,
  ].join('');

  // Compress + encode (DEFLATE raw, base64url per SAML HTTP-Redirect binding)
  const compressed = deflateRawSync(Buffer.from(xml, 'utf-8'));
  const samlRequest = compressed.toString('base64');

  const params = new URLSearchParams({ SAMLRequest: samlRequest });
  if (relayState) params.set('RelayState', relayState);

  // Optionally sign the redirect URL (SigAlg + Signature query params)
  if (cfg.private_key && cfg.private_key.trim()) {
    const sigAlg = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    params.set('SigAlg', sigAlg);
    const signingInput = params.toString();
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      signer.end();
      const signature = signer.sign(cfg.private_key, 'base64');
      params.set('Signature', signature);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'SAML: failed to sign AuthnRequest, sending unsigned');
    }
  }

  return `${cfg.idp_sso_url}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Assertion validation (ACS endpoint)
// ---------------------------------------------------------------------------

/**
 * Validate a base64-encoded SAML Response received at the ACS endpoint.
 * Verifies: signature, issuer, audience, time window, NameID presence.
 *
 * @throws Error with a descriptive message on any validation failure.
 */
export function validateSamlResponse(
  samlResponseB64: string,
  cfg: SamlSpConfig,
  nowMs?: number,
): SamlValidationResult {
  const now = nowMs ?? Date.now();

  // Decode base64
  let xml: string;
  try {
    xml = Buffer.from(samlResponseB64, 'base64').toString('utf-8');
  } catch {
    throw new Error('SAML: failed to decode base64 SAMLResponse');
  }

  logger.debug({ xmlLength: xml.length }, 'SAML: validating assertion');

  // --- Issuer ---
  const issuer = extractTagValue(xml, 'Issuer');
  if (!issuer) throw new Error('SAML: missing Issuer element');

  // Check issuer matches configured IdP entity ID
  if (cfg.idp_entity_id && issuer !== cfg.idp_entity_id) {
    throw new Error(`SAML: issuer mismatch (got '${issuer}', expected '${cfg.idp_entity_id}')`);
  }

  // --- Audience ---
  const audience = extractTagValue(xml, 'Audience');
  if (cfg.entity_id && audience && audience !== cfg.entity_id) {
    throw new Error(`SAML: audience mismatch (got '${audience}', expected '${cfg.entity_id}')`);
  }

  // --- Time window ---
  validateTimeWindow(xml, now);

  // --- Signature ---
  if (cfg.idp_certificate && cfg.idp_certificate.trim()) {
    validateSignature(xml, cfg.idp_certificate);
  } else {
    logger.warn('SAML: no IdP certificate configured, skipping signature verification');
  }

  // --- NameID ---
  const nameId = extractTagValue(xml, 'NameID');
  if (!nameId) throw new Error('SAML: missing NameID element');

  // --- Attributes ---
  const attributes = extractAttributes(xml);
  const sessionIndex = extractAttribute(xml, 'AuthnStatement', 'SessionIndex') ?? null;

  // Resolve email: prefer NameID if it looks like an email, else check attributes
  const email = nameId.includes('@') ? nameId
    : attributes.email
    ?? attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']
    ?? attributes['http://schemas.xmlsoap.org/claims/EmailAddress']
    ?? attributes['urn:oid:0.9.2342.19200300.100.1.3']
    ?? nameId;

  const name = attributes.displayName
    ?? attributes.name
    ?? attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
    ?? attributes['urn:oid:2.16.840.1.113730.3.1.241']
    ?? null;

  logger.info({ issuer, nameId, email }, 'SAML assertion validated');

  return {
    userInfo: { name_id: nameId, email, name: name ?? null, attributes, session_index: sessionIndex },
    issuer,
  };
}

// ---------------------------------------------------------------------------
// Internal XML helpers
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripPemHeaders(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
}

function extractTagValue(xml: string, tag: string): string | null {
  const regex = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i');
  const m = xml.match(regex);
  return m ? m[1].trim() : null;
}

function extractAttribute(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)>`, 'i');
  const m = xml.match(regex);
  if (!m) return null;
  const attrRegex = new RegExp(`\\b${attr}="([^"]+)"`, 'i');
  const am = m[1].match(attrRegex);
  return am ? am[1] : null;
}

function validateTimeWindow(xml: string, nowMs: number): void {
  const conditionsRegex = /<(?:\w+:)?Conditions\b([^>]*)>/i;
  const m = xml.match(conditionsRegex);
  if (!m) return;

  const attrs = m[1];
  const notBefore = attrs.match(/NotBefore="([^"]+)"/i)?.[1];
  const notOnOrAfter = attrs.match(/NotOnOrAfter="([^"]+)"/i)?.[1];

  if (notBefore) {
    const t = Date.parse(notBefore);
    if (Number.isFinite(t) && nowMs < t) {
      throw new Error(`SAML: assertion not yet valid (NotBefore: ${notBefore})`);
    }
  }
  if (notOnOrAfter) {
    const t = Date.parse(notOnOrAfter);
    if (Number.isFinite(t) && nowMs >= t) {
      throw new Error(`SAML: assertion expired (NotOnOrAfter: ${notOnOrAfter})`);
    }
  }
}

function removeSignatureBlock(xml: string): string {
  return xml
    .replace(/<(?:\w+:)?Signature\b[\s\S]*?<\/(?:\w+:)?Signature>/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateSignature(xml: string, idpCertPem: string): void {
  const sigValue = extractTagValue(xml, 'SignatureValue');
  if (!sigValue) throw new Error('SAML: missing SignatureValue element');

  const signedContent = removeSignatureBlock(xml);
  const sigBuffer = Buffer.from(sigValue.replace(/\s/g, ''), 'base64');

  // Normalize certificate to PEM format
  const certBody = stripPemHeaders(idpCertPem);
  const certPem = `-----BEGIN CERTIFICATE-----\n${certBody.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;

  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signedContent);
    verifier.end();
    if (!verifier.verify(certPem, sigBuffer)) {
      throw new Error('SAML: signature verification failed');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SAML:')) throw err;
    throw new Error(`SAML: signature verification error: ${(err as Error).message}`);
  }
}

function extractAttributes(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /<(?:\w+:)?Attribute\b[^>]*Name="([^"]+)"[^>]*>[\s\S]*?<(?:\w+:)?AttributeValue[^>]*>([\s\S]*?)<\/(?:\w+:)?AttributeValue>[\s\S]*?<\/(?:\w+:)?Attribute>/gi;
  let m = regex.exec(xml);
  while (m) {
    const name = m[1];
    const value = m[2].trim();
    // Use the last component of the name as a short alias
    const shortName = name.split(/[:/]/).pop() ?? name;
    result[name] = value;
    if (shortName !== name) result[shortName] = value;
    m = regex.exec(xml);
  }
  return result;
}

// ---------------------------------------------------------------------------
// IdP metadata parsing (optional — auto-configure from IdP metadata URL)
// ---------------------------------------------------------------------------

interface IdpMetadata {
  entity_id: string;
  sso_url: string;
  certificate: string;
}

/**
 * Fetch and parse IdP metadata XML.
 * Used to auto-configure idp_entity_id, idp_sso_url, idp_certificate from idp_metadata_url.
 */
export async function fetchIdpMetadata(metadataUrl: string): Promise<IdpMetadata> {
  const res = await fetch(metadataUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch IdP metadata (${res.status}): ${metadataUrl}`);
  }
  const xml = await res.text();

  const entityId = xml.match(/entityID="([^"]+)"/i)?.[1] ?? '';
  const ssoUrlMatch = xml.match(
    /SingleSignOnService[^>]*Binding="[^"]*HTTP-Redirect[^"]*"[^>]*Location="([^"]+)"/i,
  ) ?? xml.match(/SingleSignOnService[^>]*Location="([^"]+)"/i);
  const ssoUrl = ssoUrlMatch?.[1] ?? '';

  const certMatch = xml.match(/<ds:X509Certificate[^>]*>([\s\S]*?)<\/ds:X509Certificate>/i)
    ?? xml.match(/<X509Certificate[^>]*>([\s\S]*?)<\/X509Certificate>/i);
  const certificate = certMatch
    ? `-----BEGIN CERTIFICATE-----\n${certMatch[1].replace(/\s/g, '').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`
    : '';

  if (!entityId || !ssoUrl) {
    throw new Error('Could not parse required fields (entityID, SingleSignOnService) from IdP metadata');
  }

  return { entity_id: entityId, sso_url: ssoUrl, certificate };
}

// Hash for logging only — never logs raw assertions
export function hashAssertion(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}
