import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb } from '../store/db.js';
import { runMigrations } from '../store/migrate.js';
import {
  createTaskTemplate,
  deleteTaskTemplate,
  getTaskTemplate,
  listTaskTemplates,
  reorderTaskTemplates,
  updateTaskTemplate,
} from './store.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mozi-task-templates-'));
  runMigrations(join(dir, 'test.db'));
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('task template store isolation', () => {
  it('isolates every operation by tenant and user', () => {
    const owned = createTaskTemplate('tenant-a', 'user-a', {
      title: 'Email brief', instructions: 'Summarize today email', output_format: 'Bullets',
    });
    createTaskTemplate('tenant-a', 'user-b', { title: 'Other user', instructions: 'Private' });
    createTaskTemplate('tenant-b', 'user-a', { title: 'Other tenant', instructions: 'Private' });

    expect(listTaskTemplates('tenant-a', 'user-a').map(item => item.title)).toEqual(['Email brief']);
    expect(getTaskTemplate('tenant-a', 'user-b', owned.id)).toBeUndefined();
    expect(getTaskTemplate('tenant-b', 'user-a', owned.id)).toBeUndefined();
    expect(updateTaskTemplate('tenant-a', 'user-b', owned.id, { title: 'Stolen', instructions: 'No' })).toBeUndefined();
    expect(deleteTaskTemplate('tenant-b', 'user-a', owned.id)).toBe(false);
    expect(getTaskTemplate('tenant-a', 'user-a', owned.id)?.title).toBe('Email brief');
  });

  it('rejects reorder requests containing foreign or incomplete ids', () => {
    const first = createTaskTemplate('tenant-a', 'user-a', { title: 'First', instructions: '1' });
    const second = createTaskTemplate('tenant-a', 'user-a', { title: 'Second', instructions: '2' });
    const foreign = createTaskTemplate('tenant-a', 'user-b', { title: 'Foreign', instructions: '3' });

    expect(reorderTaskTemplates('tenant-a', 'user-a', [foreign.id, first.id])).toBeUndefined();
    expect(reorderTaskTemplates('tenant-a', 'user-a', [second.id, first.id])?.map(item => item.id)).toEqual([second.id, first.id]);
  });
});
