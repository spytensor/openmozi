import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type DesktopMigrationStatus = 'not_needed' | 'migrated' | 'target_exists' | 'blocked';

export interface DesktopMigrationResult {
  status: DesktopMigrationStatus;
  sourceHome: string;
  targetHome: string;
  message?: string;
  copiedEntries?: string[];
  backupHome?: string;
  sourceDatabase?: DatabaseMigrationEvidence;
  targetDatabase?: DatabaseMigrationEvidence;
  workspaceDirRewritten?: boolean;
  allowedRootsRewritten?: boolean;
}

export interface DatabaseMigrationEvidence {
  path: string;
  sha256: string;
  integrity: 'ok';
  counts: Record<string, number>;
}

export interface DesktopMigrationOptions {
  targetHome: string;
  legacyHome?: string;
  healthUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  backupRoot?: string;
}

const MANIFEST_NAME = '.mozi-desktop-migration.json';
const MOZI_MARKERS = [
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

function hasAnyMarker(home: string): boolean {
  return MOZI_MARKERS.some((marker) => existsSync(join(home, marker)));
}

function hasAnyEntry(home: string): boolean {
  return existsSync(home) && readdirSync(home).length > 0;
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function isDefaultLegacyWorkspace(value: unknown, legacyHome: string): boolean {
  if (typeof value !== 'string') return false;
  if (value === '~/.mozi/workspace') return true;
  return resolve(expandHome(value)) === resolve(legacyHome, 'workspace');
}

function isDefaultLegacyRoot(value: unknown, legacyHome: string): boolean {
  if (typeof value !== 'string') return false;
  if (value === '~/.mozi') return true;
  return resolve(expandHome(value)) === resolve(legacyHome);
}

function rewriteConfigObject(raw: unknown, targetHome: string, legacyHome: string): {
  value: unknown;
  workspaceDirRewritten: boolean;
  allowedRootsRewritten: boolean;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: raw, workspaceDirRewritten: false, allowedRootsRewritten: false };
  }

  const config = raw as {
    workspace?: { dir?: unknown };
    tools?: { fs?: { additional_allowed_roots?: unknown } };
  };
  let workspaceDirRewritten = false;
  let allowedRootsRewritten = false;

  if (isDefaultLegacyWorkspace(config.workspace?.dir, legacyHome)) {
    config.workspace = { ...(config.workspace ?? {}), dir: join(targetHome, 'workspace') };
    workspaceDirRewritten = true;
  }

  const roots = config.tools?.fs?.additional_allowed_roots;
  if (Array.isArray(roots)) {
    const rewrittenRoots = roots.map((root) => {
      if (isDefaultLegacyRoot(root, legacyHome)) {
        allowedRootsRewritten = true;
        return targetHome;
      }
      return root;
    });
    if (allowedRootsRewritten) {
      config.tools = { ...(config.tools ?? {}), fs: { ...(config.tools?.fs ?? {}), additional_allowed_roots: rewrittenRoots } };
    }
  }

  return { value: config, workspaceDirRewritten, allowedRootsRewritten };
}

function rewriteJsonConfig(configPath: string, targetHome: string, legacyHome: string): {
  workspaceDirRewritten: boolean;
  allowedRootsRewritten: boolean;
} {
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    return { workspaceDirRewritten: false, allowedRootsRewritten: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    const result = rewriteConfigObject(parsed, targetHome, legacyHome);
    if (result.workspaceDirRewritten || result.allowedRootsRewritten) {
      writeFileSync(configPath, `${JSON.stringify(result.value, null, 2)}\n`, { mode: 0o600 });
    }
    return result;
  } catch {
    return { workspaceDirRewritten: false, allowedRootsRewritten: false };
  }
}

function rewriteYamlConfig(configPath: string, targetHome: string, legacyHome: string): {
  workspaceDirRewritten: boolean;
  allowedRootsRewritten: boolean;
} {
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    return { workspaceDirRewritten: false, allowedRootsRewritten: false };
  }
  try {
    const parsed = yaml.load(readFileSync(configPath, 'utf-8'));
    const result = rewriteConfigObject(parsed, targetHome, legacyHome);
    if (result.workspaceDirRewritten || result.allowedRootsRewritten) {
      writeFileSync(configPath, yaml.dump(result.value, { lineWidth: 120 }), { mode: 0o600 });
    }
    return result;
  } catch {
    return { workspaceDirRewritten: false, allowedRootsRewritten: false };
  }
}

function rewriteRuntimeConfigDefaults(configHome: string, targetHome: string, legacyHome: string): {
  workspaceDirRewritten: boolean;
  allowedRootsRewritten: boolean;
} {
  const jsonResult = rewriteJsonConfig(join(configHome, 'mozi.json'), targetHome, legacyHome);
  const yamlResult = rewriteYamlConfig(join(configHome, 'config.yaml'), targetHome, legacyHome);
  return {
    workspaceDirRewritten: jsonResult.workspaceDirRewritten || yamlResult.workspaceDirRewritten,
    allowedRootsRewritten: jsonResult.allowedRootsRewritten || yamlResult.allowedRootsRewritten,
  };
}

async function isRuntimeHealthy(healthUrl: string | undefined, fetchImpl: typeof fetch): Promise<boolean> {
  if (!healthUrl) return false;
  try {
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { ok?: unknown };
    return payload.ok === true;
  } catch {
    return false;
  }
}

