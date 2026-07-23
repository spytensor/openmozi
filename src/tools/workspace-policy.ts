import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { getConfig } from '../config/index.js';
import { getDefaultOutputDir } from '../paths.js';
import { ensureUserWorkspace, getUserWorkspacePath } from '../sandbox/workspace.js';

export interface FsProjectRootGrant {
  path: string;
  label: string;
  granted_at: string;
  bookmark: string | null;
}

export interface FsWorkspacePolicy {
  workspaceOnly: boolean;
  allowProjectRootRead: boolean;
  additionalAllowedRoots: string[];
  grantedProjectRoots: FsProjectRootGrant[];
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

const LEGACY_SINGLE_USER_IDS = new Set(['', 'default', 'local-user']);

function normalizeUserId(userId?: string | null): string {
  return (userId ?? '').trim();
}

export function isLegacySingleUserWorkspace(userId?: string | null): boolean {
  return LEGACY_SINGLE_USER_IDS.has(normalizeUserId(userId));
}

/**
 * Resolve the workspace directory from config, expanding ~ to home.
 */
export function getWorkspaceDir(userId?: string | null): string {
  if (!isLegacySingleUserWorkspace(userId)) {
    return getUserWorkspacePath(normalizeUserId(userId));
  }

  const dir = getConfig().workspace.dir;
  const resolved = dir.startsWith('~/') || dir === '~'
    ? resolve(homedir(), dir.slice(2) || '.')
    : resolve(dir);
  ensureDir(resolved);
  return resolved;
}

export async function ensureToolWorkspaceDir(userId?: string | null): Promise<string> {
  if (isLegacySingleUserWorkspace(userId)) {
    return getWorkspaceDir(userId);
  }
  return ensureUserWorkspace(normalizeUserId(userId));
}

/**
 * Default output directory for generated artifacts and intermediate files.
 */
export function getOutputDir(): string {
  const resolved = resolve(expandHome(getDefaultOutputDir()));
  ensureDir(resolved);
  return resolved;
}

export function expandHome(userPath: string): string {
  const normalized = userPath
    .replace(/^～\//, '~/')
    .replace(/^～\\/, '~\\')
    .replace(/^～$/, '~');

  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    return normalized.replace(/^~\//, homedir() + '/').replace(/^~\\/, homedir() + '\\');
  }
  if (normalized === '~') {
    return homedir();
  }
  return normalized;
}

export function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function childPathWithinRoot(targetPath: string, rootPath: string): string | null {
  const childPath = relative(resolve(rootPath), resolve(targetPath));
  if (childPath === '') return '';
  if (childPath.startsWith('..') || isAbsolute(childPath)) return null;
  return childPath;
}

/**
 * Translate paths persisted by the Docker runtime into the equivalent path in
 * the current MOZI home. Callers must still apply their normal allow-list.
 */
export function resolvePersistedRuntimePath(inputPath: string, userId?: string | null): string | null {
  if (!inputPath.trim() || !isAbsolute(inputPath)) return null;
  const normalized = resolve(inputPath);
  const outputChild = childPathWithinRoot(normalized, '/data/output');
  if (outputChild !== null) return resolve(getOutputDir(), outputChild);

  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId || /[\\/]/.test(normalizedUserId)) return null;
  const containerUserRoot = resolve('/data/workspace/users', normalizedUserId);
  const workspaceChild = childPathWithinRoot(normalized, containerUserRoot);
  if (workspaceChild === null) return null;
  return resolve(getWorkspaceDir(normalizedUserId), workspaceChild);
}

/**
 * Get effective filesystem policy from config.
 */
export function getFsPolicy(): FsWorkspacePolicy {
  const fs = getConfig().tools.fs;
  const grants = fs.granted_project_roots ?? [];
  return {
    workspaceOnly: fs.workspace_only,
    allowProjectRootRead: fs.allow_project_root_read,
    additionalAllowedRoots: fs.additional_allowed_roots.map((root: string) => resolve(expandHome(root))),
    grantedProjectRoots: grants.map((grant: FsProjectRootGrant) => ({
      ...grant,
      path: resolve(expandHome(grant.path)),
    })),
  };
}

export function getWorkspaceAllowedRoots(userId?: string | null): string[] {
  const outputDir = getOutputDir();
  const workspaceDir = getWorkspaceDir(userId);
  const { additionalAllowedRoots, grantedProjectRoots } = getFsPolicy();
  const roots = [
    outputDir,
    workspaceDir,
    ...additionalAllowedRoots,
    ...grantedProjectRoots.map((grant) => grant.path),
  ];
  return [...new Set(roots.map((root) => resolve(root)))];
}

export function ensureWorkspaceFileRoots(): void {
  getOutputDir();
  getWorkspaceDir();
}
