/**
 * RBAC — Role-Based Access Control for / commands.
 *
 * Roles: admin, operator, viewer
 * Permission matrix controls which commands each role can execute.
 * Role assignments stored in SQLite role_assignments table.
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { getConfig } from '../config/index.js';
import { logAudit } from './audit.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:security:rbac' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleAssignment {
  id: number;
  tenant_id: string;
  user_id: string;
  role: Role;
  assigned_by: string;
  created_at: string;
}

export class AccessDeniedError extends Error {
  public readonly userId: string;
  public readonly role: Role;
  public readonly command: string;

  constructor(userId: string, role: Role, command: string) {
    super(`Access denied: user '${userId}' with role '${role}' cannot execute '/${command}'`);
    this.name = 'AccessDeniedError';
    this.userId = userId;
    this.role = role;
    this.command = command;
  }
}

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

/**
 * Maps commands to minimum required role.
 *
 * admin    — all commands, config changes, manage tenants
 * operator — /tasks, /agents, /skills, /approve, /reject, /budget, /kill, /cancel
 * viewer   — /status, /tasks (read-only), /agents (read-only), /budget (read-only), /help
 */
const COMMAND_PERMISSIONS: Record<string, Role> = {
  // Admin only
  'config': 'admin',
  'onboard': 'admin',
  'tenant': 'admin',
  'pair': 'admin',
  'users': 'admin',

  // Operator (and above)
  'approve': 'operator',
  'reject': 'operator',
  'kill': 'operator',
  'cancel': 'operator',
  'skills': 'operator',
  'memory': 'operator',
  'trace': 'operator',

  // Viewer (everyone)
  'start': 'viewer',
  'status': 'viewer',
  'capabilities': 'viewer',
  'tasks': 'viewer',
  'agents': 'viewer',
  'budget': 'viewer',
  'help': 'viewer',
};

const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

// ---------------------------------------------------------------------------
// Ensure table exists
// ---------------------------------------------------------------------------

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      assigned_by TEXT DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id)
    )
  `);
  tableEnsured = true;
}

/** Reset table flag (for testing) */
export function resetTableFlag(): void {
  tableEnsured = false;
}

// ---------------------------------------------------------------------------
// Role management
// ---------------------------------------------------------------------------

/**
 * Assign a role to a user within a tenant.
 * Upserts — if the user already has a role, it is replaced.
 */
export function assignRole(
  tenantId: string,
  userId: string,
  role: Role,
  assignedBy = 'system',
): RoleAssignment {
  ensureTable();
  if (!isValidRole(role)) {
    throw new Error(`Invalid role: '${role}'. Must be one of: ${ROLES.join(', ')}`);
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO role_assignments (tenant_id, user_id, role, assigned_by, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, user_id) DO UPDATE SET
      role = excluded.role,
      assigned_by = excluded.assigned_by,
      created_at = datetime('now')
  `).run(tenantId, userId, role, assignedBy);

  logEvent('role_assigned', 'security', userId, { tenant_id: tenantId, role, assigned_by: assignedBy }, tenantId);
  logAudit({
    tenant_id: tenantId,
    user_id: assignedBy,
    action: 'role.assign',
    resource_type: 'user',
    resource_id: userId,
    details: { role, assigned_by: assignedBy },
  });
  logger.info({ tenant_id: tenantId, user_id: userId, role }, 'Role assigned');

  return getRole(tenantId, userId)!;
}

/**
 * Get the role assignment for a user in a tenant.
 * Returns null if no explicit assignment exists.
 */
export function getRole(tenantId: string, userId: string): RoleAssignment | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM role_assignments WHERE tenant_id = ? AND user_id = ?',
  ).get(tenantId, userId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return deserializeAssignment(row);
}

/**
 * Return true when the server is bound to a loopback address only.
 * Used to decide whether it is safe to default unknown users to 'admin'.
 */
export function isLocalOnly(): boolean {
  try {
    const host = getConfig().server.host;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    // Config not yet loaded — assume localhost (safest assumption at startup).
    return true;
  }
}

/**
 * Get the effective role for a user.
 *
 * Resolution order:
 * 1. Explicit DB assignment → return it.
 * 2. Other assignments exist in tenant → 'viewer' (unknown user).
 * 3. No assignments at all (fresh setup):
 *    - `security.default_role` set in config → use that value.
 *    - Localhost bind only → 'admin' (self-hosted, backward compatible).
 *    - Network-exposed → 'viewer' (safe default; logs a warning if 'admin' is forced via config).
 */
