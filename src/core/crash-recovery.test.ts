import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setCleanShutdown,
  wasCleanShutdown,
  recover,
  formatRecoveryMessage,
  resetTableEnsured,
} from './crash-recovery.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  resetTableEnsured();
  const db = getDb();
  // Ensure system_state table exists before cleanup
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Clean up between tests
  db.exec("DELETE FROM system_state");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM agent_registry");
  db.exec("DELETE FROM checkpoints");
  db.exec("DELETE FROM runtime_state");
  db.exec("DELETE FROM event_log");
});

describe('core/crash-recovery — clean shutdown flag', () => {
  it('first run (no flag) is considered clean', () => {
    expect(wasCleanShutdown()).toBe(true);
  });

  it('setCleanShutdown(true) marks as clean', () => {
    setCleanShutdown(true);
    expect(wasCleanShutdown()).toBe(true);
  });

  it('setCleanShutdown(false) marks as unclean', () => {
    setCleanShutdown(false);
    expect(wasCleanShutdown()).toBe(false);
  });

  it('toggling clean shutdown flag works', () => {
    setCleanShutdown(true);
    expect(wasCleanShutdown()).toBe(true);
    setCleanShutdown(false);
    expect(wasCleanShutdown()).toBe(false);
    setCleanShutdown(true);
    expect(wasCleanShutdown()).toBe(true);
  });
});

