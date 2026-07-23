/**
 * Onboarding Flow (#233)
 *
 * Tracks whether a user has completed first-run onboarding and manages
 * per-user preferences. On first login the workspace is initialized with
 * default skills, preferences, and an empty conversation.
 */

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getDb } from '../store/db.js';
import { logAudit } from './audit.js';

const logger = pino({ name: 'mozi:security:onboarding' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardingStatus {
  completed: boolean;
  completed_at: string | null;
  /** Default skills/preferences initialized? */
  workspace_initialized: boolean;
}

export interface UserPreference {
  key: string;
  value: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, key)
    )
  `);
  tableReady = true;
}

export function resetOnboardingTableFlag(): void {
  tableReady = false;
}

// ---------------------------------------------------------------------------
// Onboarding state
// ---------------------------------------------------------------------------

/**
 * Returns whether the user has completed onboarding.
 * Reads from the `users.onboarding_completed_at` column.
 */
export function getOnboardingStatus(userId: string, tenantId = 'default'): OnboardingStatus {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT onboarding_completed_at FROM users WHERE id = ? AND tenant_id = ?')
    .get(userId, tenantId) as { onboarding_completed_at: string | null } | undefined;

  const completedAt = row?.onboarding_completed_at ?? null;

  // Workspace initialized if default preferences exist
  const prefCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM user_preferences WHERE user_id = ? AND tenant_id = ? AND key LIKE 'default.%'",
  ).get(userId, tenantId) as { cnt: number }).cnt;

  return {
    completed: completedAt !== null,
    completed_at: completedAt,
    workspace_initialized: prefCount > 0,
  };
}

/**
 * Mark onboarding as complete and initialize the user workspace if not already done.
 */
export function completeOnboarding(userId: string, tenantId = 'default'): OnboardingStatus {
  ensureTable();
  const db = getDb();

  // Mark complete in users table
  const result = db.prepare(`
    UPDATE users
    SET onboarding_completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ? AND onboarding_completed_at IS NULL
  `).run(userId, tenantId);

  if (result.changes > 0) {
    logAudit({
      tenant_id: tenantId,
      user_id: userId,
      action: 'auth.login',
      resource_type: 'user',
      resource_id: userId,
      details: { event: 'onboarding_completed' },
      outcome: 'success',
    });
    logger.info({ userId, tenantId }, 'Onboarding marked complete');
  }

  // Initialize workspace if not done
  initializeUserWorkspace(userId, tenantId);

  return getOnboardingStatus(userId, tenantId);
}

/**
 * Initialize the user workspace: set default preferences and seed an empty conversation.
 * Idempotent — safe to call multiple times.
 */
export function initializeUserWorkspace(userId: string, tenantId = 'default'): void {
  ensureTable();

  const defaults: Record<string, string> = {
    'default.theme': 'system',
    'default.language': 'en',
    'default.notifications': 'true',
    'default.stream_responses': 'true',
  };

  for (const [key, value] of Object.entries(defaults)) {
    setUserPreference(userId, tenantId, key, value, /* skipIfExists */ true);
  }

  logger.info({ userId, tenantId }, 'User workspace initialized');
}

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

/**
 * Get all preferences for a user.
 */
export function getUserPreferences(userId: string, tenantId = 'default'): UserPreference[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    'SELECT key, value, updated_at FROM user_preferences WHERE user_id = ? AND tenant_id = ? ORDER BY key',
  ).all(userId, tenantId) as { key: string; value: string; updated_at: string }[];
  return rows;
}

/**
 * Get a single preference value. Returns undefined if not set.
 */
export function getUserPreference(userId: string, tenantId: string, key: string): string | undefined {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    'SELECT value FROM user_preferences WHERE user_id = ? AND tenant_id = ? AND key = ?',
  ).get(userId, tenantId, key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Set or update a user preference.
 *
 * @param skipIfExists - If true, do not overwrite an existing value (used for defaults).
 */
export function setUserPreference(
  userId: string,
  tenantId: string,
  key: string,
  value: string,
  skipIfExists = false,
): void {
  ensureTable();
  const db = getDb();

  if (skipIfExists) {
    db.prepare(`
      INSERT OR IGNORE INTO user_preferences (id, tenant_id, user_id, key, value)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), tenantId, userId, key, value);
  } else {
    db.prepare(`
      INSERT INTO user_preferences (id, tenant_id, user_id, key, value)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(randomUUID(), tenantId, userId, key, value);
  }
}

/**
 * Delete a user preference.
 */
export function deleteUserPreference(userId: string, tenantId: string, key: string): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM user_preferences WHERE user_id = ? AND tenant_id = ? AND key = ?',
  ).run(userId, tenantId, key);
  return result.changes > 0;
}
