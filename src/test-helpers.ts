/**
 * Shared test helpers for MOZI tests.
 * Provides temp DB setup/teardown and temp dir utilities.
 */
import { initDb, closeDb } from './store/db.js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, 'store', 'schema.sql');

/** Set up a temp SQLite DB with full schema. Call closeDb() first if needed. */
export function setupTestDb(): { dbPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mozi-test-'));
  const dbPath = join(tmpDir, 'test.db');
  closeDb();
  const db = initDb(dbPath);
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
  return { dbPath, tmpDir };
}

/** Tear down: close DB and remove temp dir */
export function teardownTestDb(tmpDir: string): void {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Create a temp directory for test files */
export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mozi-test-'));
}

/** Remove a temp directory */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}