function copyLegacyHome(sourceHome: string, targetHome: string): string[] {
  mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  const copied: string[] = [];

  for (const entry of readdirSync(sourceHome)) {
    const source = join(sourceHome, entry);
    const target = join(targetHome, entry);
    if (existsSync(target)) {
      throw new Error(`Cannot migrate ${entry}: target already exists at ${target}`);
    }
    cpSync(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    copied.push(entry);
  }

  return copied;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inspectDatabase(home: string, checkpoint: boolean): DatabaseMigrationEvidence | undefined {
  const path = join(home, 'data', 'mozi.db');
  if (!existsSync(path)) return undefined;

  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    if (checkpoint) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const integrityValues = integrityRows.flatMap((row) => Object.values(row));
    if (integrityValues.length !== 1 || integrityValues[0] !== 'ok') {
      throw new Error(`SQLite integrity check failed for ${path}: ${integrityValues.join(', ') || 'no result'}`);
    }

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const counts: Record<string, number> = {};
    for (const table of ['sessions', 'session_timeline_events', 'memory_facts', 'memory_fact_vectors', 'users', 'tenant_api_keys']) {
      if (!tables.has(table)) continue;
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
      counts[table] = Number(row.count);
    }
    return { path, sha256: sha256(path), integrity: 'ok', counts };
  } finally {
    db.close();
  }
}

export async function prepareDesktopMoziHome(options: DesktopMigrationOptions): Promise<DesktopMigrationResult> {
  const env = options.env ?? process.env;
  const sourceHome = resolve(options.legacyHome ?? join(homedir(), '.mozi'));
  const targetHome = resolve(options.targetHome);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const migratedAt = now();
  const migrationId = migratedAt.toISOString().replace(/[:.]/g, '-');
  const backupRoot = resolve(options.backupRoot ?? join(dirname(targetHome), 'MOZI Migration Backups'));
  const backupHome = join(backupRoot, migrationId);
  const stagingHome = `${targetHome}.migrating-${migrationId}`;

  if (env.MOZI_HOME) {
    return { status: 'not_needed', sourceHome, targetHome, message: 'MOZI_HOME override is active.' };
  }
  if (sourceHome === targetHome) {
    return { status: 'not_needed', sourceHome, targetHome, message: 'Legacy and target homes are identical.' };
  }
  if (!existsSync(sourceHome) || !hasAnyMarker(sourceHome)) {
    return { status: 'not_needed', sourceHome, targetHome, message: 'No legacy MOZI home found.' };
  }
  if (hasAnyEntry(targetHome)) {
    if (existsSync(join(targetHome, MANIFEST_NAME))) {
      return { status: 'target_exists', sourceHome, targetHome, message: 'Target MOZI home already has migration manifest.' };
    }
    return {
      status: 'blocked',
      sourceHome,
      targetHome,
      message: `Target MOZI home already exists at ${targetHome} without ${MANIFEST_NAME}. Resolve the conflict before migration.`,
    };
  }
  if (await isRuntimeHealthy(options.healthUrl, fetchImpl)) {
    return {
      status: 'blocked',
      sourceHome,
      targetHome,
      message: `Existing MOZI runtime is running at ${options.healthUrl}. Quit it before first App Support migration.`,
    };
  }

  try {
    const sourceDatabase = inspectDatabase(sourceHome, true);
    if (existsSync(backupHome)) {
      throw new Error(`Migration backup already exists at ${backupHome}`);
    }
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    cpSync(sourceHome, backupHome, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });

    rmSync(stagingHome, { recursive: true, force: true });
    const copiedEntries = copyLegacyHome(sourceHome, stagingHome);
    const { workspaceDirRewritten, allowedRootsRewritten } = rewriteRuntimeConfigDefaults(stagingHome, targetHome, sourceHome);
    const stagedDatabase = inspectDatabase(stagingHome, false);
    const targetDatabase = stagedDatabase
      ? { ...stagedDatabase, path: join(targetHome, 'data', 'mozi.db') }
      : undefined;
    if (sourceDatabase && stagedDatabase && sourceDatabase.sha256 !== stagedDatabase.sha256) {
      throw new Error('Copied SQLite database hash does not match the checkpointed source database.');
    }

    const manifestPath = join(stagingHome, MANIFEST_NAME);
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        sourceHome,
        targetHome,
        backupHome,
        migratedAt: migratedAt.toISOString(),
        copiedEntries,
        sourceDatabase,
        targetDatabase,
        workspaceDirRewritten,
        allowedRootsRewritten,
        rollback: [
          'Quit MOZI.app and verify no MOZI runtime is listening on port 9210.',
          `Move ${targetHome} aside; do not delete it until rollback is verified.`,
          `Copy ${backupHome} to ${targetHome}.`,
          'Launch MOZI.app and verify diagnostics plus SQLite integrity.',
        ],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (existsSync(targetHome)) rmSync(targetHome, { recursive: true });
    renameSync(stagingHome, targetHome);

    return {
      status: 'migrated',
      sourceHome,
      targetHome,
      copiedEntries,
      backupHome,
      sourceDatabase,
      targetDatabase,
      workspaceDirRewritten,
      allowedRootsRewritten,
    };
  } catch (err) {
    rmSync(stagingHome, { recursive: true, force: true });
    return {
      status: 'blocked',
      sourceHome,
      targetHome,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
