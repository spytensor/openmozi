import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { create, getById, resetColumnsEnsured } from '../store/task-dag.js';
import { query } from '../store/events.js';
import { loadTaskTranscript } from '../tasks/workspace.js';
import { recordTaskLoopGuardEvent } from './dag-task-loop.js';

const hoisted = vi.hoisted(() => ({
  workspaceDir: '',
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: hoisted.workspaceDir },
    tools: {
      loops: {
        dag_max_iterations: 0,
        llm_call_timeout_ms: 1000,
        max_elapsed_ms: 1000,
        max_failed_tool_batches: 3,
      },
    },
  }),
}));

let workspaceTmpDir: string;
let dbTmpDir: string;
let savedMoziHome: string | undefined;

beforeAll(() => {
  workspaceTmpDir = createTempDir();
  hoisted.workspaceDir = workspaceTmpDir;
  savedMoziHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = join(workspaceTmpDir, 'mozi-home');
  const db = setupTestDb();
  dbTmpDir = db.tmpDir;
});

beforeEach(() => {
  resetColumnsEnsured();
  getDb().exec('DELETE FROM session_timeline_events');
  getDb().exec('DELETE FROM event_log');
  getDb().exec('DELETE FROM task_dependencies');
  getDb().exec('DELETE FROM tasks');
});

afterAll(() => {
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
  teardownTestDb(dbTmpDir);
  removeTempDir(workspaceTmpDir);
});

describe('DAG loop guard visibility', () => {
  it('fans a guard event out to event log, timeline, task metadata, and transcript', () => {
    const task = create({
      tenant_id: 'tenant-guard',
      title: 'Guarded step',
      objective: 'Trigger repeated failures',
      constraints: {
        permission_level: 'L1_READ_WRITE',
        allowed_paths: [],
        forbidden_paths: [],
        max_retries: 2,
      },
    });

    recordTaskLoopGuardEvent(task, 'chat-guard', 'repeated_tool_failures', {
      session_id: 'session-guard',
      turn_id: 'turn-guard',
      recent_errors: ['Error: create_artifact requires title, content_type, code.'],
    });

    const events = query('task', task.id, 'tenant-guard');
    expect(events.some((event) => event.event_type === 'dag_tool_loop_guard')).toBe(true);

    const timeline = getDb().prepare(`
      SELECT session_id, chat_id, item_type, payload
      FROM session_timeline_events
      WHERE tenant_id = ? AND session_id = ? AND event_key = ?
    `).get('tenant-guard', 'session-guard', `task:${task.id}`) as {
      session_id: string;
      chat_id: string;
      item_type: string;
      payload: string;
    } | undefined;
    expect(timeline).toMatchObject({
      session_id: 'session-guard',
      chat_id: 'chat-guard',
      item_type: 'task_update',
    });
    expect(JSON.parse(timeline?.payload ?? '{}')).toMatchObject({
      task_id: task.id,
      guard_reason: 'repeated_tool_failures',
    });

    const updated = getById(task.id, 'tenant-guard');
    expect(updated?.constraints.guard_reason).toBe('repeated_tool_failures');

    const transcript = loadTaskTranscript(task.id);
    expect(transcript).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        status: 'guarded',
        guard_reason: 'repeated_tool_failures',
      }),
    }));
  });
});
