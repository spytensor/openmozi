/**
 * Tests for task workspace persistence module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureTaskWorkspace,
  getTaskWorkspacePath,
  persistTaskResult,
  loadTaskResult,
  appendTranscript,
  appendTranscriptBatch,
  loadTaskTranscript,
  loadTranscriptTail,
  getTranscriptStats,
  persistTaskMetadata,
  loadTaskMetadata,
  cleanupTaskWorkspace,
  buildTaskResultRef,
  containsTaskResultRef,
  extractTaskIdsFromRefs,
  TASK_RESULT_REF_PREFIX,
  type PersistedTaskResult,
  type TranscriptEntry,
} from './workspace.js';

// Use a temp directory to avoid polluting real workspace
const testTaskId = `test_task_${Date.now()}`;

afterEach(() => {
  // Cleanup test workspace
  try { cleanupTaskWorkspace(testTaskId); } catch { /* ignore */ }
});

describe('workspace path resolution', () => {
  it('sanitizes task ID to prevent path traversal', () => {
    const path = getTaskWorkspacePath('../../../etc/passwd');
    expect(path).not.toContain('../');
    expect(path).toContain('______etc_passwd');
  });

  it('returns consistent path for same task ID', () => {
    const p1 = getTaskWorkspacePath('task_abc123');
    const p2 = getTaskWorkspacePath('task_abc123');
    expect(p1).toBe(p2);
  });
});

describe('ensureTaskWorkspace', () => {
  it('creates workspace directory', () => {
    const dir = ensureTaskWorkspace(testTaskId);
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent', () => {
    const dir1 = ensureTaskWorkspace(testTaskId);
    const dir2 = ensureTaskWorkspace(testTaskId);
    expect(dir1).toBe(dir2);
    expect(existsSync(dir1)).toBe(true);
  });
});

describe('result persistence', () => {
  const sampleResult: PersistedTaskResult = {
    task_id: testTaskId,
    success: true,
    output: 'Task completed successfully with result data',
    tokens_used: 1500,
    elapsed_ms: 5000,
    completed_at: new Date().toISOString(),
    agent_id: 'agent_001',
  };

  it('persists and loads result', () => {
    const filePath = persistTaskResult(testTaskId, sampleResult);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadTaskResult(testTaskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.task_id).toBe(testTaskId);
    expect(loaded!.success).toBe(true);
    expect(loaded!.output).toBe(sampleResult.output);
    expect(loaded!.tokens_used).toBe(1500);
  });

  it('returns null for non-existent task', () => {
    const loaded = loadTaskResult('nonexistent_task_xyz');
    expect(loaded).toBeNull();
  });

  it('overwrites previous result', () => {
    persistTaskResult(testTaskId, sampleResult);
    const updated = { ...sampleResult, output: 'Updated result', success: false };
    persistTaskResult(testTaskId, updated);

    const loaded = loadTaskResult(testTaskId);
    expect(loaded!.output).toBe('Updated result');
    expect(loaded!.success).toBe(false);
  });
});

describe('transcript persistence', () => {
  it('appends and loads entries', () => {
    const entry1: TranscriptEntry = {
      timestamp: new Date().toISOString(),
      type: 'llm_call',
      data: { iteration: 1, tool_names: ['shell'] },
    };
    const entry2: TranscriptEntry = {
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      data: { tool_name: 'shell', is_error: false },
    };

    appendTranscript(testTaskId, entry1);
    appendTranscript(testTaskId, entry2);

    const entries = loadTaskTranscript(testTaskId);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('llm_call');
    expect(entries[1].type).toBe('tool_result');
  });

  it('batch appends entries', () => {
    const batch: TranscriptEntry[] = [
      { timestamp: new Date().toISOString(), type: 'system', data: { event: 'start' } },
      { timestamp: new Date().toISOString(), type: 'llm_call', data: { iteration: 1 } },
      { timestamp: new Date().toISOString(), type: 'summary', data: { status: 'done' } },
    ];

    appendTranscriptBatch(testTaskId, batch);

    const entries = loadTaskTranscript(testTaskId);
    expect(entries).toHaveLength(3);
  });

  it('returns tail entries', () => {
    const entries: TranscriptEntry[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      type: 'llm_call' as const,
      data: { iteration: i },
    }));
    appendTranscriptBatch(testTaskId, entries);

    const tail = loadTranscriptTail(testTaskId, 3);
    expect(tail).toHaveLength(3);
    expect((tail[0].data as { iteration: number }).iteration).toBe(7);
    expect((tail[2].data as { iteration: number }).iteration).toBe(9);
  });

  it('returns stats', () => {
    appendTranscript(testTaskId, {
      timestamp: new Date().toISOString(),
      type: 'system',
      data: { event: 'test' },
    });

    const stats = getTranscriptStats(testTaskId);
    expect(stats).not.toBeNull();
    expect(stats!.entries).toBe(1);
    expect(stats!.bytes).toBeGreaterThan(0);
  });

  it('returns empty for non-existent task', () => {
    const entries = loadTaskTranscript('nonexistent_task_xyz');
    expect(entries).toEqual([]);
  });
});

