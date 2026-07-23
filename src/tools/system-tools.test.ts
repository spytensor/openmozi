import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_TOOLS, executeSystemTool } from './system-tools.js';
import { resetColumnsEnsured } from '../store/task-dag.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  resetColumnsEnsured();
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('tools/system-tools task management', () => {
  it('registers task management tools in the system toolset', () => {
    const names = SYSTEM_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain('create_task');
    expect(names).toContain('list_tasks');
    expect(names).toContain('get_task');
    expect(names).toContain('update_task');
  });

  it('creates, lists, inspects, and updates tasks through system tools', async () => {
    const tenantId = 'system-task-tools';

    const createResult = await executeSystemTool(
      'create_task',
      {
        title: 'Investigate regression',
        objective: 'Trace the failing path',
        tags: ['triage'],
      },
      'call-create',
      { tenantId },
    );
    expect(createResult?.is_error).toBe(false);
    const created = JSON.parse(createResult!.content) as { task: { id: string; title: string; status: string } };
    expect(created.task.title).toBe('Investigate regression');
    expect(created.task.status).toBe('ready');

    const listResult = await executeSystemTool(
      'list_tasks',
      { tag: 'triage' },
      'call-list',
      { tenantId },
    );
    expect(listResult?.is_error).toBe(false);
    const listed = JSON.parse(listResult!.content) as Array<{ id: string; title: string }>;
    expect(listed).toEqual([
      expect.objectContaining({ id: created.task.id, title: 'Investigate regression' }),
    ]);

    const getResult = await executeSystemTool(
      'get_task',
      { task_id: created.task.id },
      'call-get',
      { tenantId },
    );
    expect(getResult?.is_error).toBe(false);
    const detail = JSON.parse(getResult!.content) as { task: { id: string; title: string } };
    expect(detail.task.id).toBe(created.task.id);

    const updateResult = await executeSystemTool(
      'update_task',
      {
        task_id: created.task.id,
        patch: {
          title: 'Investigate production regression',
          priority: 2,
        },
        status: 'blocked',
        reason: 'Need reproduction steps',
      },
      'call-update',
      { tenantId },
    );
    expect(updateResult?.is_error).toBe(false);
    const updated = JSON.parse(updateResult!.content) as {
      task: { task: { title: string; priority: number; status: string } };
    };
    expect(updated.task.task.title).toBe('Investigate production regression');
    expect(updated.task.task.priority).toBe(2);
    expect(updated.task.task.status).toBe('blocked');
  });

  it('returns a structured error when get_task references a missing task', async () => {
    const result = await executeSystemTool(
      'get_task',
      { task_id: 'missing-task' },
      'call-missing',
      { tenantId: 'system-task-tools-missing' },
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('Task not found');
  });
});
