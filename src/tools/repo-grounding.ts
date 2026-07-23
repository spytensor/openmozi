import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  getProjectRoot,
  getWorkspaceDir,
  resolveReadPath,
  stripWorkspacePrefix,
  expandHome,
} from './tool-utils.js';
import type { RepoInspectionState } from './types.js';

export interface RepoGroundingResult {
  resolvedPath?: string;
  reason: 'exact' | 'import_follow' | 'repo_lookup' | 'ambiguous' | 'missing';
  guidance?: string;
  candidates?: string[];
}

const IMPORT_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

const SEARCH_SKIP_DIRS = new Set([
  '.git',
  '.claude',
  '.codex',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.tasks',
  'tmp',
]);

const REPO_ROOT_HINTS = [
  'src/',
  'src\\',
  'docs/',
  'docs\\',
  'scripts/',
  'scripts\\',
  'bootstrap/',
  'bootstrap\\',
  'bootstrapskills/',
  'bootstrapskills\\',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'SOUL.md',
] as const;

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[a.length][b.length];
}

/**
 * The project root reads/inspection should ground against: the session's
 * SELECTED project (context.workspaceRootPath) when set, else the global
 * runtime root. Threading this makes reads project-aware, symmetric with the
 * write path — without it "read the project" reads the App Support workspace.
 */
function effectiveProjectRoot(projectRoot?: string): string {
  return projectRoot?.trim() ? resolve(projectRoot.trim()) : resolve(getProjectRoot());
}

function stripRepoRootPrefix(requestedPath: string, projectRoot?: string): string | null {
  const normalized = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;

  const projectName = basename(effectiveProjectRoot(projectRoot)).toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const projectIndex = segments.findIndex((segment) => segment.toLowerCase() === projectName);
  if (projectIndex >= 0 && projectIndex < segments.length - 1) {
    return segments.slice(projectIndex + 1).join('/');
  }

  if (segments.length >= 2 && segments[0] === 'repos') {
    return segments.slice(2).join('/');
  }

  return null;
}

function normalizeRequestedPath(requestedPath: string, userId?: string): string {
  return stripWorkspacePrefix(expandHome(requestedPath), userId).replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function requestedPathVariants(requestedPath: string, projectRoot?: string): string[] {
  const base = normalizeRequestedPath(requestedPath);
  const stripped = stripRepoRootPrefix(base, projectRoot);
  return Array.from(new Set([base, stripped].filter((value): value is string => Boolean(value && value.trim()))));
}

export function looksLikeRepoPath(requestedPath: string, projectRoot?: string): boolean {
  const normalized = normalizeRequestedPath(requestedPath);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (REPO_ROOT_HINTS.some((hint) => lower === hint.toLowerCase() || lower.startsWith(hint.toLowerCase()))) {
    return true;
  }
  if (lower.includes('/src/') || lower.endsWith('/src')) return true;
  if (lower.includes('/docs/') || lower.endsWith('/docs')) return true;
  if (lower.includes('/scripts/') || lower.endsWith('/scripts')) return true;
  if (lower.includes('/repos/')) return true;
  return lower.includes(`/${basename(effectiveProjectRoot(projectRoot)).toLowerCase()}/`);
}

export function maybeEnableRepoInspection(state: RepoInspectionState | undefined, requestedPath: string, projectRoot?: string): void {
  if (!state) return;
  if (state.enabled) return;
  if (looksLikeRepoPath(requestedPath, projectRoot)) {
    state.enabled = true;
  }
}

function formatCandidateList(paths: string[]): string {
  return paths.slice(0, 5).map(path => `- ${path}`).join('\n');
}

function createGuidance(prefix: string, candidates?: string[]): string {
  if (!candidates || candidates.length === 0) {
    return `${prefix} Use list_directory or follow imports to ground the real module path before retrying read_file.`;
  }
  return `${prefix}\nCandidate matches:\n${formatCandidateList(candidates)}\nUse one of these grounded paths or list the containing directory before retrying read_file.`;
}

function walkFiles(root: string, acc: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SEARCH_SKIP_DIRS.has(entry)) continue;
    const fullPath = join(root, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walkFiles(fullPath, acc);
      continue;
    }
    if (stats.isFile()) {
      acc.push(fullPath);
    }
  }
}

