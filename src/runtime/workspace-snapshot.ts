import { existsSync, openSync, readFileSync, statSync, closeSync, readSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getConfig } from '../config/index.js';
import { getDb } from '../store/db.js';
import {
  getConfigPath,
  getDbPath,
  getLegacyMoziHome,
  getHeartbeatPath,
  getLogPath,
  getMoziHome,
  getPidPath,
} from '../paths.js';
import { getRuntimeProjectRoot } from './project-root.js';
import { getFsPolicy, getOutputDir, getWorkspaceAllowedRoots } from '../tools/workspace-policy.js';

type RootKind = 'mozi_home' | 'workspace' | 'allowed_root' | 'project_root' | 'output';

const LEGACY_MIGRATION_MARKERS = [
  '.env',
  '.master-key',
  'jwt-secret',
  'secrets.enc',
  'mozi.json',
  'config.yaml',
  'data',
  'logs',
  'workspace',
  'skills',
  'agents',
  'memory',
  'tasks',
];

export interface RuntimeWorkspaceRoot {
  id: string;
  kind: RootKind;
  label: string;
  path: string;
  exists: boolean;
  /**
   * Whether the file API (`/api/fs/list`) can actually serve this root. The
   * snapshot advertises more roots than are browsable (e.g. the runtime source
   * directory, which in a packaged build points at app internals). A Files
   * scope must be listable, so consumers that browse — as opposed to those that
   * only carry a root as message context — filter on this. Truth is the same
   * allow-list the list endpoint validates against.
   */
  browsable: boolean;
  git?: {
    is_repo: boolean;
    branch?: string;
    /** Short SHA when HEAD is detached (no branch). */
    detached_sha?: string;
  };
}

export interface RuntimeWorkspaceSnapshot {
  generated_at: string;
  mozi_home: {
    path: string;
    exists: boolean;
  };
  config: {
    path: string;
    exists: boolean;
    server: {
      host?: string;
      port?: number;
      auth_mode?: string;
    };
    workspace_dir: string;
    workspace_dir_resolved: string;
  };
  storage: {
    db_path: string;
    db_exists: boolean;
    db_size_bytes: number;
    log_path: string;
    log_exists: boolean;
    log_size_bytes: number;
    heartbeat_path: string;
    heartbeat_exists: boolean;
    pid_path: string;
    pid_exists: boolean;
  };
  migration: {
    legacy_home_path: string;
    legacy_home_exists: boolean;
    target_home_path: string;
    manifest_path: string;
    manifest_exists: boolean;
    conflict: boolean;
  };
  roots: RuntimeWorkspaceRoot[];
  counts: {
    sessions: number;
    conversations: number;
    memory_facts: number;
    session_digests: number;
    skills: number;
    active_tasks: number;
    worker_jobs: number;
    background_tasks: number;
  };
  runtime: {
    tasks_by_status: Record<string, number>;
    worker_jobs_by_status: Record<string, number>;
    background_tasks_by_status: Record<string, number>;
  };
}

export interface RuntimeLogSnapshot {
  path: string;
  exists: boolean;
  size_bytes: number;
  truncated: boolean;
  lines: string[];
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function hasLegacyMigrationMarker(home: string): boolean {
  return LEGACY_MIGRATION_MARKERS.some((marker) => existsSync(join(home, marker)));
}

function safeCount(table: string, where = '1 = 1', args: unknown[] = []): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...args) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function countByStatus(table: string, tenantId: string): Record<string, number> {
  try {
    const rows = getDb()
      .prepare(`SELECT status, COUNT(*) AS count FROM ${table} WHERE tenant_id = ? GROUP BY status ORDER BY status`)
      .all(tenantId) as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  } catch {
    return {};
  }
}

function gitInfo(path: string): RuntimeWorkspaceRoot['git'] {
  const gitPath = join(path, '.git');
  if (!existsSync(gitPath)) return { is_repo: false };
  try {
    const stat = lstatSync(gitPath);
    let gitDir = gitPath;
    if (stat.isFile()) {
      const content = readFileSync(gitPath, 'utf-8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/i);
      if (match) {
        gitDir = resolve(dirname(gitPath), match[1]);
      }
    }
    const headPath = join(gitDir, 'HEAD');
    if (!existsSync(headPath)) return { is_repo: true };
    const head = readFileSync(headPath, 'utf-8').trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    if (match) return { is_repo: true, branch: match[1] };
    // Detached HEAD: the file holds a raw commit SHA — expose a short form
    // so the UI branch chip can render something meaningful.
    const sha = head.match(/^[0-9a-f]{40}/);
    return { is_repo: true, ...(sha ? { detached_sha: head.slice(0, 7) } : {}) };
  } catch {
    return { is_repo: true };
  }
}

function rootRecord(kind: RootKind, label: string, path: string, browsableRoots: Set<string>): RuntimeWorkspaceRoot {
  const resolved = resolve(expandHomePath(path));
  return {
    id: `${kind}:${resolved}`,
    kind,
    label,
    path: resolved,
    exists: existsSync(resolved),
    browsable: browsableRoots.has(resolved),
    git: gitInfo(resolved),
  };
}

function uniqueRoots(roots: RuntimeWorkspaceRoot[]): RuntimeWorkspaceRoot[] {
  const seen = new Set<string>();
  const out: RuntimeWorkspaceRoot[] = [];
  for (const root of roots) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    out.push(root);
  }
  return out;
}

