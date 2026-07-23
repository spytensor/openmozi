import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultEnvelopeSchema } from '../agents/protocol.js';
import type { MoziConfig } from '../config/index.js';
import type { ToolCall } from '../core/llm.js';
import { on, removeAllListeners, type ProgressEvent } from '../progress/event-bus.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerLaunchRequest,
  type WorkerLaunchResult,
  type WorkerStatus,
  WorkerAdapterRegistry,
} from '../workers/adapter.js';
import { dispatchManagedWorkerTask } from '../workers/dispatch.js';
import { getExternalWorkerJob } from '../workers/job-state.js';
import type { WorkerPreflightReport } from '../workers/preflight.js';
import { getToolDefinition } from './definitions.js';
import {
  __setDelegateCodingTaskDepsForTests,
} from './delegation-tools.js';
import { executeTool } from './executor.js';

function makeToolCall(args: Record<string, unknown>): ToolCall {
  return {
    id: 'call-delegate',
    type: 'function',
    function: {
      name: 'delegate_coding_task',
      arguments: JSON.stringify(args),
    },
  };
}

function makeConfig(available = ['fake_coding_worker']): MoziConfig {
  return {
    coding_worker: {
      routing: 'auto',
      available,
    },
  } as MoziConfig;
}

function makeHandle(jobId: string): WorkerHandle {
  return {
    id: 'run-fake-1',
    job_id: jobId,
    adapter_id: 'fake_coding_worker',
    transport: 'stdio',
    started_at: Date.now(),
  };
}

function makeStatus(state: WorkerStatus['state']): WorkerStatus {
  return {
    state,
    started_at: Date.now(),
    completed_at: state === 'completed' ? Date.now() : undefined,
  };
}

function makePreflight(status: WorkerPreflightReport['status'] = 'ready'): WorkerPreflightReport {
  const ok = status === 'ready';
  return {
    adapter_id: 'fake_coding_worker',
    command: null,
    command_path: null,
    auth_source: null,
    lane: 'code',
    sandbox_profile: 'workspace-write',
    status,
    checks: ok
      ? [
        { id: 'transport', ok: true, severity: 'hard', summary: 'Transport stdio supported' },
        { id: 'auth', ok: true, severity: 'hard', summary: 'Adapter-specific auth check not required' },
      ]
      : [
        { id: 'command', ok: false, severity: 'hard', summary: 'Command fake-worker not found in PATH' },
      ],
    health: {
      status: 'healthy',
      consecutive_failures: 0,
      last_success_at: null,
      last_failure_at: null,
      avg_latency_ms: null,
    },
    live_probe: {
      enabled: false,
      ok: true,
      summary: 'Live probe disabled',
    },
    generated_at: new Date().toISOString(),
    summary: ok ? 'Managed worker ready' : 'Command fake-worker not found in PATH',
  };
}

function makeFakeAdapter() {
  let launchedTaskId = '';
  const launchMock = vi.fn<[WorkerLaunchRequest], Promise<WorkerLaunchResult>>()
    .mockImplementation(async (request) => {
      launchedTaskId = request.task.task_id;
      return {
        handle: makeHandle(request.job_id),
        status: makeStatus('running'),
      };
    });
  const pollMock = vi.fn().mockResolvedValue(makeStatus('completed'));
  const collectMock = vi.fn().mockImplementation(async () => ({
    envelope: ResultEnvelopeSchema.parse({
      task_id: launchedTaskId,
      status: 'success',
      output: ['fake worker completed through dispatch'],
      summary: 'fake worker completed through dispatch',
      cost: { tokens: 0, tool_calls: 0, elapsed_time: 10 },
      issues: [],
    }),
    artifacts: ['/tmp/fake-worker-report.md'],
    runtime_label: 'Fake Coding Worker',
  }));

  const adapter: WorkerAdapter = {
    metadata: {
      id: 'fake_coding_worker',
      display_name: 'Fake Coding Worker',
      kind: 'external_cli',
      supported_transports: ['stdio'],
      supported_lanes: ['review', 'code'],
      supported_sandbox_profiles: ['read-only', 'workspace-write'],
    },
    supportsTransport: (transport) => transport === 'stdio',
    launch: launchMock,
    poll: pollMock,
    cancel: vi.fn(),
    collectResult: collectMock,
  };

  return { adapter, launchMock, pollMock, collectMock };
}