function walkDirectories(root: string, acc: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SEARCH_SKIP_DIRS.has(entry)) continue;
    const fullPath = join(root, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    acc.push(fullPath);
    walkDirectories(fullPath, acc);
  }
}

function getSearchRoots(userId?: string, projectRoot?: string): string[] {
  const root = effectiveProjectRoot(projectRoot);
  const workspaceRoot = resolve(getWorkspaceDir(userId));
  return Array.from(new Set([
    root,
    workspaceRoot,
  ]));
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(resolved);
  }
  return unique;
}

function scoreCandidate(candidatePath: string, requestedPath: string, state: RepoInspectionState): number {
  const normalizedCandidate = candidatePath.replace(/\\/g, '/');
  const requested = requestedPath.replace(/\\/g, '/');
  const requestedBase = basename(requested);
  const requestedNoExt = requestedBase.slice(0, requestedBase.length - extname(requestedBase).length);
  const candidateBase = basename(normalizedCandidate);
  const candidateNoExt = candidateBase.slice(0, candidateBase.length - extname(candidateBase).length);
  let score = 0;

  if (normalizedCandidate.endsWith(`/${requested}`) || normalizedCandidate === requested) score += 6;
  if (candidateBase === requestedBase) score += 4;
  if (requestedNoExt && candidateNoExt === requestedNoExt) score += 2;
  if (requestedBase && editDistance(candidateBase.toLowerCase(), requestedBase.toLowerCase()) <= 2) score += 2;
  if (requestedNoExt && editDistance(candidateNoExt.toLowerCase(), requestedNoExt.toLowerCase()) <= 2) score += 1;
  if (state.lastReadFilePath && dirname(state.lastReadFilePath) === dirname(candidatePath)) score += 2;
  for (const groundedDir of state.groundedDirectories) {
    const normalizedGroundedDir = groundedDir.replace(/\\/g, '/');
    if (normalizedCandidate.startsWith(`${normalizedGroundedDir}/`) || normalizedCandidate === normalizedGroundedDir) {
      score += 2;
    }
  }
  if (state.groundedPaths.has(candidatePath)) score += 3;

  return score;
}

