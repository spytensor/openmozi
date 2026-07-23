/**
 * User model — JIT-provisioned on first OAuth/SAML login.
 *
 * Handles:
 * - Creating users from OAuth/SAML identity info (#231)
 * - Profile CRUD (get, update, delete)
 * - Role sync from auth provider claims
 */

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';
import { logAudit } from './audit.js';
import type { Role } from './rbac.js';

const logger = pino({ name: 'mozi:security:users' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: string;
  provider_id: string;
  role: Role;
  status: 'active' | 'disabled';
  allowed_models: string[] | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface UserAuthRecord extends User {
  password_hash: string | null;
}

export interface CreateUserInput {
  tenant_id: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  auth_provider: string;
  provider_id: string;
  role?: Role;
  password_hash?: string | null;
}

export interface UpdateUserInput {
  name?: string | null;
  avatar_url?: string | null;
  role?: Role;
}

export class DuplicateUserError extends Error {
  public readonly email: string;

  constructor(email: string) {
    super(`User already exists for email: ${email}`);
    this.name = 'DuplicateUserError';
    this.email = email;
  }
}

export const LOCAL_USER_ID = 'local-user';

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  // Table is declared in schema.sql; this is a belt-and-suspenders guard for
  // environments where the schema migration hasn't run yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      email TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      auth_provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'operator', 'viewer')),
      allowed_models TEXT,
      onboarding_completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      UNIQUE(tenant_id, auth_provider, provider_id),
      UNIQUE(tenant_id, email)
    )
  `);
  try {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  } catch {
    // Column already exists — ignore.
  }
  try {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled'))");
  } catch {
    // Column already exists — ignore.
  }
  try {
    db.exec('ALTER TABLE users ADD COLUMN allowed_models TEXT');
  } catch {
    // Column already exists — ignore.
  }
  db.exec("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''");
  tableReady = true;
}

/** Reset for testing */
export function resetUsersTableFlag(): void {
  tableReady = false;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Find an existing user by provider identity, or create one on first login (JIT provisioning).
 * Updates last_login_at and name/avatar on each login to stay fresh.
 */
export function findOrCreateUser(input: CreateUserInput): User {
  ensureTable();
  const db = getDb();

  // Try find by provider identity first
  const existing = db.prepare(`
    SELECT * FROM users
    WHERE tenant_id = ? AND auth_provider = ? AND provider_id = ?
  `).get(input.tenant_id, input.auth_provider, input.provider_id) as Record<string, unknown> | undefined;

  if (existing) {
    // Update mutable fields that may change between logins
    db.prepare(`
      UPDATE users
      SET last_login_at = datetime('now'),
          updated_at = datetime('now'),
          name = COALESCE(?, name),
          avatar_url = COALESCE(?, avatar_url)
      WHERE id = ?
    `).run(input.name ?? null, input.avatar_url ?? null, existing.id as string);

    const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id as string) as Record<string, unknown>;
    const user = deserializeUser(refreshed);
    logger.info({ userId: user.id, provider: input.auth_provider }, 'Existing user logged in');
    return user;
  }

  // JIT provision: create on first login
  const id = randomUUID();
  const role = input.role ?? 'viewer';
  db.prepare(`
    INSERT INTO users (
      id, tenant_id, email, name, avatar_url, auth_provider, provider_id,
      password_hash, role, last_login_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    input.tenant_id,
    input.email,
    input.name ?? null,
    input.avatar_url ?? null,
    input.auth_provider,
    input.provider_id,
    input.password_hash ?? null,
    role,
  );

  logAudit({
    tenant_id: input.tenant_id,
    user_id: id,
    action: 'auth.login',
    resource_type: 'user',
    resource_id: id,
    details: { email: input.email, provider: input.auth_provider, jit_created: true },
    outcome: 'success',
  });

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
  const user = deserializeUser(created);
  logger.info({ userId: id, email: input.email, provider: input.auth_provider }, 'User JIT-provisioned');
  return user;
}

/**
 * Ensure the built-in single-user identity exists for auth_mode=none.
 */
