import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { create, recordAfter, rollback, getForTask } from './checkpoint.js';
import { setupTestDb, teardownTestDb, createTempDir, removeTempDir } from '../test-helpers.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../store/db.js';

let dbTmpDir: string;
let filesTmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  dbTmpDir = result.tmpDir;
  filesTmpDir = createTempDir();
});

afterAll(() => {
  teardownTestDb(dbTmpDir);
  removeTempDir(filesTmpDir);
});

describe('tel/checkpoint', () => {
  it('create checkpoint captures file state', () => {
    const filePath = join(filesTmpDir, 'version.txt');
    writeFileSync(filePath, 'version 1', 'utf-8');

    const cp = create('task_001', 1, [{ path: filePath }]);
    expect(cp.checkpoint_id).toMatch(/^cp_/);
    expect(cp.task_id).toBe('task_001');
    expect(cp.step_index).toBe(1);
    expect(cp.files_changed).toHaveLength(1);
    expect(cp.files_changed[0].content_before).toBe('version 1');
    expect(cp.files_changed[0].hash_before).toBeTruthy();

    const db = getDb();
    const runtimeState = db.prepare(`
      SELECT payload
      FROM runtime_state
      WHERE state_kind = 'checkpoint_state' AND scope_type = 'checkpoint' AND scope_id = ?
    `).get(cp.checkpoint_id) as { payload: string } | undefined;
    expect(runtimeState).toBeDefined();
  });

  it('create checkpoint for non-existent file', () => {
    const filePath = join(filesTmpDir, 'does-not-exist.txt');
    const cp = create('task_002', 1, [{ path: filePath }]);

    expect(cp.files_changed[0].content_before).toBeNull();
    expect(cp.files_changed[0].hash_before).toBeNull();
  });

  it('rollback restores file content', () => {
    const filePath = join(filesTmpDir, 'rollback.txt');
    writeFileSync(filePath, 'original', 'utf-8');

    // Create checkpoint (captures "original")
    const cp = create('task_003', 1, [{ path: filePath }]);

    // Modify file
    writeFileSync(filePath, 'modified', 'utf-8');
    expect(readFileSync(filePath, 'utf-8')).toBe('modified');

    // Rollback
    const result = rollback(cp.checkpoint_id);
    expect(result.restored).toBe(1);
    expect(result.deleted).toBe(0);
    expect(readFileSync(filePath, 'utf-8')).toBe('original');
  });

  it('rollback deletes files that did not exist before', () => {
    const filePath = join(filesTmpDir, 'new-file.txt');

    // Create checkpoint (file doesn't exist yet)
    const cp = create('task_004', 1, [{ path: filePath }]);

    // Create the file
    writeFileSync(filePath, 'new content', 'utf-8');
    expect(existsSync(filePath)).toBe(true);

    // Rollback should delete it
    const result = rollback(cp.checkpoint_id);
    expect(result.deleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it('recordAfter updates hash_after', () => {
    const filePath = join(filesTmpDir, 'after.txt');
    writeFileSync(filePath, 'before', 'utf-8');

    const cp = create('task_005', 1, [{ path: filePath }]);

    // Modify file
    writeFileSync(filePath, 'after', 'utf-8');

    // Record after state
    recordAfter(cp.checkpoint_id);

    // Verify via getForTask
    const checkpoints = getForTask('task_005');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].files_changed[0].hash_after).toBeTruthy();
    expect(checkpoints[0].files_changed[0].hash_before).not.toBe(
      checkpoints[0].files_changed[0].hash_after
    );

    const db = getDb();
    const runtimeState = db.prepare(`
      SELECT payload
      FROM runtime_state
      WHERE state_kind = 'checkpoint_state' AND scope_type = 'checkpoint' AND scope_id = ?
    `).get(cp.checkpoint_id) as { payload: string } | undefined;
    expect(runtimeState).toBeDefined();
    expect(JSON.parse(runtimeState!.payload).files[0].hash_after).toBeTruthy();
  });

  it('getForTask returns ordered checkpoints', () => {
    const f = join(filesTmpDir, 'multi.txt');
    writeFileSync(f, 'v1', 'utf-8');
    create('task_006', 1, [{ path: f }]);
    create('task_006', 2, [{ path: f }]);
    create('task_006', 3, [{ path: f }]);

    const checkpoints = getForTask('task_006');
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0].step_index).toBe(1);
    expect(checkpoints[1].step_index).toBe(2);
    expect(checkpoints[2].step_index).toBe(3);
  });

  it('rollback throws for unknown checkpoint', () => {
    expect(() => rollback('cp_nonexistent')).toThrow('Checkpoint not found');
  });
});
