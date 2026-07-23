/**
 * Tenant Context — dynamic multi-tenant ID activation.
 *
 * Provides TenantContext type, middleware for extracting tenant_id from JWT,
 * and workspace isolation utilities (per-tenant directories for memory,
 * skills, agents).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verify as verifyJwt, type JwtPayload } from '../security/jwt.js';
import { log as logEvent } from '../store/events.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tenants' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantContext {
  tenant_id: string;
  user_id: string;
  roles: string[];
}

/** Default tenant context (backwards-compatible with MVP single-tenant) */
export const DEFAULT_TENANT_CONTEXT: TenantContext = {
  tenant_id: 'default',
  user_id: 'system',
  roles: ['admin'],
};

// ---------------------------------------------------------------------------
// Tenant workspace paths
// ---------------------------------------------------------------------------

const DATA_ROOT = 'data/tenants';

/**
 * Get the workspace root directory for a tenant.
 * Creates the directory tree if it does not exist.
 */
export function getTenantWorkspace(tenantId: string): string {
  const workspace = join(DATA_ROOT, tenantId);
  ensureTenantDirs(workspace);
  return workspace;
}

/**
 * Get the path to a tenant-specific file.
 */
export function getTenantFilePath(tenantId: string, ...segments: string[]): string {
  const workspace = getTenantWorkspace(tenantId);
  return join(workspace, ...segments);
}

/**
 * Ensure all required subdirectories exist for a tenant workspace.
 */
function ensureTenantDirs(workspace: string): void {
  const dirs = [
    workspace,
    join(workspace, 'memory'),
    join(workspace, 'skills'),
    join(workspace, 'agents'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// JWT → TenantContext extraction
// ---------------------------------------------------------------------------

/**
 * Extract TenantContext from a JWT token.
 *
 * JWT claims used:
 *   - sub:       user_id
 *   - tenant_id: tenant identifier (falls back to 'default')
 *   - roles:     string[] of role names (falls back to ['viewer'])
 *
 * @param token  - JWT string
 * @param secret - HMAC secret for verification
 * @returns TenantContext or null if token is invalid/expired
 */
export function extractTenantContext(token: string, secret: string): TenantContext | null {
  const payload = verifyJwt(token, secret);
  if (!payload) {
    return null;
  }
  return payloadToContext(payload);
}

/**
 * Build a TenantContext from an already-verified JWT payload.
 */
export function payloadToContext(payload: JwtPayload): TenantContext {
  const tenantId = (payload.tenant_id as string) ?? 'default';
  const userId = payload.sub;
  const rawRoles = payload.roles;
  const roles: string[] = Array.isArray(rawRoles)
    ? rawRoles.filter((r): r is string => typeof r === 'string')
    : ['viewer'];

  return { tenant_id: tenantId, user_id: userId, roles };
}

// ---------------------------------------------------------------------------
// Middleware helper
// ---------------------------------------------------------------------------

/**
 * Middleware-style function for Fastify routes: extracts TenantContext
 * from Authorization header or query param.
 *
 * @returns TenantContext or null if unauthenticated
 */
export function extractFromRequest(
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string | undefined>,
  secret: string,
): TenantContext | null {
  // Try Authorization: Bearer <token>
  const authHeader = headers['authorization'] ?? headers['Authorization'];
  const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (authStr && authStr.startsWith('Bearer ')) {
    const token = authStr.slice(7);
    const ctx = extractTenantContext(token, secret);
    if (ctx) return ctx;
  }

  // Try query param
  const token = query['token'];
  if (token) {
    return extractTenantContext(token, secret);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tenant validation
// ---------------------------------------------------------------------------

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate a tenant_id string.
 * Must be 1-64 characters, alphanumeric + underscore + hyphen.
 */
export function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_PATTERN.test(tenantId);
}

/**
 * Log a tenant-scoped event.
 */
export function logTenantEvent(
  tenantId: string,
  eventType: string,
  details: Record<string, unknown>,
): void {
  logEvent(eventType, 'tenant', tenantId, details, tenantId);
  logger.info({ tenant_id: tenantId, event: eventType }, 'Tenant event');
}
