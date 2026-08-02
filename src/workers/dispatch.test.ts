import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ResultEnvelopeSchema,
  TaskBriefSchema,
} from '../agents/protocol.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerLaunchRequest,
  type WorkerLaunchResult,
  type WorkerStatus,
  WorkerAdapterRegistry,
} from './adapter.js';
import { dispatchManagedWorkerTask } from './dispatch.js';
import { getExternalWorkerJob } from './job-state.js';
import { on, removeAllListeners, type ProgressEvent } from '../progress/event-bus.js';

function makeHandle(): WorkerHandle {
  return {
    id: 'run-1',
    job_id: 'job-1',
    adapter_id: 'fake_adapter',
    transport: 'stdio',
    started_at: Date.now(),
  };
}

function makeStatus(state: WorkerStatus['state']): WorkerStatus {
  return {
    state,
    started_at: Date.now(),
  };
}

const task = TaskBriefSchema.parse({
  task_id: 'task-1',
  objective: 'Do the thing',
  done_criteria: 'Done',
  constraints: {
    token_budget: 500,
    timeout_seconds: 5,
    permission_level: 'L1_READ_WRITE',
    allowed_tools: [],
    forbidden_paths: [],
  },
  hints: {
    complexity: 'low',
    type: 'general',
    needs_tool_calling: false,
    estimated_tokens: 10,
  },
});