describe('core/crash-recovery — recover()', () => {
  it('returns no recovery needed on clean shutdown', () => {
    setCleanShutdown(true);
    const report = recover();
    expect(report.recovered).toBe(false);
    expect(report.wasCleanShutdown).toBe(true);
    expect(report.tasksResumed).toEqual([]);
    expect(report.checkpointResumes).toEqual([]);
    expect(report.tasksFailed).toEqual([]);
    expect(report.agentsCrashed).toEqual([]);
  });

  it('detects unclean shutdown', () => {
    setCleanShutdown(false);
    const report = recover();
    expect(report.recovered).toBe(true);
    expect(report.wasCleanShutdown).toBe(false);
  });

  it('marks running tasks with checkpoints as ready', () => {
    setCleanShutdown(false);
    const db = getDb();

    // Ensure task-dag columns exist
    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has('on_dep_failure')) {
      db.exec("ALTER TABLE tasks ADD COLUMN on_dep_failure TEXT NOT NULL DEFAULT 'fail_fast'");
    }
    if (!colNames.has('agent_type_hint')) {
      db.exec("ALTER TABLE tasks ADD COLUMN agent_type_hint TEXT NOT NULL DEFAULT 'any'");
    }
    if (!colNames.has('constraints')) {
      db.exec("ALTER TABLE tasks ADD COLUMN constraints JSON DEFAULT '{}'");
    }
    if (!colNames.has('attempts')) {
      db.exec("ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    }

    // Create a running task with a checkpoint
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('task-1', 'default', 'Test Task', 'do stuff', 'running', 0)
    `).run();

    db.prepare(`
      INSERT INTO checkpoints (id, tenant_id, task_id, step_index, files_changed)
      VALUES ('cp-1', 'default', 'task-1', 1, '[]')
    `).run();

    const report = recover();
    expect(report.tasksResumed).toContain('task-1');
    expect(report.checkpointResumes).toHaveLength(1);
    expect(report.checkpointResumes[0].taskId).toBe('task-1');
    expect(report.checkpointResumes[0].checkpointId).toBe('cp-1');
    expect(report.checkpointResumes[0].stepIndex).toBe(1);
    expect(report.tasksFailed).not.toContain('task-1');

    // Verify task status was updated
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string };
    expect(task.status).toBe('ready');
  });

  it('surfaces checkpoint metadata for reproducible recovery', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('task-cp-meta', 'default', 'Checkpoint Meta Task', 'do stuff', 'running', 0)
    `).run();

    db.prepare(`
      INSERT INTO checkpoints (id, tenant_id, task_id, step_index, files_changed, rollback_commands)
      VALUES ('cp-meta', 'default', 'task-cp-meta', 3, '[{"path":"/tmp/file.txt"}]', '["restore_file /tmp/file.txt"]')
    `).run();
    db.prepare(`
      INSERT INTO runtime_state (tenant_id, state_kind, scope_type, scope_id, payload, created_at, updated_at)
      VALUES (
        'default',
        'checkpoint_state',
        'checkpoint',
        'cp-meta',
        ?,
        datetime('now'),
        datetime('now')
      )
    `).run(JSON.stringify({
      checkpoint_id: 'cp-meta',
      task_id: 'task-cp-meta',
      step_index: 4,
      files: [
        { path: '/tmp/file.txt', hash_before: 'a', hash_after: 'b' },
        { path: '/tmp/second.txt', hash_before: 'c', hash_after: null },
      ],
      db_mutations: null,
      rollback_commands: ['restore_file /tmp/file.txt'],
      created_at: '2026-01-02 00:00:00',
    }));

    const report = recover();
    expect(report.tasksResumed).toContain('task-cp-meta');
    expect(report.checkpointResumes).toContainEqual({
      taskId: 'task-cp-meta',
      checkpointId: 'cp-meta',
      stepIndex: 4,
      filesChanged: 2,
      createdAt: '2026-01-02 00:00:00',
    });

    const taskEvent = db.prepare(`
      SELECT payload
      FROM event_log
      WHERE tenant_id = 'default' AND event_type = 'task_recovered' AND entity_id = 'task-cp-meta'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { payload: string } | undefined;

    expect(taskEvent).toBeTruthy();
    const payload = JSON.parse(taskEvent!.payload) as {
      action?: string;
      checkpoint?: { checkpointId?: string; stepIndex?: number; filesChanged?: number };
    };
    expect(payload.action).toBe('resumed_from_checkpoint');
    expect(payload.checkpoint?.checkpointId).toBe('cp-meta');
    expect(payload.checkpoint?.stepIndex).toBe(4);
    expect(payload.checkpoint?.filesChanged).toBe(2);
  });

  it('marks running tasks without checkpoints as failed', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('task-2', 'default', 'No Checkpoint Task', 'do stuff', 'running', 0)
    `).run();

    const report = recover();
    expect(report.tasksFailed).toContain('task-2');
    expect(report.tasksResumed).not.toContain('task-2');

    // Verify task status
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-2'").get() as { status: string };
    expect(task.status).toBe('failed');
  });

  it('marks assigned tasks without checkpoints as failed', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('task-3', 'default', 'Assigned Task', 'do stuff', 'assigned', 0)
    `).run();

    const report = recover();
    expect(report.tasksFailed).toContain('task-3');
  });

  it('does not touch completed or pending tasks', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('task-done', 'default', 'Done Task', 'done', 'completed', 0)
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('task-pending', 'default', 'Pending Task', 'waiting', 'pending', 0)
    `).run();

    const report = recover();
    expect(report.tasksResumed).not.toContain('task-done');
    expect(report.tasksFailed).not.toContain('task-done');
    expect(report.tasksResumed).not.toContain('task-pending');
    expect(report.tasksFailed).not.toContain('task-pending');

    // Verify statuses unchanged
    const done = db.prepare("SELECT status FROM tasks WHERE id = 'task-done'").get() as { status: string };
    const pending = db.prepare("SELECT status FROM tasks WHERE id = 'task-pending'").get() as { status: string };
    expect(done.status).toBe('completed');
    expect(pending.status).toBe('pending');
  });

  it('marks active agents as crashed', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO agent_registry (id, tenant_id, name, type, status)
      VALUES ('agent-1', 'default', 'Test Agent', 'dynamic', 'active')
    `).run();

    const report = recover();
    expect(report.agentsCrashed).toContain('agent-1');

    // Verify agent status
    const agent = db.prepare("SELECT status FROM agent_registry WHERE id = 'agent-1'").get() as { status: string };
    expect(agent.status).toBe('inactive');
  });

  it('does not mark inactive agents', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO agent_registry (id, tenant_id, name, type, status)
      VALUES ('agent-2', 'default', 'Inactive Agent', 'preset', 'inactive')
    `).run();

    const report = recover();
    expect(report.agentsCrashed).not.toContain('agent-2');
  });

  it('generates correct recovery summary', () => {
    setCleanShutdown(false);
    const db = getDb();

    // Add tasks and agents to be recovered
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('t1', 'default', 'Task 1', 'x', 'running', 0)
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('t2', 'default', 'Task 2', 'x', 'running', 0)
    `).run();
    db.prepare(`
      INSERT INTO checkpoints (id, tenant_id, task_id, step_index, files_changed)
      VALUES ('cp-t1', 'default', 't1', 1, '[]')
    `).run();

    const report = recover();
    expect(report.summary).toContain('1 task(s) resumed');
    expect(report.summary).toContain('1 task(s) marked as failed');
  });

  it('sets clean_shutdown to false after recovery', () => {
    setCleanShutdown(false);
    recover();
    // After recovery, flag should be false (will be set true on graceful exit)
    expect(wasCleanShutdown()).toBe(false);
  });

  it('logs recovery events to event_log', () => {
    setCleanShutdown(false);
    const db = getDb();

    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, objective, status, priority)
      VALUES ('t-log', 'default', 'Log Task', 'x', 'running', 0)
    `).run();

    recover();

    const events = db.prepare(`
      SELECT * FROM event_log WHERE entity_type = 'task' AND entity_id = 't-log'
    `).all();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('core/crash-recovery — formatRecoveryMessage', () => {
  it('returns empty string for no recovery', () => {
    const msg = formatRecoveryMessage({
      recovered: false,
      wasCleanShutdown: true,
      tasksResumed: [],
      checkpointResumes: [],
      tasksFailed: [],
      agentsCrashed: [],
      summary: 'No recovery needed.',
    });
    expect(msg).toBe('');
  });

  it('returns summary for recovery', () => {
    const msg = formatRecoveryMessage({
      recovered: true,
      wasCleanShutdown: false,
      tasksResumed: ['t1'],
      checkpointResumes: [{ taskId: 't1', checkpointId: 'cp-t1', stepIndex: 1, filesChanged: 1, createdAt: '2026-01-01 00:00:00' }],
      tasksFailed: ['t2'],
      agentsCrashed: ['a1'],
      summary: '[SYSTEM] Recovered from crash. 1 task(s) resumed, 1 task(s) failed, 1 agent(s) crashed.',
    });
    expect(msg).toContain('[SYSTEM]');
    expect(msg).toContain('Recovered');
  });
});