describe('tools/delegate_coding_task', () => {
  let tmpDir: string;

  beforeEach(() => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;
  });

  afterEach(() => {
    __setDelegateCodingTaskDepsForTests(null);
    removeAllListeners();
    teardownTestDb(tmpDir);
  });

  it('registers delegate_coding_task for Brain tool calls', () => {
    expect(getToolDefinition('delegate_coding_task')?.function.name).toBe('delegate_coding_task');
  });

  it('reaches the managed-worker dispatch pipeline via the Brain tool executor', async () => {
    const events: ProgressEvent[] = [];
    const unsubscribe = on((event) => {
      if (event.type === 'worker_status') {
        events.push(event);
      }
    });
    const { adapter, launchMock, pollMock, collectMock } = makeFakeAdapter();
    const registry = new WorkerAdapterRegistry([adapter]);

    __setDelegateCodingTaskDepsForTests({
      getConfig: () => makeConfig(),
      getRegistry: () => registry,
      inspectPreflight: vi.fn().mockResolvedValue(makePreflight('ready')),
      dispatch: dispatchManagedWorkerTask,
    });

    try {
      const result = await executeTool(
        makeToolCall({
          objective: 'Update the worker delegation wiring',
          done_criteria: 'Dispatch pipeline is reached',
        }),
        {
          tenantId: 'default',
          chatId: 'chat-delegate',
          sessionId: 'session-delegate',
          turnId: 'turn-delegate',
          agentId: 'session:session-delegate',
          permissionLevel: 'L2_SHELL_EXEC',
        },
      );

      expect(result.is_error).toBe(false);
      expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({
        transport: 'stdio',
        task: expect.objectContaining({
          objective: 'Update the worker delegation wiring',
        }),
      }));
      const workerPrompt = launchMock.mock.calls[0]?.[0].system_prompt ?? '';
      expect(workerPrompt).toContain('allowed scope');
      expect(workerPrompt).toContain('Never fabricate');
      expect(workerPrompt).toContain('required tests');
      expect(workerPrompt).toContain('untrusted input');
      expect(workerPrompt).not.toContain('Runtime Capability Contract');
      expect(workerPrompt).not.toContain('Available Tools');
      expect(workerPrompt).not.toContain('USER.md');
      expect(pollMock).toHaveBeenCalled();
      expect(collectMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-fake-1' }));

      const parsed = JSON.parse(result.content) as {
        job_id: string;
        job_status: string;
        worker: { adapter_id: string; runtime_label: string; run_id: string };
        result: { status: string; summary: string };
        verify_status: string;
      };
      expect(parsed.job_id).toMatch(/^external_worker_/);
      expect(parsed.job_status).toBe('succeeded');
      expect(parsed.worker.adapter_id).toBe('fake_coding_worker');
      expect(parsed.worker.runtime_label).toBe('Fake Coding Worker');
      expect(parsed.result.status).toBe('success');
      expect(parsed.verify_status).toBe('passed');
      expect(result.produced_files).toEqual(['/tmp/fake-worker-report.md']);

      const persisted = getExternalWorkerJob(parsed.job_id);
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('succeeded');
      expect(persisted?.agent_id).toBe('coding_worker:fake_coding_worker');
      expect(persisted?.adapter_id).toBe('fake_coding_worker');
      expect(persisted?.active_run_id).toBe('run-fake-1');
      expect(persisted?.result_envelope?.status).toBe('completed');
      expect(persisted?.verify_report?.status).toBe('passed');

      expect(events.map((event) => event.workerStatus)).toEqual([
        'queued',
        'launching',
        'running',
        'succeeded',
      ]);
      expect(events.every((event) => event.chatId === 'chat-delegate')).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('returns an explicit worker-not-ready error instead of falling back', async () => {
    const { adapter } = makeFakeAdapter();
    const registry = new WorkerAdapterRegistry([adapter]);
    const dispatch = vi.fn();

    __setDelegateCodingTaskDepsForTests({
      getConfig: () => makeConfig(),
      getRegistry: () => registry,
      inspectPreflight: vi.fn().mockResolvedValue(makePreflight('blocked')),
      dispatch,
    });

    const result = await executeTool(
      makeToolCall({
        objective: 'Try to delegate when no worker is ready',
      }),
      {
        tenantId: 'default',
        chatId: 'chat-delegate',
        sessionId: 'session-delegate',
        agentId: 'session:session-delegate',
        permissionLevel: 'L2_SHELL_EXEC',
      },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Delegation failed: worker not ready');
    expect(result.content).toContain('Command fake-worker not found in PATH');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
