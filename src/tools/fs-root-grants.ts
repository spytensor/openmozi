import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { getConfigPath } from '../paths.js';
import { loadConfig } from '../config/index.js';
import { readConfigWithLegacyFallback, writeConfigObject, type RawConfigObject } from '../config/storage.js';
import {
  expandHome,
  getFsPolicy,
  getOutputDir,
  getWorkspaceDir,
  isPathInsideRoot,
} from './workspace-policy.js';

export type FsRootTier = 'output' | 'workspace' | 'project';

export interface GrantedProjectRoot {
  path: string;
  label: string;
  granted_at: string;
  bookmark: string | null;
}

export interface FsRootRecord {
  tier: FsRootTier;
  path: string;
  label: string;
  granted_at: string | null;
  bookmark: string | null;
}

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as RawRecord;
}

function ensureRawRecord(parent: RawRecord, key: string): RawRecord {
  const current = parent[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as RawRecord;
  }
  const next: RawRecord = {};
  parent[key] = next;
  return next;
}

function resolveRootPath(path: string): string {
  return resolve(expandHome(path));
}

function sameRoot(a: string, b: string): boolean {
  return resolveRootPath(a) === resolveRootPath(b);
}

function labelForPath(path: string): string {
  return basename(path) || path;
}

function normalizeRawGrant(value: unknown): GrantedProjectRoot | null {
  const record = asRecord(value);
  const path = typeof record.path === 'string' ? record.path : '';
  if (!path) return null;
  const resolvedPath = resolveRootPath(path);
  return {
    path: resolvedPath,
    label: typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : labelForPath(resolvedPath),
    granted_at: typeof record.granted_at === 'string' && record.granted_at.trim()
      ? record.granted_at
      : new Date(0).toISOString(),
    bookmark: typeof record.bookmark === 'string' ? record.bookmark : null,
  };
}

function getRawFsConfig(raw: RawConfigObject): RawRecord {
  const tools = ensureRawRecord(raw, 'tools');
  return ensureRawRecord(tools, 'fs');
}

function getRawStringArray(record: RawRecord, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function getRawGrants(record: RawRecord): GrantedProjectRoot[] {
  const value = record.granted_project_roots;
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRawGrant)
    .filter((grant): grant is GrantedProjectRoot => grant !== null);
}

function writeFsConfig(raw: RawConfigObject): void {
  writeConfigObject(getConfigPath(), raw);
  loadConfig(getConfigPath());
}

function defaultRootPaths(): string[] {
  return [getOutputDir(), getWorkspaceDir()];
}

function isDefaultRoot(path: string): boolean {
  const resolved = resolveRootPath(path);
  return defaultRootPaths().some((root) => sameRoot(resolved, root));
}

function uniqueRootRecords(records: FsRootRecord[]): FsRootRecord[] {
  const seen = new Set<string>();
  const out: FsRootRecord[] = [];
  for (const record of records) {
    const key = resolveRootPath(record.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...record, path: key });
  }
  return out;
}

/**
 * List the logical file-access roots known to Node. This is not an OS sandbox;
 * Track B adds native security-scoped enforcement underneath this allowlist.
 */
export function listFsRoots(): FsRootRecord[] {
  const policy = getFsPolicy();
  const roots: FsRootRecord[] = [
    {
      tier: 'output',
      path: getOutputDir(),
      label: 'Output',
      granted_at: null,
      bookmark: null,
    },
    {
      tier: 'workspace',
      path: getWorkspaceDir(),
      label: 'Workspace',
      granted_at: null,
      bookmark: null,
    },
  ];

  for (const grant of policy.grantedProjectRoots) {
    if (isDefaultRoot(grant.path)) continue;
    roots.push({
      tier: 'project',
      path: grant.path,
      label: grant.label || labelForPath(grant.path),
      granted_at: grant.granted_at,
      bookmark: grant.bookmark,
    });
  }

  for (const root of policy.additionalAllowedRoots) {
    if (isDefaultRoot(root)) continue;
    if (roots.some((existing) => sameRoot(existing.path, root))) continue;
    roots.push({
      tier: 'project',
      path: resolveRootPath(root),
      label: labelForPath(resolveRootPath(root)),
      granted_at: null,
      bookmark: null,
    });
  }

  return uniqueRootRecords(roots);
}

export function validateProjectRootPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error('path is required');
  }
  const resolved = resolveRootPath(trimmed);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`);
  }
  return resolved;
}

export function grantProjectRoot(inputPath: string): GrantedProjectRoot {
  const grantedPath = validateProjectRootPath(inputPath);
  const { config: raw } = readConfigWithLegacyFallback(getConfigPath());
  const fs = getRawFsConfig(raw);
  const additionalRoots = getRawStringArray(fs, 'additional_allowed_roots');
  const grants = getRawGrants(fs);

  if (!additionalRoots.some((root) => sameRoot(root, grantedPath))) {
    additionalRoots.push(grantedPath);
  }

  const existingGrant = grants.find((grant) => sameRoot(grant.path, grantedPath));
  const grant = existingGrant ?? {
    path: grantedPath,
    label: labelForPath(grantedPath),
    granted_at: new Date().toISOString(),
    bookmark: null,
  };

  const nextGrants = [
    ...grants.filter((existing) => !sameRoot(existing.path, grantedPath)),
    grant,
  ];

  fs.additional_allowed_roots = additionalRoots;
  fs.granted_project_roots = nextGrants;
  writeFsConfig(raw);
  return grant;
}

export function revokeProjectRoot(inputPath: string): boolean {
  const revokedPath = resolveRootPath(inputPath);
  const { config: raw } = readConfigWithLegacyFallback(getConfigPath());
  const fs = getRawFsConfig(raw);
  const additionalRoots = getRawStringArray(fs, 'additional_allowed_roots');
  const grants = getRawGrants(fs);

  const nextAdditionalRoots = additionalRoots.filter((root) => !sameRoot(root, revokedPath));
  const nextGrants = grants.filter((grant) => !sameRoot(grant.path, revokedPath));
  const changed = nextAdditionalRoots.length !== additionalRoots.length || nextGrants.length !== grants.length;

  fs.additional_allowed_roots = nextAdditionalRoots;
  fs.granted_project_roots = nextGrants;
  writeFsConfig(raw);
  return changed;
}

export function isPathAllowedByFsRoots(path: string): boolean {
  const resolved = resolveRootPath(path);
  return listFsRoots().some((root) => isPathInsideRoot(resolved, root.path));
}