export function ensureLocalUser(tenantId = 'default'): User {
  ensureTable();
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
    .get(LOCAL_USER_ID, tenantId) as Record<string, unknown> | undefined;
  if (existing) return deserializeUser(existing);

  db.prepare(`
    INSERT INTO users (id, tenant_id, email, name, auth_provider, provider_id, role, status, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
  `).run(
    LOCAL_USER_ID,
    tenantId,
    'local-user@mozi.local',
    'Local User',
    'local',
    LOCAL_USER_ID,
    'admin',
  );

  logAudit({
    tenant_id: tenantId,
    user_id: LOCAL_USER_ID,
    action: 'auth.login',
    resource_type: 'user',
    resource_id: LOCAL_USER_ID,
    details: { provider: 'local', jit_created: true },
    outcome: 'success',
  });

  const created = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
    .get(LOCAL_USER_ID, tenantId) as Record<string, unknown>;
  logger.info({ userId: LOCAL_USER_ID, tenantId }, 'Local auth user provisioned');
  return deserializeUser(created);
}

/** Create a local email/password user. */
export function createLocalUser(input: {
  tenant_id: string;
  email: string;
  name?: string | null;
  password_hash: string | null;
  role: Role;
}): User {
  ensureTable();
  const db = getDb();
  const email = input.email.trim().toLowerCase();

  if (getUserByEmail(email, input.tenant_id)) {
    throw new DuplicateUserError(email);
  }

  const id = randomUUID();
  try {
    db.prepare(`
      INSERT INTO users (
        id, tenant_id, email, name, auth_provider, provider_id,
        password_hash, status, role, last_login_at
      )
      VALUES (?, ?, ?, ?, 'local', ?, ?, 'active', ?, NULL)
    `).run(
      id,
      input.tenant_id,
      email,
      input.name ?? null,
      email,
      input.password_hash,
      input.role,
    );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new DuplicateUserError(email);
    }
    throw err;
  }

  const created = getUserById(id, input.tenant_id);
  if (!created) throw new Error('Local user creation failed');
  logger.info({ userId: id, tenantId: input.tenant_id, role: input.role }, 'Local user created');
  return created;
}

/** Get a user by ID. */
export function getUserById(id: string, tenantId = 'default'): User | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
  return row ? deserializeUser(row) : null;
}

/** Get a user auth record, including password hash, by ID. */
export function getUserAuthById(id: string, tenantId = 'default'): UserAuthRecord | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
  return row ? deserializeUserAuthRecord(row) : null;
}

/** Get a user by email within a tenant. */
export function getUserByEmail(email: string, tenantId = 'default'): User | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE email = ? AND tenant_id = ?').get(email.trim().toLowerCase(), tenantId) as Record<string, unknown> | undefined;
  return row ? deserializeUser(row) : null;
}

/** Get a user auth record, including password hash, by email. */
export function getUserAuthByEmail(email: string, tenantId = 'default'): UserAuthRecord | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE email = ? AND tenant_id = ?')
    .get(email.trim().toLowerCase(), tenantId) as Record<string, unknown> | undefined;
  return row ? deserializeUserAuthRecord(row) : null;
}

/** Update mutable profile fields. Returns the updated user or null if not found. */
export function updateUser(id: string, tenantId: string, input: UpdateUserInput): User | null {
  ensureTable();
  const db = getDb();

  const fields: string[] = ['updated_at = datetime(\'now\')'];
  const values: unknown[] = [];

  if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name); }
  if (input.avatar_url !== undefined) { fields.push('avatar_url = ?'); values.push(input.avatar_url); }
  if (input.role !== undefined) { fields.push('role = ?'); values.push(input.role); }

  if (fields.length === 1) return getUserById(id, tenantId); // nothing to update

  values.push(id, tenantId);
  const result = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
  if (result.changes === 0) return null;

  logAudit({
    tenant_id: tenantId,
    user_id: id,
    action: 'auth.login',
    resource_type: 'user',
    resource_id: id,
    details: { updated_fields: Object.keys(input) },
    outcome: 'success',
  });

  return getUserById(id, tenantId);
}

