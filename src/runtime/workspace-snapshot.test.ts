import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config/index.js';
import { getConfigPath, getLogPath } from '../paths.js';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { buildRuntimeWorkspaceSnapshot, readRuntimeLogSnapshot } from './workspace-snapshot.js';

describe('runtime/workspace-snapshot', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  const savedMoziDesktop = process.env.MOZI_DESKTOP;
  const savedMoziDesktopManagedHome = process.env.MOZI_DESKTOP_MANAGED_HOME;
  const savedHome = process.env.HOME;
  let moziHome: string;
  let dbTmpDir: string;
  let fakeHome: string | undefined;

  beforeEach(() => {
    moziHome = join(tmpdir(), `mozi-runtime-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(moziHome, 'data'), { recursive: true });
    mkdirSync(join(moziHome, 'logs'), { recursive: true });
    mkdirSync(join(moziHome, 'workspace'), { recursive: true });
    mkdirSync(join(moziHome, 'granted-project'), { recursive: true });
    process.env.MOZI_HOME = moziHome;
    writeFileSync(join(moziHome, '.mozi-desktop-migration.json'), '{}');
    writeFileSync(getConfigPath(), JSON.stringify({
      server: { host: '127.0.0.1', port: 9210, auth_mode: 'none' },
      workspace: { dir: join(moziHome, 'workspace') },
      tools: { fs: {
        additional_allowed_roots: [moziHome],
        granted_project_roots: [{
          path: join(moziHome, 'granted-project'),
          label: 'Restored project',
          granted_at: '2026-07-10T00:00:00.000Z',
          bookmark: null,
        }],
      } },
    }));
    loadConfig(getConfigPath());
    const db = setupTestDb();
    dbTmpDir = db.tmpDir;
  });

  afterEach(() => {
    teardownTestDb(dbTmpDir);
    rmSync(moziHome, { recursive: true, force: true });
    if (fakeHome) {
      rmSync(fakeHome, { recursive: true, force: true });
      fakeHome = undefined;
    }
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    if (savedMoziDesktop === undefined) {
      delete process.env.MOZI_DESKTOP;
    } else {
      process.env.MOZI_DESKTOP = savedMoziDesktop;
    }
    if (savedMoziDesktopManagedHome === undefined) {
      delete process.env.MOZI_DESKTOP_MANAGED_HOME;
    } else {
      process.env.MOZI_DESKTOP_MANAGED_HOME = savedMoziDesktopManagedHome;
    }
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  });

  it('summarizes real runtime storage, workspace roots, and SQLite counts', async () => {
    const db = getDb();
    db.prepare("INSERT INTO sessions (id, tenant_id, user_id, title) VALUES ('s1', 'default', 'local-user', 'First task')").run();
    db.prepare("INSERT INTO conversations (tenant_id, chat_id, role, content, session_id) VALUES ('default', 'local-user', 'user', 'hello', 's1')").run();
    db.prepare("INSERT INTO memory_facts (tenant_id, chat_id, category, key, value) VALUES ('default', 'global', 'fact', 'timezone', 'UTC')").run();
    db.prepare("INSERT INTO tasks (id, tenant_id, title, status) VALUES ('t1', 'default', 'Task', 'running')").run();
    db.prepare(`
      INSERT INTO external_worker_jobs (
        id, tenant_id, agent_id, task_id, adapter_id, transport, status, task_spec, artifact_refs, metadata
      ) VALUES ('j1', 'default', 'agent', 't1', 'codex', 'managed', 'running', '{}', '[]', '{}')
    `).run();

    const snapshot = await buildRuntimeWorkspaceSnapshot('default');

    expect(snapshot.mozi_home.path).toBe(moziHome);
    expect(snapshot.migration.target_home_path).toBe(moziHome);
    expect(snapshot.migration.manifest_exists).toBe(true);
    expect(snapshot.migration.conflict).toBe(false);
    expect(snapshot.config.path).toBe(getConfigPath());
    expect(snapshot.config.server.auth_mode).toBe('none');
    expect(snapshot.storage.log_path).toBe(getLogPath());
    expect(snapshot.roots.some((root) => root.kind === 'workspace' && root.exists)).toBe(true);
    expect(snapshot.roots).toContainEqual(expect.objectContaining({
      kind: 'project_root',
      label: 'Restored project',
      path: join(moziHome, 'granted-project'),
      exists: true,
    }));
    // A granted project root the file API can serve is browsable; the runtime
    // source dir (not in the allow-list) is advertised but not browsable.
    expect(snapshot.roots.find((root) => root.label === 'Restored project')?.browsable).toBe(true);
    expect(snapshot.roots.find((root) => root.label === 'Runtime source')?.browsable).toBe(false);
    expect(snapshot.counts.sessions).toBe(1);
    expect(snapshot.counts.conversations).toBe(1);
    expect(snapshot.counts.memory_facts).toBe(1);
    expect(snapshot.counts.active_tasks).toBe(1);
    expect(snapshot.runtime.worker_jobs_by_status.running).toBe(1);
  });

  it('does not flag migration conflict for an empty legacy home', async () => {
    fakeHome = join(tmpdir(), `mozi-empty-legacy-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.mozi'), { recursive: true });
    rmSync(join(moziHome, '.mozi-desktop-migration.json'), { force: true });

    const snapshot = await buildRuntimeWorkspaceSnapshot('default');

    expect(snapshot.migration.legacy_home_exists).toBe(true);
    expect(snapshot.migration.conflict).toBe(false);
  });

  it('does not flag migration conflict for an explicit custom MOZI_HOME', async () => {
    fakeHome = join(tmpdir(), `mozi-marked-legacy-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.mozi'), { recursive: true });
    writeFileSync(join(fakeHome, '.mozi', 'mozi.json'), '{}');
    rmSync(join(moziHome, '.mozi-desktop-migration.json'), { force: true });

    const snapshot = await buildRuntimeWorkspaceSnapshot('default');

    expect(snapshot.migration.legacy_home_exists).toBe(true);
    expect(snapshot.migration.conflict).toBe(false);
  });

  it('flags desktop migration conflict when legacy home has MOZI markers and no manifest', async () => {
    fakeHome = join(tmpdir(), `mozi-marked-legacy-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.HOME = fakeHome;
    process.env.MOZI_DESKTOP = '1';
    process.env.MOZI_DESKTOP_MANAGED_HOME = '1';
    mkdirSync(join(fakeHome, '.mozi'), { recursive: true });
    writeFileSync(join(fakeHome, '.mozi', 'mozi.json'), '{}');
    rmSync(join(moziHome, '.mozi-desktop-migration.json'), { force: true });

    const snapshot = await buildRuntimeWorkspaceSnapshot('default');

    expect(snapshot.migration.legacy_home_exists).toBe(true);
    expect(snapshot.migration.conflict).toBe(true);
  });

  it('returns bounded tail lines from the real MOZI log file', () => {
    writeFileSync(getLogPath(), ['one', 'two', 'three', 'four'].join('\n'));

    const snapshot = readRuntimeLogSnapshot({ maxLines: 2, maxBytes: 1024 });

    expect(snapshot.path).toBe(getLogPath());
    expect(snapshot.exists).toBe(true);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.lines).toEqual(['three', 'four']);
  });
});
