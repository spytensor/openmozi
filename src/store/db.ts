import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDbPath } from '../paths.js';

let db: Database.Database | null = null;

/** Get the singleton database instance */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/** Initialize SQLite database with WAL mode */
export function initDb(dbPath = getDbPath()): Database.Database {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Enable incremental auto_vacuum for data retention disk reclamation
  const currentAutoVacuum = db.pragma('auto_vacuum', { simple: true });
  if (currentAutoVacuum === 0) {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
  }
  return db;
}

/** Close the database connection */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Determines whether a database error is fatal and should terminate the process.
 * Fatal errors include disk full, permission denied, I/O errors, and corruption.
 */
export function isDatabaseFatalError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('sqlite_ioerr') ||
    msg.includes('sqlite_full') ||
    msg.includes('sqlite_corrupt') ||
    msg.includes('sqlite_cantopen') ||
    msg.includes('sqlite_readonly') ||
    msg.includes('enospc') ||
    msg.includes('eacces') ||
    msg.includes('disk i/o error') ||
    msg.includes('database disk image is malformed')
  );
}
