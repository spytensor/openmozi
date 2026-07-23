import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { prepareDesktopMoziHome } from './migration.js';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function healthyFetch(ok: boolean): typeof fetch {
  return (async () => ({
    ok,
    json: async () => ({ ok }),
  })) as typeof fetch;
}

function createTestDatabase(home: string): void {
  const dataDir = join(home, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'mozi.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE memory_facts (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tenant_api_keys (id INTEGER PRIMARY KEY);
    INSERT INTO sessions (id) VALUES ('session-1');
    INSERT INTO memory_facts (value) VALUES ('one'), ('two');
    INSERT INTO tenant_api_keys (id) VALUES (1);
  `);
  db.close();
}

describe('desktop App Support migration', () => {
  it('does nothing when no legacy MOZI home exists', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, 'missing');
    const targetHome = join(root, 'App Support', 'MOZI');
    try {
      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        fetchImpl: healthyFetch(false),
      });

      expect(result.status).toBe('not_needed');
    } finally {
      cleanup(root);
    }
  });

  it('skips migration when MOZI_HOME is explicitly set', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      writeFileSync(join(legacyHome, '.env'), 'OPENAI_API_KEY=test\n');

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        env: { MOZI_HOME: '/custom/mozi' } as NodeJS.ProcessEnv,
        fetchImpl: healthyFetch(false),
      });

      expect(result.status).toBe('not_needed');
      expect(result.message).toContain('MOZI_HOME override');
    } finally {
      cleanup(root);
    }
  });

  it('copies legacy runtime data and rewrites the default workspace path', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(join(legacyHome, 'workspace'), { recursive: true });
      writeFileSync(join(legacyHome, '.env'), 'OPENAI_API_KEY=test\n');
      createTestDatabase(legacyHome);
      writeFileSync(join(legacyHome, 'workspace', 'SOUL.local.md'), 'local');
      writeFileSync(join(legacyHome, 'mozi.json'), JSON.stringify({
        workspace: { dir: '~/.mozi/workspace' },
        tools: { fs: { additional_allowed_roots: ['~/.mozi', '/Volumes/shared'] } },
      }));

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        fetchImpl: healthyFetch(false),
        now: () => new Date('2026-07-01T00:00:00.000Z'),
      });

      expect(result.status).toBe('migrated');
      expect(readFileSync(join(targetHome, '.env'), 'utf-8')).toContain('OPENAI_API_KEY');
      expect(readFileSync(join(targetHome, 'workspace', 'SOUL.local.md'), 'utf-8')).toBe('local');
      const config = JSON.parse(readFileSync(join(targetHome, 'mozi.json'), 'utf-8')) as {
        workspace: { dir: string };
        tools: { fs: { additional_allowed_roots: string[] } };
      };
      expect(config.workspace.dir).toBe(join(targetHome, 'workspace'));
      expect(config.tools.fs.additional_allowed_roots).toEqual([targetHome, '/Volumes/shared']);
      const manifest = JSON.parse(readFileSync(join(targetHome, '.mozi-desktop-migration.json'), 'utf-8')) as {
        migratedAt: string;
        backupHome: string;
        sourceDatabase: { integrity: string; counts: Record<string, number>; sha256: string };
        targetDatabase: { integrity: string; counts: Record<string, number>; sha256: string };
        rollback: string[];
        workspaceDirRewritten: boolean;
        allowedRootsRewritten: boolean;
      };
      expect(manifest.migratedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(existsSync(manifest.backupHome)).toBe(true);
      expect(manifest.sourceDatabase.integrity).toBe('ok');
      expect(manifest.targetDatabase.integrity).toBe('ok');
      expect(manifest.sourceDatabase.counts).toMatchObject({ sessions: 1, memory_facts: 2, tenant_api_keys: 1 });
      expect(manifest.targetDatabase.counts).toEqual(manifest.sourceDatabase.counts);
      expect(manifest.targetDatabase.sha256).toBe(manifest.sourceDatabase.sha256);
      expect(manifest.rollback).toHaveLength(4);
      expect(manifest.workspaceDirRewritten).toBe(true);
      expect(manifest.allowedRootsRewritten).toBe(true);
      expect(readdirSync(join(root, 'Application Support')).some((entry) => entry.includes('.migrating-'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it('preserves a custom workspace path', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      writeFileSync(join(legacyHome, 'mozi.json'), JSON.stringify({ workspace: { dir: '/Volumes/work/project' } }));

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        fetchImpl: healthyFetch(false),
      });

      expect(result.status).toBe('migrated');
      const config = JSON.parse(readFileSync(join(targetHome, 'mozi.json'), 'utf-8')) as { workspace: { dir: string } };
      expect(config.workspace.dir).toBe('/Volumes/work/project');
    } finally {
      cleanup(root);
    }
  });

  it('rewrites default legacy paths in config.yaml', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      writeFileSync(join(legacyHome, 'config.yaml'), [
        'workspace:',
        '  dir: ~/.mozi/workspace',
        'tools:',
        '  fs:',
        '    additional_allowed_roots:',
        '      - ~/.mozi',
        '      - /Volumes/shared',
        '',
      ].join('\n'));

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        fetchImpl: healthyFetch(false),
      });

      expect(result.status).toBe('migrated');
      const yaml = readFileSync(join(targetHome, 'config.yaml'), 'utf-8');
      expect(yaml).toContain(`dir: ${targetHome}/workspace`);
      expect(yaml).toContain(`- ${targetHome}`);
      expect(yaml).toContain('- /Volumes/shared');
    } finally {
      cleanup(root);
    }
  });

  it('blocks conflicting target data without a migration manifest', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      mkdirSync(targetHome, { recursive: true });
      writeFileSync(join(legacyHome, '.env'), 'OPENAI_API_KEY=legacy\n');
      writeFileSync(join(targetHome, 'mozi.json'), '{}');

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        fetchImpl: healthyFetch(false),
      });

      expect(result.status).toBe('blocked');
      expect(result.message).toContain('without .mozi-desktop-migration.json');
    } finally {
      cleanup(root);
    }
  });

  it('blocks an unknown target entry instead of treating it as empty', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      mkdirSync(targetHome, { recursive: true });
      writeFileSync(join(legacyHome, '.env'), 'OPENAI_API_KEY=legacy\n');
      writeFileSync(join(targetHome, 'unknown-owner-file'), 'do not overwrite');

      const result = await prepareDesktopMoziHome({ legacyHome, targetHome, fetchImpl: healthyFetch(false) });

      expect(result.status).toBe('blocked');
      expect(readFileSync(join(targetHome, 'unknown-owner-file'), 'utf-8')).toBe('do not overwrite');
    } finally {
      cleanup(root);
    }
  });

  it('blocks a malformed source database before creating the target', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(join(legacyHome, 'data'), { recursive: true });
      writeFileSync(join(legacyHome, 'data', 'mozi.db'), 'not sqlite');

      const result = await prepareDesktopMoziHome({ legacyHome, targetHome, fetchImpl: healthyFetch(false) });

      expect(result.status).toBe('blocked');
      expect(result.message).toMatch(/database|sqlite/i);
      expect(existsSync(targetHome)).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it('accepts existing target data when a migration manifest exists', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      mkdirSync(targetHome, { recursive: true });
      writeFileSync(join(legacyHome, '.env'), 'OPENAI_API_KEY=legacy\n');
      writeFileSync(join(targetHome, 'mozi.json'), '{}');
      writeFileSync(join(targetHome, '.mozi-desktop-migration.json'), '{}');

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        fetchImpl: healthyFetch(false),
      });

      expect(result.status).toBe('target_exists');
    } finally {
      cleanup(root);
    }
  });

  it('blocks migration while a legacy runtime is healthy', async () => {
    const root = tempDir('mozi-desktop-migration-');
    const legacyHome = join(root, '.mozi');
    const targetHome = join(root, 'Application Support', 'MOZI');
    try {
      mkdirSync(legacyHome, { recursive: true });
      writeFileSync(join(legacyHome, '.env'), 'OPENAI_API_KEY=test\n');

      const result = await prepareDesktopMoziHome({
        legacyHome,
        targetHome,
        healthUrl: 'http://127.0.0.1:9210/api/health',
        fetchImpl: healthyFetch(true),
      });

      expect(result.status).toBe('blocked');
      expect(result.message).toContain('Existing MOZI runtime is running');
    } finally {
      cleanup(root);
    }
  });
});
