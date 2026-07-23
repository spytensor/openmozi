import { describe, it, expect, afterAll } from 'vitest';
import { getDb, initDb, closeDb } from './db.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tmpDir: string;

afterAll(() => {
  if (tmpDir) teardownTestDb(tmpDir);
});

describe('store/db', () => {
  it('getDb throws when not initialized', () => {
    closeDb();
    expect(() => getDb()).toThrow('Database not initialized');
  });

  it('initDb creates database and returns instance', () => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    const db = getDb();
    expect(db).toBeTruthy();
  });

  it('migration creates all expected tables', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_dependencies');
    expect(tableNames).toContain('task_attempts');
    expect(tableNames).toContain('checkpoints');
    expect(tableNames).toContain('message_queue');
    expect(tableNames).toContain('event_log');
    expect(tableNames).toContain('runtime_state');
    expect(tableNames).toContain('external_worker_jobs');
    expect(tableNames).toContain('agent_registry');
    expect(tableNames).toContain('skill_versions');
    expect(tableNames).toContain('traces');
    expect(tableNames).toContain('turn_traces');
    expect(tableNames).toContain('tool_spans');
    expect(tableNames).toContain('tenant_quotas');
    expect(tableNames).toContain('reminders');
    expect(tableNames).toContain('background_tasks');
    expect(tableNames).toContain('lessons');
    expect(tableNames).toContain('dynamic_tools');
    expect(tableNames).toContain('artifact_versions');
  });

  it('creates artifact_versions with the versioning columns', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(artifact_versions)').all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);

    expect(columnNames).toEqual([
      'id',
      'artifact_id',
      // Reads are tenant-scoped; update_artifact takes artifact_id from the model.
      'tenant_id',
      'version_number',
      'content',
      'persisted_path',
      'created_at',
      'change_description',
    ]);
  });

  it('all tables have tenant_id column', () => {
    const db = getDb();
    const tablesWithTenantId = [
      'tasks', 'task_dependencies', 'task_attempts', 'checkpoints',
      'message_queue', 'event_log', 'runtime_state', 'external_worker_jobs', 'agent_registry', 'skill_versions', 'traces',
      'turn_traces', 'tool_spans',
      'reminders', 'background_tasks',
      'lessons', 'dynamic_tools',
    ];

    for (const table of tablesWithTenantId) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames, `${table} should have tenant_id`).toContain('tenant_id');
    }
  });

  it('initDb is idempotent', () => {
    const db1 = getDb();
    const db2 = initDb('should-not-matter.db');
    expect(db1).toBe(db2);
  });

  it('closeDb allows re-initialization', () => {
    closeDb();
    expect(() => getDb()).toThrow();
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    expect(getDb()).toBeTruthy();
  });
});
