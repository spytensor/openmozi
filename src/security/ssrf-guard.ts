/**
 * SSRF (Server-Side Request Forgery) guard — validates URLs before
 * outbound requests to block access to private IPs, cloud metadata
 * endpoints, and localhost services.
 */

import { URL } from 'node:url';
import { isIP } from 'node:net';
import dns from 'node:dns/promises';
import pino from 'pino';

const logger = pino({ name: 'mozi:security:ssrf-guard' });

// ---------------------------------------------------------------------------
// Private IP ranges
// ---------------------------------------------------------------------------

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./,                          // Loopback
  /^10\./,                           // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC 1918 Class B
  /^192\.168\./,                     // RFC 1918 Class C
  /^169\.254\./,                     // Link-local (AWS/GCP metadata)
  /^0\./,                            // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC 6598 CGNAT
  /^::1$/,                           // IPv6 loopback
  /^fe80:/i,                         // IPv6 link-local
  /^fc00:/i,                         // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,               // IPv6 unique local
];

const BLOCKED_HOSTNAMES: Set<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SSRFConfig {
  enabled: boolean;
  block_private_ips: boolean;
  block_metadata_endpoints: boolean;
  allowed_internal_hosts: string[];
  dns_rebinding_protection: boolean;
}

export const DEFAULT_SSRF_CONFIG: SSRFConfig = {
  enabled: true,
  block_private_ips: true,
  block_metadata_endpoints: true,
  allowed_internal_hosts: [],
  dns_rebinding_protection: true,
};

let config: SSRFConfig = { ...DEFAULT_SSRF_CONFIG };

/** Update SSRF guard configuration at runtime. */
export function configure(overrides: Partial<SSRFConfig>): void {
  config = { ...DEFAULT_SSRF_CONFIG, ...overrides };
}

/** Return a copy of the current SSRF configuration. */
export function getSSRFConfig(): SSRFConfig {
  return { ...config };
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

export interface SSRFCheckResult {
  safe: boolean;
  reason?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-subscription-token',
];

function isSensitiveRedirectHeader(name: string): boolean {
  return SENSITIVE_REDIRECT_HEADERS.includes(name.toLowerCase())
    || /(authorization|auth|cookie|api[-_]?key|token|secret)/i.test(name);
}

export interface SSRFSafeFetchOptions {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
}

function isPrivateIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 in dotted form: ::ffff:127.0.0.1
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateIP(v4mapped[1]);

  // Handle IPv4-mapped IPv6 in hex form: ::ffff:7f00:1 (URL parser converts to this)
  const v4hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIP(dotted);
  }

  return PRIVATE_IP_PATTERNS.some(pattern => pattern.test(ip));
}

/**
 * Async SSRF check — validates URL and performs DNS resolution to catch
 * DNS rebinding attacks. Use this before making outbound HTTP requests.
 */
export async function checkSSRF(urlString: string): Promise<SSRFCheckResult> {
  if (!config.enabled) return { safe: true };

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: `Invalid URL: ${urlString}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'Blocked: URL credentials are not allowed' };
  }

  const rawHostname = parsed.hostname.toLowerCase();
  // Strip brackets from IPv6 addresses (URL parser wraps them: [::1] → ::1)
  const hostname = rawHostname.replace(/^\[|\]$/g, '');

  // Whitelist bypass
  if (config.allowed_internal_hosts.includes(hostname)) {
    return { safe: true };
  }

  // Block known metadata endpoints
  if (config.block_metadata_endpoints && BLOCKED_HOSTNAMES.has(hostname)) {
    logger.warn({ url: urlString, hostname }, 'SSRF blocked: metadata endpoint');
    return { safe: false, reason: `Blocked metadata endpoint: ${hostname}` };
  }

  if (config.block_private_ips) {
    // Block localhost variants
    if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
      logger.warn({ url: urlString }, 'SSRF blocked: localhost');
      return { safe: false, reason: 'Blocked: localhost access' };
    }

    // Block direct private IPs
    if (isIP(hostname) && isPrivateIP(hostname)) {
      logger.warn({ url: urlString, ip: hostname }, 'SSRF blocked: private IP');
      return { safe: false, reason: `Blocked private/internal IP: ${hostname}` };
    }
  }

  // DNS rebinding protection
  if (config.dns_rebinding_protection && config.block_private_ips && !isIP(hostname)) {
    try {
      const v4 = await dns.resolve4(hostname).catch(() => [] as string[]);
      const v6 = await dns.resolve6(hostname).catch(() => [] as string[]);

      for (const addr of [...v4, ...v6]) {
        if (isPrivateIP(addr)) {
          logger.warn({ url: urlString, hostname, resolvedIp: addr }, 'SSRF blocked: DNS resolves to private IP');
          return { safe: false, reason: `DNS rebinding: ${hostname} resolves to private IP ${addr}` };
        }
      }
    } catch {
      // DNS failure is not an SSRF concern
    }
  }

  return { safe: true };
}

/**
 * Synchronous fast-path check for obvious SSRF patterns.
 * Does NOT perform DNS resolution. Use for quick pre-filtering.
 */
export function checkSSRFSync(urlString: string): SSRFCheckResult {
  if (!config.enabled) return { safe: true };

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: `Invalid URL: ${urlString}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'Blocked: URL credentials are not allowed' };
  }

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[|\]$/g, '');

  if (config.allowed_internal_hosts.includes(hostname)) {
    return { safe: true };
  }

  if (config.block_metadata_endpoints && BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `Blocked metadata endpoint: ${hostname}` };
  }

  if (config.block_private_ips) {
    if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
      return { safe: false, reason: 'Blocked: localhost access' };
    }
    if (isIP(hostname) && isPrivateIP(hostname)) {
      return { safe: false, reason: `Blocked private/internal IP: ${hostname}` };
    }
  }

  return { safe: true };
}

function redirectInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  if (from.origin !== to.origin) {
    for (const name of [...headers.keys()]) {
      if (isSensitiveRedirectHeader(name)) headers.delete(name);
    }
  }

  const method = (init.method ?? 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    headers.delete('content-length');
    headers.delete('content-type');
    return { ...init, method: 'GET', body: undefined, headers, redirect: 'manual' };
  }
  return { ...init, headers, redirect: 'manual' };
}

/**
 * Fetch with SSRF validation on the initial URL and every redirect hop.
 * Redirects are handled manually so the HTTP client cannot follow a public URL
 * into a private service, and credentials are removed when the origin changes.
 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit = {},
  options: SSRFSafeFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = new URL(url);
  let currentInit: RequestInit = { ...init, redirect: 'manual' };

  for (let redirects = 0; ; redirects += 1) {
    const check = await checkSSRF(current.toString());
    if (!check.safe) {
      throw new Error(`URL blocked by SSRF protection: ${check.reason}`);
    }

    const response = await fetchImpl(current, currentInit);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Too many redirects (maximum ${maxRedirects})`);
    }

    const next = new URL(location, current);
    const nextCheck = await checkSSRF(next.toString());
    if (!nextCheck.safe) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Redirect blocked by SSRF protection: ${nextCheck.reason}`);
    }

    const method = (currentInit.method ?? 'GET').toUpperCase();
    const dropsBody = response.status === 303
      || ((response.status === 301 || response.status === 302) && method === 'POST');
    if (current.origin !== next.origin && method !== 'GET' && method !== 'HEAD' && !dropsBody) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Cross-origin redirect blocked for ${method} request`);
    }

    currentInit = redirectInit(currentInit, response.status, current, next);
    current = next;
    await response.body?.cancel().catch(() => undefined);
  }
}
