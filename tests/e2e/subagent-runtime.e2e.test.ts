import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, ChatResponse, LLMClient, StreamChunk } from '../../src/core/llm.js';
import type { TaskRecord } from '../../src/store/task-dag.js';
import { setupTestDb, teardownTestDb } from '../../src/test-helpers.js';
import { getDb } from '../../src/store/db.js';
import { getConfig, loadConfig, updateConfig } from '../../src/config/index.js';
import { requestTaskCancellation, resetTaskCancellationRegistry } from '../../src/core/task-cancellation.js';

const hoisted = vi.hoisted(() => {
  const dependencyMap = new Map<string, string[]>();
  const getDependenciesMock = vi.fn((taskId: string) => dependencyMap.get(taskId) ?? []);
  const cancelTaskMock = vi.fn();
  const getByIdMock = vi.fn((taskId: string) => ({ id: taskId, status: 'ready' }));
  const updateTaskMock = vi.fn();
  const getClientForTaskMock = vi.fn();
  const dispatchToSubAgentMock = vi.fn();
  const isSubAgentAvailableMock = vi.fn().mockReturnValue(false);
  const writeBlackboardMock = vi.fn();
  const searchLessonsMock = vi.fn().mockReturnValue([]);
  const incrementAppliedMock = vi.fn();

  return {
    dependencyMap,
    getDependenciesMock,
    cancelTaskMock,
    getByIdMock,
    updateTaskMock,
    getClientForTaskMock,
    dispatchToSubAgentMock,
    isSubAgentAvailableMock,
    writeBlackboardMock,
    searchLessonsMock,
    incrementAppliedMock,
  };
});

vi.mock('../../src/store/task-dag.js', () => ({
  getDependencies: hoisted.getDependenciesMock,
  cancel: hoisted.cancelTaskMock,
  getById: hoisted.getByIdMock,
  updateTask: hoisted.updateTaskMock,
  updateStatus: vi.fn(),
  incrementAttempts: vi.fn(),
}));

vi.mock('../../src/core/model-router.js', () => ({
  getClientForTask: hoisted.getClientForTaskMock,
  getClientForRole: hoisted.getClientForTaskMock,
}));

vi.mock('../../src/core/subagent-dispatch.js', () => ({
  dispatchToSubAgent: hoisted.dispatchToSubAgentMock,
  isSubAgentAvailable: hoisted.isSubAgentAvailableMock,
}));

vi.mock('../../src/capabilities/blackboard.js', () => ({
  write: hoisted.writeBlackboardMock,
}));

vi.mock('../../src/memory/lessons.js', () => ({
  searchLessons: hoisted.searchLessonsMock,
  incrementApplied: hoisted.incrementAppliedMock,
}));

import { executeDag } from '../../src/core/dag-executor.js';

let tmpDir: string;

function makeTask(id: string, title: string, objective: string): TaskRecord {
  return {
    id,
    tenant_id: 'default',
    parent_task_id: null,
    title,
    objective,
    done_criteria: 'done',
    status: 'ready',
    assigned_agent: null,
    agent_type_hint: 'any',
    constraints: {},
    on_dep_failure: 'fail_fast',
    attempts: 0,
    priority: 0,
    tags: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeResponse(content: string): ChatResponse {
  return {
    content,
    usage: { input_tokens: 10, output_tokens: 10 },
    model: 'mock-model',
    stop_reason: 'end',
  };
}

function makeClient(chatImpl: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn(chatImpl),
    async *chatStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'done', response: makeResponse('unused-stream') };
    },
  };
}

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  loadConfig('/nonexistent/config.yaml');
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  hoisted.dependencyMap.clear();
  hoisted.getDependenciesMock.mockClear();
  hoisted.cancelTaskMock.mockReset();
  hoisted.getByIdMock.mockReset();
  hoisted.getByIdMock.mockImplementation((taskId: string) => ({ id: taskId, status: 'ready' }));
  hoisted.getClientForTaskMock.mockReset();
  hoisted.dispatchToSubAgentMock.mockReset();
  hoisted.isSubAgentAvailableMock.mockReset().mockReturnValue(false);
  hoisted.writeBlackboardMock.mockReset();
  hoisted.searchLessonsMock.mockReset().mockReturnValue([]);
  hoisted.incrementAppliedMock.mockReset();
  resetTaskCancellationRegistry();
});

