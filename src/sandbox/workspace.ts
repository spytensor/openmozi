/**
 * Per-user isolated workspace directories (#240)
 *
 * Ensures each user has an isolated working directory for shell execution.
 * Path traversal is rejected at creation and resolution time.
 *
 * Base path: MOZI_WORKSPACES env var, or ~/.mozi/workspace/users
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join, resolve, normalize } from 'node:path';
import pino from 'pino';
import { getMoziHome } from '../paths.js';

const logger = pino({ name: 'mozi:sandbox:workspace' });

// ---------------------------------------------------------------------------
// Base path
// ---------------------------------------------------------------------------

/** Resolve the workspace base directory (never returns a trailing slash). */
export function getWorkspacesBase(): string {
  if (process.env.MOZI_WORKSPACES) {
    return resolve(process.env.MOZI_WORKSPACES);
  }
  return resolve(join(getMoziHome(), 'workspace', 'users'));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_USER_ID = /^[\w.-]{1,128}$/;

/**
 * Validate a userId to prevent path traversal and injection.
 * @throws if userId contains path separators or dangerous characters.
 */
function validateUserId(userId: string): void {
  if (!userId || !VALID_USER_ID.test(userId)) {
    throw new Error(
      `Invalid userId "${userId}": must be 1-128 characters of [a-zA-Z0-9._-]`,
    );
  }
  // Extra guard against OS-level tricks
  if (userId.includes('/') || userId.includes('\\') || userId.includes('..')) {
    throw new Error(`Path traversal detected in userId: "${userId}"`);
  }
}

/**
 * Ensure the resolved path is still under the base directory.
 * @throws if the path escapes the base.
 */
function assertUnderBase(base: string, candidate: string): void {
  const normalized = normalize(candidate);
  if (!normalized.startsWith(base + '/') && normalized !== base) {
    throw new Error(
      `Path traversal detected: "${candidate}" is not under base "${base}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Ensure the workspace directory for `userId` exists with permissions 0700.
 * Creates parent directories as needed.
 * Returns the absolute path.
 */
export async function ensureUserWorkspace(userId: string): Promise<string> {
  validateUserId(userId);
  const base = getWorkspacesBase();
  const wsPath = join(base, userId);
  assertUnderBase(base, wsPath);

  mkdirSync(wsPath, { recursive: true });
  await chmod(wsPath, 0o700);

  logger.debug({ userId, path: wsPath }, 'workspace ensured');
  return wsPath;
}

/**
 * Return the absolute workspace path for `userId` without creating it.
 * Validates the userId to prevent path traversal.
 * @throws if userId is invalid or would escape the base.
 */
export function getUserWorkspacePath(userId: string): string {
  validateUserId(userId);
  const base = getWorkspacesBase();
  const wsPath = join(base, userId);
  assertUnderBase(base, wsPath);
  return wsPath;
}

/**
 * Remove the workspace directory for `userId`.
 * Safe to call even if the workspace doesn't exist.
 * Returns true if something was removed, false if it didn't exist.
 */
export function cleanupUserWorkspace(userId: string): boolean {
  validateUserId(userId);
  const base = getWorkspacesBase();
  const wsPath = join(base, userId);
  assertUnderBase(base, wsPath);

  if (!existsSync(wsPath)) return false;

  rmSync(wsPath, { recursive: true, force: true });
  logger.debug({ userId, path: wsPath }, 'workspace cleaned up');
  return true;
}