export async function buildRuntimeWorkspaceSnapshot(tenantId = 'default'): Promise<RuntimeWorkspaceSnapshot> {
  const config = getConfig();
  const moziHome = getMoziHome();
  const legacyHome = getLegacyMoziHome();
  const configPath = getConfigPath();
  const dbPath = getDbPath();
  const logPath = getLogPath();
  const workspaceDir = config.workspace.dir;
  const workspaceDirResolved = resolve(expandHomePath(workspaceDir));
  const manifestPath = join(moziHome, '.mozi-desktop-migration.json');
  const legacyHomeExists = existsSync(legacyHome);
  const legacyHomeHasMarkers = legacyHomeExists && hasLegacyMigrationMarker(legacyHome);
  const manifestExists = existsSync(manifestPath);
  const desktopManagedHome = process.env.MOZI_DESKTOP_MANAGED_HOME === '1';
  const migrationConflict =
    resolve(moziHome) !== resolve(legacyHome) &&
    legacyHomeHasMarkers &&
    !manifestExists &&
    (!process.env.MOZI_HOME || desktopManagedHome);
  const skills = await import('../skills/workspace-manager.js')
    .then((mod) => mod.listRuntimeSkills())
    .catch(() => []);
  const fsPolicy = getFsPolicy();
  // The exact allow-list `/api/fs/list` validates against — the single source
  // of truth for which roots are browsable in the Files surface.
  const browsableRoots = new Set(getWorkspaceAllowedRoots().map((root) => resolve(root)));

  const roots = uniqueRoots([
    rootRecord('mozi_home', 'Runtime home', moziHome, browsableRoots),
    // The deliverable shelf. It was always on the fs allow-list (the API served
    // it, #792 defends it) yet never appeared here — so the ONE place MOZI
    // writes finished work had no entry in the Files surface (operator report
    // 2026-07-19).
    rootRecord('output', 'Deliverables', resolve(getOutputDir()), browsableRoots),
    rootRecord('workspace', 'Workspace', workspaceDirResolved, browsableRoots),
    rootRecord('project_root', 'Runtime source', getRuntimeProjectRoot(), browsableRoots),
    ...fsPolicy.grantedProjectRoots.map((grant) =>
      rootRecord('project_root', grant.label, grant.path, browsableRoots),
    ),
    ...fsPolicy.additionalAllowedRoots.map((root, index) =>
      rootRecord('allowed_root', index === 0 ? 'Allowed root' : `Allowed root ${index + 1}`, root, browsableRoots),
    ),
  ]);

  const workerJobsByStatus = countByStatus('external_worker_jobs', tenantId);
  const backgroundTasksByStatus = countByStatus('background_tasks', tenantId);
  const tasksByStatus = countByStatus('tasks', tenantId);

  return {
    generated_at: new Date().toISOString(),
    mozi_home: {
      path: moziHome,
      exists: existsSync(moziHome),
    },
    config: {
      path: configPath,
      exists: existsSync(configPath),
      server: {
        host: config.server.host,
        port: config.server.port,
        auth_mode: config.server.auth_mode,
      },
      workspace_dir: workspaceDir,
      workspace_dir_resolved: workspaceDirResolved,
    },
    storage: {
      db_path: dbPath,
      db_exists: existsSync(dbPath),
      db_size_bytes: fileSize(dbPath),
      log_path: logPath,
      log_exists: existsSync(logPath),
      log_size_bytes: fileSize(logPath),
      heartbeat_path: getHeartbeatPath(),
      heartbeat_exists: existsSync(getHeartbeatPath()),
      pid_path: getPidPath(),
      pid_exists: existsSync(getPidPath()),
    },
    migration: {
      legacy_home_path: legacyHome,
      legacy_home_exists: legacyHomeExists,
      target_home_path: moziHome,
      manifest_path: manifestPath,
      manifest_exists: manifestExists,
      conflict: migrationConflict,
    },
    roots,
    counts: {
      sessions: safeCount('sessions', 'tenant_id = ?', [tenantId]),
      conversations: safeCount('conversations', 'tenant_id = ?', [tenantId]),
      memory_facts: safeCount('memory_facts', 'tenant_id = ?', [tenantId]),
      session_digests: safeCount('session_digests', 'tenant_id = ?', [tenantId]),
      skills: skills.length,
      active_tasks: Object.entries(tasksByStatus)
        .filter(([status]) => ['pending', 'ready', 'assigned', 'running'].includes(status))
        .reduce((sum, [, count]) => sum + count, 0),
      worker_jobs: Object.values(workerJobsByStatus).reduce((sum, count) => sum + count, 0),
      background_tasks: Object.values(backgroundTasksByStatus).reduce((sum, count) => sum + count, 0),
    },
    runtime: {
      tasks_by_status: tasksByStatus,
      worker_jobs_by_status: workerJobsByStatus,
      background_tasks_by_status: backgroundTasksByStatus,
    },
  };
}

function readTail(path: string, maxBytes: number): { text: string; truncated: boolean; size: number } {
  if (!existsSync(path)) return { text: '', truncated: false, size: 0 };
  const size = fileSize(path);
  if (size <= maxBytes) {
    return { text: readFileSync(path, 'utf-8'), truncated: false, size };
  }
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    return { text: buffer.toString('utf-8'), truncated: true, size };
  } finally {
    closeSync(fd);
  }
}

export function readRuntimeLogSnapshot(options: { maxLines?: number; maxBytes?: number } = {}): RuntimeLogSnapshot {
  const maxLines = Math.max(1, Math.min(options.maxLines ?? 200, 1000));
  const maxBytes = Math.max(1024, Math.min(options.maxBytes ?? 128 * 1024, 512 * 1024));
  const path = getLogPath();
  const { text, truncated, size } = readTail(path, maxBytes);
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  return {
    path,
    exists: existsSync(path),
    size_bytes: size,
    truncated,
    lines,
  };
}