describe('e2e/subagent-runtime', () => {
  it('runs independent tasks in parallel when subagent runtime is enabled', async () => {
    const a = makeTask('parallel-a', 'Parallel A', 'A objective');
    const b = makeTask('parallel-b', 'Parallel B', 'B objective');
    hoisted.dependencyMap.set(a.id, []);
    hoisted.dependencyMap.set(b.id, []);
    hoisted.isSubAgentAvailableMock.mockReturnValue(true);

    let inFlight = 0;
    let maxInFlight = 0;
    hoisted.dispatchToSubAgentMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 40));
      inFlight -= 1;
      return { success: true, output: 'done', tokens_used: 10, elapsed_ms: 40 };
    });

    await executeDag([a, b], 'sys', 'chat-e2e-parallel', undefined, undefined, undefined, {
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'default:chat-e2e-parallel',
    });

    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(hoisted.dispatchToSubAgentMock).toHaveBeenCalledTimes(2);
  });

  it('cancels pre-requested tasks before execution', async () => {
    const task = makeTask('cancel-a', 'Cancel A', 'Cancel objective');
    hoisted.dependencyMap.set(task.id, []);

    await requestTaskCancellation(task.id, {
      tenantId: 'default',
      requestedBy: 'e2e-tester',
      reason: 'cancel-before-start',
    });

    const client = makeClient(async () => makeResponse('should-not-run'));
    hoisted.getClientForTaskMock.mockReturnValue({
      client,
      selection: { provider: 'mock', model: 'mock-model', role: 'simple_subagent' },
    });

    const summary = await executeDag([task], 'sys', 'chat-e2e-cancel');
    expect(summary).toContain('Cancelled:');
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('retries after timeout and succeeds on a later attempt', async () => {
    const previousFailedThreshold = getConfig().tools.loops.max_failed_tool_batches;
    updateConfig('tools.loops.max_failed_tool_batches', 1);

    const task = makeTask('retry-a', 'Retry A', 'Retry objective');
    task.constraints = { max_retries: 2 };
    hoisted.dependencyMap.set(task.id, []);

    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('timeout while waiting for provider');
      }
      return makeResponse('retry-success');
    });
    hoisted.getClientForTaskMock.mockReturnValue({
      client,
      selection: { provider: 'mock', model: 'mock-model', role: 'simple_subagent' },
    });

    try {
      const summary = await executeDag([task], 'sys', 'chat-e2e-retry');
      expect(summary).toContain('retry-success');
      expect(calls).toBe(2);
    } finally {
      updateConfig('tools.loops.max_failed_tool_batches', previousFailedThreshold);
    }
  });

  it('records observable fallback event when subagent dispatch fails', async () => {
    const task = makeTask('fallback-a', 'Fallback A', 'Fallback objective');
    hoisted.dependencyMap.set(task.id, []);
    hoisted.isSubAgentAvailableMock.mockReturnValue(true);
    hoisted.dispatchToSubAgentMock.mockResolvedValue({
      success: false,
      output: 'subagent worker failed',
      tokens_used: 0,
      elapsed_ms: 5,
    });

    const client = makeClient(async () => makeResponse('in-process-recovered'));
    hoisted.getClientForTaskMock.mockReturnValue({
      client,
      selection: { provider: 'mock', model: 'mock-model', role: 'simple_subagent' },
    });

    const summary = await executeDag([task], 'sys', 'chat-e2e-fallback', undefined, undefined, 'turn-e2e-fallback', {
      useSubAgents: true,
      subagentRuntimeSource: 'session',
      subagentSessionKey: 'default:chat-e2e-fallback',
    });
    expect(summary).toContain('in-process-recovered');

    const row = getDb().prepare(`
      SELECT payload
      FROM event_log
      WHERE tenant_id = ? AND event_type = 'dag_subagent_fallback' AND entity_type = 'task' AND entity_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get('default', task.id) as { payload: string } | undefined;

    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe('subagent_dispatch_failed');
    expect(payload.fallback).toBe('in_process');
    expect(payload.runtime_source).toBe('session');
    expect(payload.runtime_session_key).toBe('default:chat-e2e-fallback');
  });
});