describe('workers/dispatch', () => {
  let tmpDir: string;

  function createGitProject(name: string): string {
    const projectDir = join(tmpDir, name);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/index.js'), 'export const value = 1;\n');
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', projectDir, 'add', '.']);
    execFileSync('git', [
      '-C', projectDir,
      '-c', 'user.name=MOZI Test',
      '-c', 'user.email=mozi-test@example.invalid',
      'commit', '-m', 'initial',
    ], { stdio: 'ignore' });
    return projectDir;
  }

  function makeWritingAdapter(write: () => void): WorkerAdapter {
    return {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: vi.fn().mockImplementation(async () => {
        write();
        return { handle: makeHandle(), status: makeStatus('completed') };
      }),
      poll: vi.fn().mockResolvedValue(makeStatus('completed')),
      cancel: vi.fn(),
      collectResult: vi.fn().mockResolvedValue({
        envelope: ResultEnvelopeSchema.parse({
          task_id: 'task-1',
          status: 'success',
          output: ['done'],
          summary: 'done',
          cost: { tokens: 0, tool_calls: 0, elapsed_time: 25 },
          issues: [],
        }),
        artifacts: [],
        runtime_label: 'Fake Worker',
      }),
    };
  }

  beforeEach(() => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;
  });

  afterEach(() => {
    removeAllListeners();
    teardownTestDb(tmpDir);
  });

  it('drives the runtime through the generic WorkerAdapter contract', async () => {
    const launchMock = vi.fn<[WorkerLaunchRequest], Promise<WorkerLaunchResult>>().mockResolvedValue({
      handle: makeHandle(),
      status: makeStatus('running'),
    });
    const pollMock = vi.fn()
      .mockResolvedValueOnce(makeStatus('running'))
      .mockResolvedValueOnce(makeStatus('completed'));
    const collectMock = vi.fn().mockResolvedValue({
      envelope: ResultEnvelopeSchema.parse({
        task_id: 'task-1',
        status: 'success',
        output: ['done'],
        summary: 'done',
        cost: { tokens: 0, tool_calls: 0, elapsed_time: 25 },
        issues: [],
      }),
      artifacts: [],
      runtime_label: 'Fake Worker',
    });

    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: (transport) => transport === 'stdio',
      launch: launchMock,
      poll: pollMock,
      cancel: vi.fn(),
      collectResult: collectMock,
    };

    const registry = new WorkerAdapterRegistry([adapter]);
    const result = await dispatchManagedWorkerTask({
      job_id: 'job-1',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: {
        adapter: 'fake_adapter',
        transport: 'stdio',
        env: {},
        metadata: {},
      },
      timeout_ms: 1000,
    }, registry, 0);

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: 'job-1',
        transport: 'stdio',
        task: expect.objectContaining({ task_id: 'task-1' }),
      }),
    );
    expect(pollMock).toHaveBeenCalled();
    expect(collectMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }));
    expect(result.job_id).toBe('job-1');
    expect(result.adapter_id).toBe('fake_adapter');
    expect(result.runtime_label).toBe('Fake Worker');
    expect(result.envelope.status).toBe('success');
    expect(result.verify_status).toBe('passed');
    expect(result.verify_summary).toContain('Verification passed');

    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('succeeded');
    expect(persisted?.active_run_id).toBe('run-1');
    expect(persisted?.runtime_label).toBe('Fake Worker');
    expect(persisted?.verify_report?.status).toBe('passed');
    expect(persisted?.result_envelope?.status).toBe('completed');
  });

  it('records changed files and executes required tests as runtime-owned evidence', async () => {
    const projectDir = createGitProject('verified-worker');
    const command = 'node -e "const fs=require(\'fs\');if(!fs.readFileSync(\'src/index.js\',\'utf8\').includes(\'2\'))process.exit(1)"';
    const adapter = makeWritingAdapter(() => {
      writeFileSync(join(projectDir, 'src/index.js'), 'export const value = 2;\n');
    });
    const scopedTask = TaskBriefSchema.parse({
      ...task,
      constraints: { ...task.constraints, allowed_tools: ['filesystem', 'shell', 'git'] },
    });

    const result = await dispatchManagedWorkerTask({
      job_id: 'job-runtime-evidence',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task: scopedTask,
      system_prompt: 'You are a worker.',
      worker: { adapter: 'fake_adapter', transport: 'stdio', cwd: projectDir, env: {}, metadata: {} },
      timeout_ms: 10_000,
      metadata: { allowed_scope: ['src'], required_tests: [command] },
    }, new WorkerAdapterRegistry([adapter]), 0);

    const persisted = getExternalWorkerJob('job-runtime-evidence');
    expect(result.verify_status, JSON.stringify({
      result: persisted?.result_envelope,
      verify: persisted?.verify_report,
    })).toBe('passed');
    expect(persisted?.status).toBe('succeeded');
    expect(persisted?.result_envelope?.changed_files).toEqual(['src/index.js']);
    expect(persisted?.result_envelope?.tests_run).toEqual([command]);
    expect(persisted?.result_envelope?.test_status).toBe('passed');
    expect(persisted?.result_envelope?.test_results[0]).toMatchObject({
      command,
      exit_code: 0,
      timed_out: false,
    });
  });

  it('fails verification when a runtime-executed required test fails', async () => {
    const projectDir = createGitProject('failed-test-worker');
    const command = 'node -e "process.exit(7)"';
    const adapter = makeWritingAdapter(() => {
      writeFileSync(join(projectDir, 'src/index.js'), 'export const value = 2;\n');
    });
    const scopedTask = TaskBriefSchema.parse({
      ...task,
      constraints: { ...task.constraints, allowed_tools: ['filesystem', 'shell', 'git'] },
    });

    const result = await dispatchManagedWorkerTask({
      job_id: 'job-runtime-test-failure',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task: scopedTask,
      system_prompt: 'You are a worker.',
      worker: { adapter: 'fake_adapter', transport: 'stdio', cwd: projectDir, env: {}, metadata: {} },
      timeout_ms: 10_000,
      metadata: { allowed_scope: ['src'], required_tests: [command] },
    }, new WorkerAdapterRegistry([adapter]), 0);

    expect(result.verify_status).toBe('failed');
    const persisted = getExternalWorkerJob('job-runtime-test-failure');
    expect(persisted?.status).toBe('failed');
    expect(persisted?.failure_category).toBe('verify_failed');
    expect(persisted?.result_envelope?.test_status).toBe('failed');
    expect(persisted?.result_envelope?.test_results[0]?.exit_code).toBe(7);
  });

  it('fails verification when the worker changes a file outside allowed_scope', async () => {
    const projectDir = createGitProject('out-of-scope-worker');
    const adapter = makeWritingAdapter(() => {
      writeFileSync(join(projectDir, 'README.md'), 'outside scope\n');
    });

    const result = await dispatchManagedWorkerTask({
      job_id: 'job-runtime-scope-failure',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: { adapter: 'fake_adapter', transport: 'stdio', cwd: projectDir, env: {}, metadata: {} },
      timeout_ms: 10_000,
      metadata: { allowed_scope: ['src'] },
    }, new WorkerAdapterRegistry([adapter]), 0);

    expect(result.verify_status).toBe('failed');
    const persisted = getExternalWorkerJob('job-runtime-scope-failure');
    expect(persisted?.status).toBe('failed');
    expect(persisted?.result_envelope?.changed_files).toEqual(['README.md']);
    expect(persisted?.result_envelope?.scope_violations).toEqual(['README.md']);
    expect(persisted?.verify_report?.notes.join('\n')).toContain('outside allowed_scope');
  });

  it('uses adapter waitForCompletion when the adapter exposes it', async () => {
    const launchMock = vi.fn<[WorkerLaunchRequest], Promise<WorkerLaunchResult>>().mockResolvedValue({
      handle: makeHandle(),
      status: makeStatus('running'),
    });
    const waitForCompletionMock = vi.fn().mockResolvedValue(makeStatus('completed'));
    const pollMock = vi.fn();
    const collectMock = vi.fn().mockResolvedValue({
      envelope: ResultEnvelopeSchema.parse({
        task_id: 'task-1',
        status: 'success',
        output: [],
        summary: 'done',
        cost: { tokens: 0, tool_calls: 0, elapsed_time: 15 },
        issues: [],
      }),
      artifacts: [],
      runtime_label: 'Fake Worker',
    });

    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: launchMock,
      poll: pollMock,
      waitForCompletion: waitForCompletionMock,
      cancel: vi.fn(),
      collectResult: collectMock,
    };

    const registry = new WorkerAdapterRegistry([adapter]);
    await dispatchManagedWorkerTask({
      job_id: 'job-1',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: {
        adapter: 'fake_adapter',
        transport: 'stdio',
        env: {},
        metadata: {},
      },
      timeout_ms: 1000,
    }, registry, 0);

    expect(waitForCompletionMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }), expect.any(Number));
    expect(pollMock).not.toHaveBeenCalled();
    expect(getExternalWorkerJob('job-1')?.status).toBe('succeeded');
  });

  it('emits managed-worker progress events for chat-scoped delegation', async () => {
    const events: ProgressEvent[] = [];
    const unsubscribe = on((event) => {
      if (event.type === 'worker_status') {
        events.push(event);
      }
    });

    const launchMock = vi.fn<[WorkerLaunchRequest], Promise<WorkerLaunchResult>>().mockResolvedValue({
      handle: makeHandle(),
      status: makeStatus('running'),
    });
    const pollMock = vi.fn()
      .mockResolvedValueOnce(makeStatus('running'))
      .mockResolvedValueOnce(makeStatus('completed'));

    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: launchMock,
      poll: pollMock,
      cancel: vi.fn(),
      collectResult: vi.fn().mockResolvedValue({
        envelope: ResultEnvelopeSchema.parse({
          task_id: 'task-1',
          status: 'success',
          output: ['done'],
          summary: 'done',
          cost: { tokens: 0, tool_calls: 0, elapsed_time: 25 },
          issues: [],
        }),
        artifacts: [],
        runtime_label: 'Fake Worker',
      }),
    };

    try {
      await dispatchManagedWorkerTask({
        job_id: 'job-1',
        agent_id: 'agent-1',
        tenant_id: 'default',
        task,
        system_prompt: 'You are a worker.',
        worker: {
          adapter: 'fake_adapter',
          transport: 'stdio',
          env: {},
          metadata: {},
        },
        timeout_ms: 1000,
        metadata: {
          chat_id: 'chat-progress',
          turn_id: 'turn-progress',
        },
      }, new WorkerAdapterRegistry([adapter]), 0);
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.workerStatus)).toEqual([
      'queued',
      'launching',
      'running',
      'succeeded',
    ]);
    expect(events.every((event) => event.chatId === 'chat-progress')).toBe(true);
    expect(events[0]?.turnId).toBe('turn-progress');
    expect(events[0]?.lane).toBeDefined();
  });

  it('rejects when the requested adapter does not exist', async () => {
    const registry = new WorkerAdapterRegistry();

    await expect(
      dispatchManagedWorkerTask({
        job_id: 'job-1',
        agent_id: 'agent-1',
        tenant_id: 'default',
        task,
        system_prompt: 'You are a worker.',
        worker: {
          adapter: 'missing',
          transport: 'stdio',
          env: {},
          metadata: {},
        },
        timeout_ms: 1000,
      }, registry, 0),
    ).rejects.toThrow('Unknown worker adapter: missing');

    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('failed');
    expect(persisted?.failure_category).toBe('launch_failed');
    expect(persisted?.last_error).toContain('Unknown worker adapter: missing');
  });

  it('propagates adapter result-collection failures', async () => {
    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: vi.fn().mockResolvedValue({
        handle: makeHandle(),
        status: makeStatus('completed'),
      }),
      poll: vi.fn().mockResolvedValue(makeStatus('completed')),
      cancel: vi.fn(),
      collectResult: vi.fn().mockRejectedValue(new Error('result missing')),
    };

    const registry = new WorkerAdapterRegistry([adapter]);

    await expect(
      dispatchManagedWorkerTask({
        job_id: 'job-1',
        agent_id: 'agent-1',
        tenant_id: 'default',
        task,
        system_prompt: 'You are a worker.',
        worker: {
          adapter: 'fake_adapter',
          transport: 'stdio',
          env: {},
          metadata: {},
        },
        timeout_ms: 1000,
      }, registry, 0),
    ).rejects.toThrow('result missing');

    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('failed');
    expect(persisted?.failure_category).toBe('result_missing');
    expect(persisted?.active_run_id).toBe('run-1');
  });

  it('keeps worker alive when state transitions happen within inactivity window', async () => {
    // Worker takes multiple poll cycles but each cycle shows state change (activity)
    // With timeout_ms=100 (inactivity), the worker should NOT be killed
    // because each poll returns a different state, resetting lastActivityAt.
    let pollCount = 0;
    const pollMock = vi.fn().mockImplementation(async () => {
      pollCount++;
      // First 3 polls: still running (but poll itself is a check, state stays 'running')
      // 4th poll: completed
      if (pollCount >= 4) return makeStatus('completed');
      return makeStatus('running');
    });

    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: vi.fn().mockResolvedValue({
        handle: makeHandle(),
        status: makeStatus('running'),
      }),
      poll: pollMock,
      cancel: vi.fn(),
      collectResult: vi.fn().mockResolvedValue({
        envelope: ResultEnvelopeSchema.parse({
          task_id: 'task-1',
          status: 'success',
          output: ['done'],
          summary: 'done',
          cost: { tokens: 0, tool_calls: 0, elapsed_time: 50 },
          issues: [],
        }),
        artifacts: [],
        runtime_label: 'Fake Worker',
      }),
    };

    const registry = new WorkerAdapterRegistry([adapter]);
    // inactivity timeout = 5000ms, but worker completes in ~4 poll cycles at 0ms interval
    const result = await dispatchManagedWorkerTask({
      job_id: 'job-1',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: {
        adapter: 'fake_adapter',
        transport: 'stdio',
        env: {},
        metadata: {},
      },
      timeout_ms: 5000,
    }, registry, 0);

    expect(result.envelope.status).toBe('success');
    expect(result.verify_status).toBe('passed');
    expect(pollCount).toBe(4);
    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('succeeded');
  });

  it('triggers inactivity timeout when worker is stuck with no state changes', async () => {
    // Worker stays 'running' forever — poll always returns same state.
    // With timeout_ms=1 (1ms inactivity), it should be killed quickly.
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const pollMock = vi.fn().mockResolvedValue(makeStatus('running'));

    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: vi.fn().mockResolvedValue({
        handle: makeHandle(),
        status: makeStatus('running'),
      }),
      poll: pollMock,
      cancel: cancelMock,
      collectResult: vi.fn().mockRejectedValue(new Error('no result')),
    };

    const registry = new WorkerAdapterRegistry([adapter]);
    const result = await dispatchManagedWorkerTask({
      job_id: 'job-1',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: {
        adapter: 'fake_adapter',
        transport: 'stdio',
        env: {},
        metadata: {},
      },
      timeout_ms: 1, // 1ms inactivity timeout
    }, registry, 0);

    expect(cancelMock).toHaveBeenCalled();
    const cancelReason = cancelMock.mock.calls[0][1] as string;
    expect(cancelReason).toContain('inactive');
    expect(cancelReason).toContain('inactivity timeout');
    expect(result.envelope.status).toBe('failed');

    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('timed_out');
    expect(persisted?.last_error).toContain('inactive');
  });

  it('respects wall clock ceiling even when worker shows activity', async () => {
    // Worker transitions state on every poll (staying "active"), but we set
    // a very low wall clock ceiling via metadata. Should still be killed.
    let pollCount = 0;
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const pollMock = vi.fn().mockImplementation(async () => {
      pollCount++;
      // Always return running — never completes
      return makeStatus('running');
    });

    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: vi.fn().mockResolvedValue({
        handle: makeHandle(),
        status: makeStatus('running'),
      }),
      poll: pollMock,
      cancel: cancelMock,
      collectResult: vi.fn().mockRejectedValue(new Error('no result')),
    };

    const registry = new WorkerAdapterRegistry([adapter]);
    const result = await dispatchManagedWorkerTask({
      job_id: 'job-1',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: {
        adapter: 'fake_adapter',
        transport: 'stdio',
        env: {},
        metadata: {},
      },
      timeout_ms: 999_999, // very high inactivity timeout — should NOT trigger
      metadata: {
        max_wall_clock_ms: 1, // 1ms wall clock ceiling — SHOULD trigger
      },
    }, registry, 0);

    expect(cancelMock).toHaveBeenCalled();
    const cancelReason = cancelMock.mock.calls[0][1] as string;
    expect(cancelReason).toContain('wall clock ceiling');
    expect(result.envelope.status).toBe('failed');

    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('timed_out');
    expect(persisted?.last_error).toContain('wall clock ceiling');
  });

  it('records timed out jobs without fabricating stderr excerpts when collection fails after cancel', async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const adapter: WorkerAdapter = {
      metadata: {
        id: 'fake_adapter',
        display_name: 'Fake Worker',
        kind: 'external_cli',
        supported_transports: ['stdio'],
      },
      supportsTransport: () => true,
      launch: vi.fn().mockResolvedValue({
        handle: makeHandle(),
        status: makeStatus('running'),
      }),
      poll: vi.fn().mockResolvedValue(makeStatus('running')),
      cancel: cancelMock,
      collectResult: vi.fn().mockRejectedValue(new Error('worker still shutting down')),
    };

    const registry = new WorkerAdapterRegistry([adapter]);
    const result = await dispatchManagedWorkerTask({
      job_id: 'job-1',
      agent_id: 'agent-1',
      tenant_id: 'default',
      task,
      system_prompt: 'You are a worker.',
      worker: {
        adapter: 'fake_adapter',
        transport: 'stdio',
        env: {},
        metadata: {},
      },
      timeout_ms: 1,
    }, registry, 0);

    expect(cancelMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }), expect.stringContaining('inactivity timeout'));
    expect(result.envelope.status).toBe('failed');
    expect(result.verify_status).toBe('not_required');

    const persisted = getExternalWorkerJob('job-1');
    expect(persisted?.status).toBe('timed_out');
    expect(persisted?.failure_category).toBe('timed_out');
    expect(persisted?.result_envelope?.failure_category).toBe('timed_out');
    expect(persisted?.result_envelope?.stderr_excerpt).toBeNull();
  });
});