export function getEffectiveRole(tenantId: string, userId: string): Role {
  const assignment = getRole(tenantId, userId);
  if (assignment) return assignment.role;

  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM role_assignments WHERE tenant_id = ?').get(tenantId) as { cnt: number }).cnt;
  if (count > 0) return 'viewer';

  // Fresh instance — no role assignments exist yet.
  const localOnly = isLocalOnly();

  let explicitDefault: Role | undefined;
  try {
    explicitDefault = getConfig().security.default_role;
  } catch {
    // Config unavailable; fall through to auto-detect.
  }

  const effectiveDefault: Role = explicitDefault ?? (localOnly ? 'admin' : 'viewer');

  if (effectiveDefault === 'admin' && !localOnly) {
    logger.warn(
      { tenant_id: tenantId },
      'SECURITY WARNING: admin is the default role on a network-exposed instance. ' +
      'Set security.default_role = "viewer" in your config or bind the server to localhost.',
    );
  }

  return effectiveDefault;
}

/**
 * Get the effective role for a user, considering roles from TenantContext.
 * Uses the highest role from context roles or DB assignment.
 */
export function resolveRole(tenantId: string, userId: string, contextRoles: string[] = []): Role {
  const dbRole = getEffectiveRole(tenantId, userId);
  let highest: Role = dbRole;

  for (const r of contextRoles) {
    if (isValidRole(r) && ROLE_HIERARCHY[r] > ROLE_HIERARCHY[highest]) {
      highest = r;
    }
  }

  return highest;
}

/**
 * Remove a role assignment.
 */
export function removeRole(tenantId: string, userId: string): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM role_assignments WHERE tenant_id = ? AND user_id = ?',
  ).run(tenantId, userId);

  if (result.changes > 0) {
    logEvent('role_removed', 'security', userId, { tenant_id: tenantId }, tenantId);
    logAudit({
      tenant_id: tenantId,
      action: 'role.remove',
      resource_type: 'user',
      resource_id: userId,
      details: { tenant_id: tenantId },
    });
    return true;
  }
  return false;
}

/**
 * List all role assignments for a tenant.
 */
export function listRoles(tenantId = 'default'): RoleAssignment[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM role_assignments WHERE tenant_id = ? ORDER BY role DESC, user_id ASC',
  ).all(tenantId) as Record<string, unknown>[];
  return rows.map(deserializeAssignment);
}

// ---------------------------------------------------------------------------
// Permission checking
// ---------------------------------------------------------------------------

/**
 * Check if a role has permission to execute a command.
 */
export function hasCommandPermission(role: Role, command: string): boolean {
  const requiredRole = COMMAND_PERMISSIONS[command];
  if (!requiredRole) {
    // Unknown commands default to admin-only
    return role === 'admin';
  }
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Check if a user (by role) can execute a command.
 * Throws AccessDeniedError if denied.
 */
export function checkCommandAccess(
  tenantId: string,
  userId: string,
  command: string,
  contextRoles: string[] = [],
): void {
  const role = resolveRole(tenantId, userId, contextRoles);

  if (!hasCommandPermission(role, command)) {
    logger.warn({ tenant_id: tenantId, user_id: userId, role, command }, 'Access denied');
    logEvent('access_denied', 'security', userId, {
      tenant_id: tenantId,
      role,
      command,
    }, tenantId);
    throw new AccessDeniedError(userId, role, command);
  }
}

/**
 * Get the list of commands available for a given role.
 */
export function getAvailableCommands(role: Role): string[] {
  return Object.entries(COMMAND_PERMISSIONS)
    .filter(([, requiredRole]) => ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[requiredRole])
    .map(([cmd]) => cmd);
}

/**
 * Get the required role for a command.
 */
export function getCommandRole(command: string): Role {
  return COMMAND_PERMISSIONS[command] ?? 'admin';
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check if a string is a valid role.
 */
export function isValidRole(role: string): role is Role {
  return ROLES.includes(role as Role);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function deserializeAssignment(row: Record<string, unknown>): RoleAssignment {
  return {
    id: row.id as number,
    tenant_id: row.tenant_id as string,
    user_id: row.user_id as string,
    role: row.role as Role,
    assigned_by: (row.assigned_by as string) ?? 'system',
    created_at: row.created_at as string,
  };
}