describe('metadata persistence', () => {
  it('persists and loads metadata', () => {
    const meta = {
      task_id: testTaskId,
      title: 'Test Task',
      objective: 'Test the persistence layer',
      status: 'running',
      agent_id: 'agent_001',
      created_at: new Date().toISOString(),
      workspace_path: getTaskWorkspacePath(testTaskId),
    };

    persistTaskMetadata(testTaskId, meta);
    const loaded = loadTaskMetadata(testTaskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Test Task');
    expect(loaded!.status).toBe('running');
  });
});

describe('cleanup', () => {
  it('removes workspace directory', () => {
    ensureTaskWorkspace(testTaskId);
    expect(existsSync(getTaskWorkspacePath(testTaskId))).toBe(true);

    cleanupTaskWorkspace(testTaskId);
    expect(existsSync(getTaskWorkspacePath(testTaskId))).toBe(false);
  });

  it('is safe to call on non-existent workspace', () => {
    expect(() => cleanupTaskWorkspace('nonexistent_task_xyz')).not.toThrow();
  });
});

describe('compaction reference markers', () => {
  it('builds task result ref', () => {
    const ref = buildTaskResultRef('task_abc123', 'Operation completed');
    expect(ref).toContain(TASK_RESULT_REF_PREFIX);
    expect(ref).toContain('task_abc123');
    expect(ref).toContain('Operation completed');
    expect(ref).toContain('result.json');
  });

  it('detects task result ref in text', () => {
    const ref = buildTaskResultRef('task_abc123');
    expect(containsTaskResultRef(ref)).toBe(true);
    expect(containsTaskResultRef('Some random text')).toBe(false);
  });

  it('extracts task IDs from refs', () => {
    const text = `Previous context... ${buildTaskResultRef('task_001', 'first')} and ${buildTaskResultRef('task_002', 'second')} more text`;
    const ids = extractTaskIdsFromRefs(text);
    expect(ids).toEqual(['task_001', 'task_002']);
  });

  it('extracts empty array from text without refs', () => {
    expect(extractTaskIdsFromRefs('No refs here')).toEqual([]);
  });
});

describe('full persist → load → ref cycle', () => {
  it('simulates compaction recovery flow', () => {
    // Step 1: Task executes and persists result
    const result: PersistedTaskResult = {
      task_id: testTaskId,
      success: true,
      output: 'Complex analysis result with many details that would be too large to keep in context...',
      tokens_used: 3000,
      elapsed_ms: 12000,
      completed_at: new Date().toISOString(),
    };
    persistTaskResult(testTaskId, result);

    // Step 2: Context compressor creates a compact reference
    const ref = buildTaskResultRef(testTaskId, result.output.slice(0, 60));
    expect(containsTaskResultRef(ref)).toBe(true);

    // Step 3: After compaction, Brain sees the ref and recovers the result
    const ids = extractTaskIdsFromRefs(ref);
    expect(ids).toEqual([testTaskId]);

    const recovered = loadTaskResult(ids[0]);
    expect(recovered).not.toBeNull();
    expect(recovered!.output).toBe(result.output);
    expect(recovered!.success).toBe(true);
  });
});
