import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../store/task-dag.js';

const hoisted = vi.hoisted(() => {
  const listAgentsMock = vi.fn().mockReturnValue([]);
  const findBestForCapabilityMock = vi.fn().mockReturnValue(null);
  const spawnMock = vi.fn().mockReturnValue({ id: 'proc_mock', agentId: 'coder', pid: 1234, alive: true, lastHeartbeat: Date.now(), startedAt: Date.now() });
  const sendMock = vi.fn().mockResolvedValue({ task_id: 't1', status: 'success', output: [], summary: 'Done', cost: { tokens: 100, tool_calls: 2, elapsed_time: 500 }, issues: [] });
  const killMock = vi.fn().mockResolvedValue(undefined);
  const notifyMock = vi.fn();
  const selectModelMock = vi.fn().mockReturnValue({ provider: 'mock', model: 'mock-model', role: 'simple_subagent' });
  const getConfigMock = vi.fn().mockReturnValue({
    tools: {
      loops: { subagent_max_iterations: 10, max_elapsed_ms: 600_000 },
      shell: { background_processes: { process_timeout_seconds: 3600 } },
    },
    system: { max_parallel_agents: 5 },
  });
  const dispatchManagedWorkerTaskMock = vi.fn();
  const resolveExternalWorkerAgentConfigMock = vi.fn().mockReturnValue(null);

  const refreshScoreAndMaybeEvolveMock = vi.fn().mockReturnValue({
    breakdown: { evolutionScore: 0.75 },
    decision: { action: 'none' },
  });

  return {
    listAgentsMock,
    findBestForCapabilityMock,
    spawnMock,
    sendMock,
    killMock,
    notifyMock,
    selectModelMock,
    getConfigMock,
    dispatchManagedWorkerTaskMock,
    resolveExternalWorkerAgentConfigMock,
    refreshScoreAndMaybeEvolveMock,
  };
});

vi.mock('../agents/registry.js', () => ({
  list: hoisted.listAgentsMock,
  findBestForCapability: hoisted.findBestForCapabilityMock,
}));

vi.mock('../agents/process-manager.js', () => ({
  spawn: hoisted.spawnMock,
  send: hoisted.sendMock,
  kill: hoisted.killMock,
  notify: hoisted.notifyMock,
}));

vi.mock('../workers/index.js', () => ({
  dispatchManagedWorkerTask: hoisted.dispatchManagedWorkerTaskMock,
  resolveExternalWorkerAgentConfig: hoisted.resolveExternalWorkerAgentConfigMock,
}));

vi.mock('./model-router.js', () => ({
  selectModel: hoisted.selectModelMock,
}));

vi.mock('../agents/protocol.js', async () => {
  const actual = await vi.importActual<typeof import('../agents/protocol.js')>('../agents/protocol.js');
  return actual;
});

vi.mock('../config/index.js', () => ({
  getConfig: hoisted.getConfigMock,
}));

vi.mock('../agents/agent-scoring.js', () => ({
  refreshScoreAndMaybeEvolve: hoisted.refreshScoreAndMaybeEvolveMock,
}));

import { isSubAgentAvailable, selectAgent, dispatchToSubAgent } from './subagent-dispatch.js';

