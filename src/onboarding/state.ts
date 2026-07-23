/**
 * Onboarding state persistence — shared with bootstrap module.
 */

import { getDb } from '../store/db.js';

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bootstrap_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tableEnsured = true;
}

export function resetTableFlag(): void {
  tableEnsured = false;
}

export function getBootstrapState(key: string): string | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT value FROM bootstrap_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setBootstrapState(key: string, value: string): void {
  ensureTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO bootstrap_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function isOnboardingCompleted(): boolean {
  return getBootstrapState('onboarding.completed') === 'true';
}

/**
 * Clear all bootstrap_state entries, resetting onboarding state.
 */
export function resetOnboardingState(): void {
  ensureTable();
  const db = getDb();
  db.prepare('DELETE FROM bootstrap_state').run();
}