function resolveImportFollowCandidate(requestedPath: string, state: RepoInspectionState): string | null {
  if (!state.lastReadFilePath) return null;
  if (!requestedPath.startsWith('./') && !requestedPath.startsWith('../')) return null;

  const baseDir = dirname(state.lastReadFilePath);
  for (const suffix of IMPORT_EXTENSIONS) {
    const candidate = resolve(baseDir, `${requestedPath}${suffix}`);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function resolveExactProjectCandidate(requestedPath: string, expectedKind: 'file' | 'directory', projectRoot?: string): string | null {
  for (const variant of requestedPathVariants(requestedPath, projectRoot)) {
    const candidate = resolve(effectiveProjectRoot(projectRoot), variant);
    if (!existsSync(candidate)) continue;
    try {
      const stats = statSync(candidate);
      if (expectedKind === 'file' && stats.isFile()) return candidate;
      if (expectedKind === 'directory' && stats.isDirectory()) return candidate;
    } catch {
      // ignore stat race
    }
  }
  return null;
}

function searchRepoForCandidates(requestedPath: string, state: RepoInspectionState, userId?: string, projectRoot?: string): string[] {
  const variants = requestedPathVariants(requestedPath, projectRoot);
  const matchPaths = (files: string[]): string[] => files.filter((filePath) => {
    const normalizedFile = filePath.replace(/\\/g, '/');
    const fileBase = basename(normalizedFile);
    const fileNoExt = fileBase.slice(0, fileBase.length - extname(fileBase).length);
    return variants.some((requested) => {
      const requestedBase = basename(requested);
      const requestedNoExt = requestedBase.slice(0, requestedBase.length - extname(requestedBase).length);
      return normalizedFile.endsWith(`/${requested}`)
        || normalizedFile === requested
        || fileBase === requestedBase
        || (requestedNoExt.length > 0 && fileNoExt === requestedNoExt)
        || editDistance(fileBase.toLowerCase(), requestedBase.toLowerCase()) <= 2
        || (requestedNoExt.length > 0 && editDistance(fileNoExt.toLowerCase(), requestedNoExt.toLowerCase()) <= 2);
    });
  });

  const [searchProjectRoot, ...fallbackRoots] = getSearchRoots(userId, projectRoot);
  const projectFiles: string[] = [];
  walkFiles(searchProjectRoot, projectFiles);
  const projectMatches = dedupePaths(matchPaths(projectFiles));
  if (projectMatches.length > 0) {
    projectMatches.sort((a, b) => scoreCandidate(b, variants[0] ?? requestedPath, state) - scoreCandidate(a, variants[0] ?? requestedPath, state));
    return projectMatches;
  }

  const fallbackFiles: string[] = [];
  for (const root of fallbackRoots) {
    walkFiles(root, fallbackFiles);
  }
  const uniqueMatches = dedupePaths(matchPaths(fallbackFiles));
  uniqueMatches.sort((a, b) => scoreCandidate(b, variants[0] ?? requestedPath, state) - scoreCandidate(a, variants[0] ?? requestedPath, state));
  return uniqueMatches;
}

function searchRepoForDirectoryCandidates(requestedPath: string, state: RepoInspectionState, userId?: string, projectRoot?: string): string[] {
  const variants = requestedPathVariants(requestedPath, projectRoot);
  const matchPaths = (directories: string[]): string[] => directories.filter((dirPath) => {
    const normalizedDir = dirPath.replace(/\\/g, '/');
    const dirBase = basename(normalizedDir);
    return variants.some((requested) => {
      const normalizedRequested = requested.replace(/\\/g, '/');
      const requestedBase = basename(normalizedRequested);
      return normalizedDir.endsWith(`/${normalizedRequested}`)
        || normalizedDir === normalizedRequested
        || dirBase === requestedBase;
    });
  });

  const [searchProjectRoot, ...fallbackRoots] = getSearchRoots(userId, projectRoot);
  const projectDirs: string[] = [searchProjectRoot];
  walkDirectories(searchProjectRoot, projectDirs);
  const projectMatches = dedupePaths(matchPaths(projectDirs));
  if (projectMatches.length > 0) {
    projectMatches.sort((a, b) => scoreCandidate(b, variants[0] ?? requestedPath, state) - scoreCandidate(a, variants[0] ?? requestedPath, state));
    return projectMatches;
  }

  const fallbackDirs: string[] = [];
  for (const root of fallbackRoots) {
    fallbackDirs.push(root);
    walkDirectories(root, fallbackDirs);
  }
  const fallbackMatches = dedupePaths(matchPaths(fallbackDirs));
  fallbackMatches.sort((a, b) => scoreCandidate(b, variants[0] ?? requestedPath, state) - scoreCandidate(a, variants[0] ?? requestedPath, state));
  return fallbackMatches;
}

export function createRepoInspectionState(enabled: boolean): RepoInspectionState {
  return {
    enabled,
    groundedPaths: new Set<string>(),
    groundedDirectories: new Set<string>(),
  };
}

export function recordGroundedDirectory(state: RepoInspectionState | undefined, path: string): void {
  if (!state?.enabled) return;
  state.groundedDirectories.add(resolve(path));
}

export function recordGroundedRead(state: RepoInspectionState | undefined, path: string): void {
  if (!state?.enabled) return;
  const resolvedPath = resolve(path);
  state.groundedPaths.add(resolvedPath);
  state.groundedDirectories.add(dirname(resolvedPath));
  state.lastReadFilePath = resolvedPath;
}

export function resolveInspectionReadPath(
  requestedPath: string,
  state: RepoInspectionState | undefined,
  userId?: string,
  projectRoot?: string,
): RepoGroundingResult {
  if (!state?.enabled) {
    return {
      resolvedPath: resolveReadPath(requestedPath, userId, projectRoot),
      reason: 'exact',
    };
  }

  const exactProject = resolveExactProjectCandidate(requestedPath, 'file', projectRoot);
  if (exactProject) {
    return { resolvedPath: exactProject, reason: 'exact' };
  }

  const exactResolved = resolveReadPath(requestedPath, userId, projectRoot);
  if (existsSync(exactResolved)) {
    return { resolvedPath: exactResolved, reason: 'exact' };
  }

  const importFollowRequested = stripWorkspacePrefix(expandHome(requestedPath), userId).replace(/\\/g, '/').trim();
  const normalizedRequested = normalizeRequestedPath(requestedPath, userId);
  const importFollow = resolveImportFollowCandidate(importFollowRequested, state);
  if (importFollow) {
    return { resolvedPath: importFollow, reason: 'import_follow' };
  }

  const candidates = searchRepoForCandidates(normalizedRequested, state, userId, projectRoot);
  if (candidates.length === 1) {
    return { resolvedPath: candidates[0], reason: 'repo_lookup' };
  }

  if (candidates.length > 1) {
    const candidateLabels = candidates.map(candidate => {
      const root = getSearchRoots(userId, projectRoot).find(searchRoot => candidate.startsWith(searchRoot));
      return root ? relative(root, candidate).replace(/\\/g, '/') : candidate;
    });
    return {
      reason: 'ambiguous',
      candidates: candidateLabels,
      guidance: createGuidance(
        `Inspection mode could not safely choose a single grounded path for "${requestedPath}".`,
        candidateLabels,
      ),
    };
  }

  return {
    reason: 'missing',
    guidance: createGuidance(
      `Inspection mode could not ground "${requestedPath}" to a real file in the repo.`,
    ),
  };
}

export function resolveInspectionDirectoryPath(
  requestedPath: string,
  state: RepoInspectionState | undefined,
  userId?: string,
  projectRoot?: string,
): RepoGroundingResult {
  if (!state?.enabled) {
    const resolved = resolveReadPath(requestedPath, userId, projectRoot);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return { resolvedPath: resolved, reason: 'exact' };
    }
    return {
      reason: 'missing',
      guidance: createGuidance(
        `Could not ground directory path "${requestedPath}" to a real directory.`,
      ),
    };
  }

  const variants = requestedPathVariants(requestedPath, projectRoot);
  const exactProject = resolveExactProjectCandidate(requestedPath, 'directory', projectRoot);
  if (exactProject) {
    return { resolvedPath: exactProject, reason: 'exact' };
  }

  for (const variant of variants) {
    const resolved = resolveReadPath(variant, userId, projectRoot);
    if (existsSync(resolved)) {
      try {
        if (statSync(resolved).isDirectory()) {
          return { resolvedPath: resolved, reason: 'exact' };
        }
      } catch {
        // ignore stat race
      }
    }
  }

  const candidates = searchRepoForDirectoryCandidates(requestedPath, state, userId, projectRoot);
  if (candidates.length === 1) {
    return { resolvedPath: candidates[0], reason: 'repo_lookup' };
  }

  if (candidates.length > 1) {
    const candidateLabels = candidates.map(candidate => {
      const root = getSearchRoots(userId, projectRoot).find(searchRoot => candidate.startsWith(searchRoot));
      return root ? relative(root, candidate).replace(/\\/g, '/') : candidate;
    });
    return {
      reason: 'ambiguous',
      candidates: candidateLabels,
      guidance: createGuidance(
        `Inspection mode could not safely choose a single grounded directory for "${requestedPath}".`,
        candidateLabels,
      ),
    };
  }

  return {
    reason: 'missing',
    guidance: createGuidance(
      `Inspection mode could not ground "${requestedPath}" to a real directory in the repo.`,
    ),
  };
}
