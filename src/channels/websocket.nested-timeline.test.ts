/**
 * Nested task-timeline parent-identity contract (Issue #624).
 *
 * Proves that the explicit parent-child identifiers a plan/DAG produces survive
 * the full producer → broadcast → persistence → restore path, so a reloaded
 * session can reconstruct plan → subtask → tool / delegated-worker ownership.
 * Persistence runs regardless of connected sockets, so none are needed.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { broadcastProgressEvent, buildWorkerTaskProgressMessage } from './websocket.js';
import { getSessionTimelinePage } from '../memory/session-timeline.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { registerRunningTurn, clearRunningTurnsForTests } from '../core/turn-cancellation.js';

const TENANT = 'default';
const USER = 'u1';
const SESSION = 's1';
const CHAT = `${USER}:${SESSION}`;
const ROOT = 'task_root';
const SUB_A = 'task_sub_a';
const SUB_B = 'task_sub_b';

interface TaskPayload {
  task_id: string;
  parentTaskId?: string;
  status?: string;
  rawStatus?: string;
}

function restoredTasks(): Array<{ turnId?: string; data: TaskPayload }> {
  const page = getSessionTimelinePage(SESSION, { tenantId: TENANT });
  return page.timeline
    .filter((item) => item.type === 'task_update')
    .map((item) => ({ turnId: item.turnId, data: item.data as TaskPayload }));
}

let tmpDir: string;

beforeEach(() => {
  clearRunningTurnsForTests();
  tmpDir = setupTestDb().tmpDir;
  registerRunningTurn({ turnId: 'turn_A', tenantId: TENANT, chatId: CHAT, userId: USER, sessionId: SESSION });
});

afterEach(() => {
  clearRunningTurnsForTests();
  teardownTestDb(tmpDir);
});

describe('Issue #624 — parent identity survives WS + persistence + restore', () => {
  it('persists parentTaskId for a two-task plan and its concurrent subtasks', () => {
    // Plan root (no parent).
    broadcastProgressEvent({
      type: 'dag_created', taskId: ROOT, taskTitle: 'Ship the thing',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', totalTasks: 2, timestamp: 1000,
    });
    // Two subtasks owned by the root — started concurrently.
    broadcastProgressEvent({
      type: 'task_started', taskId: SUB_A, parentTaskId: ROOT, taskTitle: 'Build',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1001,
    });
    broadcastProgressEvent({
      type: 'task_started', taskId: SUB_B, parentTaskId: ROOT, taskTitle: 'Test',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1002,
    });
    // One subtask fails, the other is cancelled — both terminal states must persist.
    broadcastProgressEvent({
      type: 'task_failed', taskId: SUB_A, parentTaskId: ROOT, taskTitle: 'Build', error: 'boom',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1003,
    });
    broadcastProgressEvent({
      type: 'task_cancelled', taskId: SUB_B, parentTaskId: ROOT, taskTitle: 'Test', error: 'stopped',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1004,
    });

    const tasks = restoredTasks();
    const byId = new Map(tasks.map((t) => [t.data.task_id, t.data]));

    // Every task retained its owning turn.
    expect(tasks.every((t) => t.turnId === 'turn_A')).toBe(true);

    // Root has no parent; both subtasks nest under it — concurrent, never merged.
    expect(byId.get(ROOT)?.parentTaskId).toBeUndefined();
    expect(byId.get(SUB_A)?.parentTaskId).toBe(ROOT);
    expect(byId.get(SUB_B)?.parentTaskId).toBe(ROOT);
    expect(byId.size).toBe(3);

    // Cancelled stays distinguishable from a real failure via rawStatus.
    expect(byId.get(SUB_A)?.rawStatus).toBe('task_failed');
    expect(byId.get(SUB_B)?.rawStatus).toBe('task_cancelled');
    expect(byId.get(SUB_A)?.status).toBe('failed');
  });

  it('carries parentTaskId from worker_status onto the task_progress frame', () => {
    const msg = buildWorkerTaskProgressMessage({
      type: 'worker_status', taskId: SUB_A, parentTaskId: ROOT, jobId: 'worker_job_sub_a',
      workerStatus: 'running', chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 2000,
    });
    expect(msg?.parentTaskId).toBe(ROOT);
    expect(msg?.task_id).toBe(SUB_A);
  });

  it('persists parentTaskId from a delegated worker_status stream', () => {
    broadcastProgressEvent({
      type: 'worker_status', taskId: SUB_A, parentTaskId: ROOT, jobId: 'worker_job_sub_a',
      runtimeLabel: 'Claude Code', workerStatus: 'running',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 2000,
    });
    const worker = restoredTasks().find((t) => t.data.task_id === SUB_A);
    expect(worker?.data.parentTaskId).toBe(ROOT);
    expect(worker?.turnId).toBe('turn_A');
  });
});
