import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'mozi:capability:filesystem' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FsOptions {
  allowed_paths?: string[];  // Whitelist of allowed path prefixes
}

export interface FileInfo {
  path: string;
  name: string;
  is_directory: boolean;
  size: number;
  modified_at: string;
}

export interface WriteSnapshot {
  path: string;
  existed: boolean;
  hash_before: string | null;
  content_before: string | null;
}

// ---------------------------------------------------------------------------
// Path restriction
// ---------------------------------------------------------------------------

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedRoot = resolve(rootPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertPathAllowed(filePath: string, allowedPaths?: string[]): void {
  if (!allowedPaths || allowedPaths.length === 0) return;

  const allowed = allowedPaths.some(ap => isPathInsideRoot(filePath, ap));

  if (!allowed) {
    throw new Error(`Path not allowed: ${filePath}. Allowed paths: ${allowedPaths.join(', ')}`);
  }
}

/** Compute SHA-256 hash of file contents */
export function fileHash(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a file's contents as UTF-8 string */
export function read(filePath: string, options: FsOptions = {}): string {
  assertPathAllowed(filePath, options.allowed_paths);
  return readFileSync(filePath, 'utf-8');
}

/**
 * Write content to a file. Creates parent directories if needed.
 * Returns a pre-write snapshot for checkpoint support.
 */
export function write(filePath: string, content: string, options: FsOptions = {}): WriteSnapshot {
  assertPathAllowed(filePath, options.allowed_paths);

  // Capture pre-write snapshot
  const snapshot: WriteSnapshot = {
    path: filePath,
    existed: existsSync(filePath),
    hash_before: fileHash(filePath),
    content_before: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
  };

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');

  logger.debug({ path: filePath, existed: snapshot.existed }, 'File written');
  return snapshot;
}

/**
 * Append content to a file using OS-level appendFileSync (concurrency-safe).
 * Creates parent directories and the file if needed.
 * Returns a pre-write snapshot for checkpoint support.
 */
export function append(filePath: string, content: string, options: FsOptions = {}): WriteSnapshot {
  assertPathAllowed(filePath, options.allowed_paths);

  // Capture pre-write snapshot
  const snapshot: WriteSnapshot = {
    path: filePath,
    existed: existsSync(filePath),
    hash_before: fileHash(filePath),
    content_before: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
  };

  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, content, 'utf-8');

  logger.debug({ path: filePath, existed: snapshot.existed }, 'File appended');
  return snapshot;
}

/** List files and directories at a path */
export function list(dirPath: string, options: FsOptions = {}): FileInfo[] {
  assertPathAllowed(dirPath, options.allowed_paths);

  const entries = readdirSync(dirPath, { withFileTypes: true });
  return entries.map((entry) => {
    const fullPath = resolve(dirPath, entry.name);
    const stat = statSync(fullPath);
    return {
      path: fullPath,
      name: entry.name,
      is_directory: entry.isDirectory(),
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
  });
}

/** Search for files matching a pattern (simple glob-like: supports * wildcard) */
export function search(
  dirPath: string,
  pattern: string,
  options: FsOptions & { recursive?: boolean } = {}
): string[] {
  assertPathAllowed(dirPath, options.allowed_paths);

  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const results: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (regex.test(entry.name)) {
        results.push(fullPath);
      }
      if (entry.isDirectory() && options.recursive !== false) {
        walk(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

/** Delete a file */
export function remove(filePath: string, options: FsOptions = {}): WriteSnapshot {
  assertPathAllowed(filePath, options.allowed_paths);

  const snapshot: WriteSnapshot = {
    path: filePath,
    existed: existsSync(filePath),
    hash_before: fileHash(filePath),
    content_before: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
  };

  if (snapshot.existed) {
    unlinkSync(filePath);
    logger.debug({ path: filePath }, 'File deleted');
  }

  return snapshot;
}
