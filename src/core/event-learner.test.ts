import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractLessons, getStoredLessons } from './event-learner.js';
import { log as logEvent } from '../store/events.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

describe('core/event-learner', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('returns empty lessons when no events', () => {
    const lessons = extractLessons('default', 24);
    expect(lessons).toEqual([]);
  });

  it('detects repeated failure patterns (>= 3 failures)', () => {
    // Log 3 failures for the same entity
    logEvent('task_failed', 'task', 'task-001', { error: 'timeout' }, 'default');
    logEvent('task_failed', 'task', 'task-001', { error: 'timeout' }, 'default');
    logEvent('task_failed', 'task', 'task-001', { error: 'timeout' }, 'default');

    const lessons = extractLessons('default', 24);
    expect(lessons.length).toBeGreaterThanOrEqual(1);
    expect(lessons[0]).toContain('Repeated failure');
    expect(lessons[0]).toContain('task-001');
  });

  it('ignores failures below threshold (< 3)', () => {
    logEvent('task_failed', 'task', 'task-002', { error: 'once' }, 'default');
    logEvent('task_failed', 'task', 'task-002', { error: 'twice' }, 'default');

    const lessons = extractLessons('default', 24);
    // Should not detect a pattern with only 2 failures
    const failurePatterns = lessons.filter(l => l.includes('task-002'));
    expect(failurePatterns).toHaveLength(0);
  });

  it('detects frequent error types (>= 5 occurrences)', () => {
    for (let i = 0; i < 6; i++) {
      logEvent('tool_error', 'tool', `call-${i}`, { error: 'API rate limit' }, 'default');
    }

    const lessons = extractLessons('default', 24);
    const errorPatterns = lessons.filter(l => l.includes('tool_error'));
    expect(errorPatterns.length).toBeGreaterThanOrEqual(1);
  });

  it('saves lessons to memory_facts', () => {
    for (let i = 0; i < 3; i++) {
      logEvent('agent_failed', 'agent', 'agent-x', { error: 'OOM' }, 'test-tenant');
    }

    extractLessons('test-tenant', 24);

    const stored = getStoredLessons('test-tenant');
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored[0]).toContain('agent-x');
  });

  it('respects tenant isolation', () => {
    for (let i = 0; i < 3; i++) {
      logEvent('task_failed', 'task', 'task-a', { error: 'err' }, 'tenant-a');
    }

    // Query different tenant — should find nothing
    const lessons = extractLessons('tenant-b', 24);
    expect(lessons).toEqual([]);
  });
});
