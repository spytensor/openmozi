import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create, fail, resetColumnsEnsured, updateStatus } from '../store/task-dag.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { formatTasksCommandOutput } from './task-command.js';

let tmpDir: string;

beforeAll(() => {
  resetColumnsEnsured();
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('core/task-command', () => {
  it('renders active tasks by default', () => {
    const tenantId = 'task-command-active';
    const prep = create({ tenant_id: tenantId, title: 'Prepare env', objective: 'prep' });
    create({
      tenant_id: tenantId,
      title: 'Ship feature',
      objective: 'ship it',
      depends_on: [prep.id],
      tags: ['release'],
    });

    const output = formatTasksCommandOutput({ tenantId });
    expect(output).toContain('Active Tasks');
    expect(output).toContain('Prepare env');
    expect(output).toContain('Ship feature');
    expect(output).toContain('blocked_by=Prepare env');
  });

  it('supports status filters', () => {
    const tenantId = 'task-command-filter';
    const failed = create({ tenant_id: tenantId, title: 'Broken task', objective: 'oops' });
    fail(failed.id, 'boom', tenantId);
    const running = create({ tenant_id: tenantId, title: 'Running task', objective: 'go' });
    updateStatus(running.id, 'running', tenantId);

    const failedOutput = formatTasksCommandOutput({ tenantId, args: 'failed' });
    expect(failedOutput).toContain('Tasks (failed)');
    expect(failedOutput).toContain('Broken task');
    expect(failedOutput).not.toContain('Running task');
  });

  it('supports simple search queries', () => {
    const tenantId = 'task-command-search';
    create({ tenant_id: tenantId, title: 'Write release notes', objective: 'docs' });
    create({ tenant_id: tenantId, title: 'Fix routing bug', objective: 'bugfix' });

    const output = formatTasksCommandOutput({ tenantId, args: 'routing' });
    expect(output).toContain('query: routing');
    expect(output).toContain('Fix routing bug');
    expect(output).not.toContain('Write release notes');
  });

  it('returns a clear empty state', () => {
    const output = formatTasksCommandOutput({ tenantId: 'task-command-empty' });
    expect(output).toBe('No active tasks.');
  });
});