function makeTask(id: string, title: string, objective: string, agentTypeHint = 'any', tags: string[] = []): TaskRecord {
  return {
    id,
    tenant_id: 'default',
    parent_task_id: null,
    title,
    objective,
    done_criteria: 'done',
    status: 'ready',
    assigned_agent: null,
    agent_type_hint: agentTypeHint,
    constraints: {},
    on_dep_failure: 'fail_fast',
    attempts: 0,
    priority: 0,
    tags,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const fakeAgent = {
  id: 'coder',
  tenant_id: 'default',
  name: 'Coder',
  type: 'preset' as const,
  system_prompt: 'You are a coding agent.',
  tools_allowed: ['shell', 'filesystem'],
  permission_level: 'L2_SHELL_EXEC',
  config: { specialization: 'code', capabilities: ['code', 'general'] },
  status: 'active' as const,
  spawn_count: 0,
  success_rate: 0,
  avg_token_cost: 0,
  evolution_score: 0,
  created_by: 'system',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

describe('core/subagent-dispatch', () => {
  beforeEach(() => {
    hoisted.listAgentsMock.mockReset().mockReturnValue([]);
    hoisted.findBestForCapabilityMock.mockReset().mockReturnValue(null);
    hoisted.spawnMock.mockClear();
    hoisted.sendMock.mockReset().mockResolvedValue({
      task_id: 't1', status: 'success', output: [], summary: 'Done',
      cost: { tokens: 100, tool_calls: 2, elapsed_time: 500 }, issues: [],
    });
    hoisted.killMock.mockClear();
    hoisted.notifyMock.mockClear();
    hoisted.selectModelMock.mockClear();
    hoisted.dispatchManagedWorkerTaskMock.mockReset();
    hoisted.resolveExternalWorkerAgentConfigMock.mockReset().mockReturnValue(null);
    hoisted.refreshScoreAndMaybeEvolveMock.mockClear();
  });

  describe('isSubAgentAvailable', () => {
    it('returns false when no active agents exist', () => {
      hoisted.listAgentsMock.mockReturnValue([]);
      expect(isSubAgentAvailable()).toBe(false);
    });

    it('returns true when active agents exist', () => {
      hoisted.listAgentsMock.mockReturnValue([fakeAgent]);
      expect(isSubAgentAvailable()).toBe(true);
    });
  });

  describe('selectAgent', () => {
    it('matches by inferred capability', () => {
      const task = makeTask('t1', 'Code task', 'Write code', 'code');
      hoisted.findBestForCapabilityMock.mockImplementation((cap: string) => {
        if (cap === 'code') return fakeAgent;
        return null;
      });

      const result = selectAgent(task);
      expect(result).toBe(fakeAgent);
      expect(hoisted.findBestForCapabilityMock).toHaveBeenCalledWith('code', 'default');
    });

    it('falls back to coder when specific capability not found', () => {
      const task = makeTask('t1', 'Research', 'Find info', 'research');
      hoisted.findBestForCapabilityMock.mockImplementation((cap: string) => {
        if (cap === 'code') return fakeAgent;
        return null;
      });

      const result = selectAgent(task);
      expect(result).toBe(fakeAgent);
    });

    it('falls back to first active agent as last resort', () => {
      const task = makeTask('t1', 'Task', 'Do something', 'any');
      hoisted.findBestForCapabilityMock.mockReturnValue(null);
      hoisted.listAgentsMock.mockReturnValue([fakeAgent]);

      const result = selectAgent(task);
      expect(result).toBe(fakeAgent);
    });

    it('returns null when no agents at all', () => {
      const task = makeTask('t1', 'Task', 'Do something', 'any');
      hoisted.findBestForCapabilityMock.mockReturnValue(null);
      hoisted.listAgentsMock.mockReturnValue([]);

      const result = selectAgent(task);
      expect(result).toBeNull();
    });
  });

  describe('dispatchToSubAgent', () => {
    it('returns failure when no agent available', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(null);
      hoisted.listAgentsMock.mockReturnValue([]);

      const task = makeTask('t1', 'Task', 'Do something');
      const result = await dispatchToSubAgent(task, 'system prompt', undefined, {
        chatId: 'chat-42',
        turnId: 'turn-42',
        runtimeSource: 'session',
        runtimeSessionKey: 'default:chat-42',
      });

      expect(result.success).toBe(false);
      expect(result.output).toBe('No SubAgent available');
      expect(hoisted.spawnMock).not.toHaveBeenCalled();
    });

    it('spawns, sends, and kills on success', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);

      const task = makeTask('t1', 'Code task', 'Write some code', 'code');
      task.tenant_id = 'tenant_acme';
      const result = await dispatchToSubAgent(task, 'system prompt');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Done');
      expect(result.tokens_used).toBe(100);
      expect(hoisted.spawnMock).toHaveBeenCalledOnce();
      expect(hoisted.sendMock).toHaveBeenCalledOnce();
      expect(hoisted.sendMock).toHaveBeenCalledWith(
        'proc_mock',
        'execute_task',
        expect.anything(),
        300_000,
      );
      expect(hoisted.killMock).toHaveBeenCalledOnce();
      expect(hoisted.findBestForCapabilityMock).toHaveBeenCalledWith('code', 'tenant_acme');
      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        'coder',
        expect.objectContaining({ tenant_id: 'tenant_acme' }),
      );
    });

    it('caps subagent permission level by the session permission level', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);

      const task = makeTask('t-cap', 'Code task', 'Write some code', 'code');
      const result = await dispatchToSubAgent(task, 'system prompt', undefined, {
        permissionLevel: 'L0_READ_ONLY',
      });

      expect(result.success).toBe(true);
      const brief = hoisted.sendMock.mock.calls[0][2];
      expect(brief.constraints.permission_level).toBe('L0_READ_ONLY');
      expect(brief.objective).toContain('agent manifest level L2_SHELL_EXEC');
      expect(brief.objective).toContain('session level L0_READ_ONLY');
      expect(hoisted.spawnMock).toHaveBeenCalledWith(
        'coder',
        expect.objectContaining({ permission_level: 'L0_READ_ONLY' }),
      );
    });

    it('returns failure and kills on send error', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);
      hoisted.sendMock.mockRejectedValue(new Error('RPC timeout'));

      const task = makeTask('t1', 'Task', 'Objective');
      const result = await dispatchToSubAgent(task, 'system prompt');

      expect(result.success).toBe(false);
      expect(result.output).toContain('RPC timeout');
      expect(hoisted.killMock).toHaveBeenCalledOnce();
    });

    it('derives default timeout from loop budget instead of background process timeout', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);
      hoisted.getConfigMock.mockReturnValueOnce({
        tools: {
          loops: { subagent_max_iterations: 10, max_elapsed_ms: 120_000 },
          shell: { background_processes: { process_timeout_seconds: 3600 } },
        },
        system: { max_parallel_agents: 5 },
      });

      const task = makeTask('t-timeout', 'Task', 'Objective');
      await dispatchToSubAgent(task, 'system prompt');

      expect(hoisted.sendMock).toHaveBeenCalledWith(
        'proc_mock',
        'execute_task',
        expect.anything(),
        120_000,
      );
    });

    it('returns failure when envelope status is failed', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);
      hoisted.sendMock.mockResolvedValue({
        task_id: 't1', status: 'failed', output: [], summary: 'Task failed: something broke',
        cost: { tokens: 50, tool_calls: 1, elapsed_time: 200 }, issues: ['error'],
      });

      const task = makeTask('t1', 'Task', 'Objective');
      const result = await dispatchToSubAgent(task, 'system prompt');

      expect(result.success).toBe(false);
      expect(result.output).toContain('something broke');
    });

    it('updates evolution score on success', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);

      const task = makeTask('t1', 'Code task', 'Write code', 'code');
      await dispatchToSubAgent(task, 'system prompt');

      expect(hoisted.refreshScoreAndMaybeEvolveMock).toHaveBeenCalledWith('coder', 'default');
    });

    it('updates evolution score on send error', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);
      hoisted.sendMock.mockRejectedValue(new Error('timeout'));

      const task = makeTask('t1', 'Task', 'Objective');
      await dispatchToSubAgent(task, 'system prompt');

      expect(hoisted.refreshScoreAndMaybeEvolveMock).toHaveBeenCalledWith('coder', 'default');
    });

    it('passes dependency context to objective', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);

      const task = makeTask('t1', 'Task B', 'Continue from A');
      await dispatchToSubAgent(task, 'system prompt', 'Context from Task A');

      const sendCall = hoisted.sendMock.mock.calls[0];
      const brief = sendCall[2];
      expect(brief.objective).toContain('Context from Task A');
    });

    it('returns cancelled when abort signal is triggered', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue(fakeAgent);
      hoisted.sendMock.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          task_id: 't1',
          status: 'success',
          output: [],
          summary: 'late result',
          cost: { tokens: 10, tool_calls: 0, elapsed_time: 100 },
          issues: [],
        };
      });

      const controller = new AbortController();
      const task = makeTask('t1', 'Cancelable task', 'Objective');
      const promise = dispatchToSubAgent(task, 'system prompt', undefined, { abortSignal: controller.signal });
      controller.abort(new Error('cancel from test'));

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(hoisted.notifyMock).toHaveBeenCalledWith(
        'proc_mock',
        'cancel_task',
        expect.objectContaining({ task_id: 't1' }),
      );
    });

    it('routes external-worker agents through managed worker dispatch', async () => {
      hoisted.findBestForCapabilityMock.mockReturnValue({
        ...fakeAgent,
        config: {
          ...fakeAgent.config,
          external_worker: {
            adapter: 'claude_code',
            transport: 'stdio',
          },
        },
      });
      hoisted.resolveExternalWorkerAgentConfigMock.mockReturnValue({
        adapter: 'claude_code',
        transport: 'stdio',
        env: {},
        metadata: {},
      });
      hoisted.dispatchManagedWorkerTaskMock.mockResolvedValue({
        job_id: 'worker_job_t1',
        run_id: 'run-1',
        adapter_id: 'claude_code',
        runtime_label: 'Claude Code',
        verify_status: 'pending',
        verify_summary: 'Awaiting verifier review',
        envelope: {
          task_id: 't1',
          status: 'success',
          output: ['done'],
          summary: 'done',
          cost: { tokens: 123, tool_calls: 0, elapsed_time: 1000 },
          issues: [],
        },
      });

      const task = makeTask('t1', 'Code task', 'Write some code', 'code');
      const result = await dispatchToSubAgent(task, 'system prompt', undefined, {
        chatId: 'chat-42',
        turnId: 'turn-42',
        runtimeSource: 'session',
        runtimeSessionKey: 'default:chat-42',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('done');
      expect(hoisted.dispatchManagedWorkerTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'coder',
          worker: expect.objectContaining({ adapter: 'claude_code' }),
          metadata: expect.objectContaining({
            chat_id: 'chat-42',
            turn_id: 'turn-42',
            runtime_source: 'session',
            runtime_session_key: 'default:chat-42',
          }),
          abort_signal: undefined,
        }),
      );
      expect(hoisted.spawnMock).not.toHaveBeenCalled();
    });
  });
});