/** Update the stored password hash for a user. */
export function updateUserPasswordHash(id: string, tenantId: string, passwordHash: string): User | null {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(passwordHash, id, tenantId);
  return result.changes > 0 ? getUserById(id, tenantId) : null;
}

/** Update user status. Disabled users are blocked by API auth guards. */
export function updateUserStatus(id: string, tenantId: string, status: 'active' | 'disabled'): User | null {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    UPDATE users
    SET status = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(status, id, tenantId);
  return result.changes > 0 ? getUserById(id, tenantId) : null;
}

/** Update a user's compatibility role column. RBAC assignments remain canonical. */
export function updateUserRoleColumn(id: string, tenantId: string, role: Role): User | null {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    UPDATE users
    SET role = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(role, id, tenantId);
  return result.changes > 0 ? getUserById(id, tenantId) : null;
}

/** Update a user's model grant. Null means inherit the tenant ceiling. */
export function updateUserAllowedModels(id: string, tenantId: string, allowedModels: string[] | null): User | null {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    UPDATE users
    SET allowed_models = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(allowedModels === null ? null : JSON.stringify(allowedModels), id, tenantId);
  return result.changes > 0 ? getUserById(id, tenantId) : null;
}

/** Mark a successful login time for a user. */
export function markUserLogin(id: string, tenantId: string): User | null {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    UPDATE users
    SET last_login_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
  return result.changes > 0 ? getUserById(id, tenantId) : null;
}

/**
 * Return true when the next local registrant should bootstrap as tenant admin.
 */
export function canBootstrapLocalAdmin(tenantId = 'default'): boolean {
  ensureTable();
  const db = getDb();
  const passwordUsers = (db.prepare(`
    SELECT COUNT(*) as count
    FROM users
    WHERE tenant_id = ? AND password_hash IS NOT NULL AND password_hash != ''
  `).get(tenantId) as { count: number }).count;
  if (passwordUsers > 0) return false;

  // Only role assignments belonging to a REAL (password-bearing) account block
  // bootstrap. The auto-provisioned single-user 'local-user' — and any keyless
  // none-mode/test identity — gets an admin role but no password, so it must NOT
  // lock out the first genuine account when a box switches to auth_mode=local.
  const roleAssignments = (db.prepare(`
    SELECT COUNT(*) as count
    FROM role_assignments ra
    JOIN users u ON u.id = ra.user_id AND u.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = ? AND u.password_hash IS NOT NULL AND u.password_hash != ''
  `).get(tenantId) as { count: number }).count;
  return roleAssignments === 0;
}

/** List all users in a tenant (admin use). */
export function listUsers(tenantId = 'default', limit = 100, offset = 0): User[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
  ).all(tenantId, limit, offset) as Record<string, unknown>[];
  return rows.map(deserializeUser);
}

/** Permanently delete a user (admin only). */
export function deleteUser(id: string, tenantId: string, deletedBy: string): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  if (result.changes > 0) {
    logAudit({
      tenant_id: tenantId,
      user_id: deletedBy,
      action: 'role.remove',
      resource_type: 'user',
      resource_id: id,
      details: { deleted_by: deletedBy },
      outcome: 'success',
    });
    logger.info({ userId: id, tenantId, deletedBy }, 'User deleted');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function deserializeUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    email: row.email as string,
    name: (row.name as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    auth_provider: row.auth_provider as string,
    provider_id: row.provider_id as string,
    role: (row.role as Role) ?? 'viewer',
    status: row.status === 'disabled' ? 'disabled' : 'active',
    allowed_models: deserializeAllowedModels(row.allowed_models),
    onboarding_completed_at: (row.onboarding_completed_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    last_login_at: (row.last_login_at as string | null) ?? null,
  };
}

function deserializeUserAuthRecord(row: Record<string, unknown>): UserAuthRecord {
  return {
    ...deserializeUser(row),
    password_hash: (row.password_hash as string | null) ?? null,
  };
}

function deserializeAllowedModels(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return models;
  } catch {
    return null;
  }
}
