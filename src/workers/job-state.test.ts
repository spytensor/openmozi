import { afterEach, describe, expect, it } from 'vitest';
import {
  ResultEnvelopeSchema,
  TaskBriefSchema,
} from '../agents/protocol.js';
import { closeDb, initDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { ManagedWorkerTaskInput } from './adapter.js';
import {
  buildExternalWorkerArtifactRefs,
  buildExternalWorkerResultEnvelope,
  buildExternalWorkerTaskSpec,
  createExternalWorkerJob,
  createPendingVerifyReport,
  createSynchronousVerifyReport,
  deriveFailureCategory,
  getExternalWorkerJob,
  getLatestExternalWorkerJobForChat,
  listExternalWorkerJobs,
  listExternalWorkerJobsForChat,
  persistExternalWorkerJob,
  reapStaleWorkerJobs,
  transitionExternalWorkerJob,
} from './job-state.js';

const task = TaskBriefSchema.parse({
  task_id: 'task-158',
  objective: 'Persist a managed worker job',
  done_criteria: 'Durable job state exists',
  constraints: {
    token_budget: 800,
    timeout_seconds: 30,
    permission_level: 'L1_READ_WRITE',
    allowed_tools: ['filesystem'],
    forbidden_paths: ['/etc'],
  },
  hints: {
    complexity: 'medium',
    type: 'general',
    needs_tool_calling: true,
    estimated_tokens: 200,
  },
});

function makeInput(overrides: Partial<ManagedWorkerTaskInput> = {}): ManagedWorkerTaskInput {
  return {
    job_id: 'job-158',
    agent_id: 'agent-158',
    tenant_id: 'tenant-a',
    task,
    system_prompt: 'You are a managed worker.',
    worker: {
      adapter: 'generic_cli',
      transport: 'stdio',
      cwd: '/repo/mozi',
      env: {},
      metadata: {},
    },
    timeout_ms: 15_000,
    metadata: {
      issue_id: '#158',
      allowed_scope: ['src/workers', 'src/store'],
      non_goals: ['mcp', 'skill wrappers'],
      acceptance_criteria: ['persist and reload jobs'],
      required_tests: ['pnpm vitest run src/workers/job-state.test.ts'],
      task_spec_path: '/tmp/job-158-spec.md',
      result_path: '/tmp/job-158-result.json',
      stdout_path: '/tmp/job-158.stdout',
      stderr_path: '/tmp/job-158.stderr',
    },
    ...overrides,
  };
}

let tmpDir: string | null = null;
let dbPath: string | null = null;

afterEach(() => {
  if (tmpDir) {
    teardownTestDb(tmpDir);
    tmpDir = null;
    dbPath = null;
  } else {
    closeDb();
  }
});

describe('workers/job-state', () => {
  it('builds structured task specs and artifact refs from managed worker input', () => {
    const input = makeInput();

    const taskSpec = buildExternalWorkerTaskSpec(input);
    const artifactRefs = buildExternalWorkerArtifactRefs(input);

    expect(taskSpec.schema_version).toBe(1);
    expect(taskSpec.issue_id).toBe('#158');
    expect(taskSpec.allowed_scope).toEqual(['src/workers', 'src/store']);
    expect(taskSpec.non_goals).toEqual(['mcp', 'skill wrappers']);
    expect(taskSpec.acceptance_criteria).toEqual(['persist and reload jobs']);
    expect(taskSpec.required_tests).toEqual(['pnpm vitest run src/workers/job-state.test.ts']);
    expect(taskSpec.working_directory).toBe('/repo/mozi');
    expect(artifactRefs).toEqual({
      working_directory: '/repo/mozi',
      task_spec_path: '/tmp/job-158-spec.md',
      result_path: '/tmp/job-158-result.json',
      stdout_path: '/tmp/job-158.stdout',
      stderr_path: '/tmp/job-158.stderr',
    });
  });

  it('enforces explicit lifecycle transitions', () => {
    const queued = createExternalWorkerJob(makeInput());

    expect(() => transitionExternalWorkerJob(queued, 'running')).toThrow(
      'Invalid external worker job transition: queued -> running',
    );

    const launching = transitionExternalWorkerJob(queued, 'launching');
    expect(launching.status).toBe('launching');
    expect(launching.started_at).toBeTruthy();
    expect(launching.completed_at).toBeNull();

    const running = transitionExternalWorkerJob(launching, 'running', {
      active_run_id: 'run-158',
      runtime_label: 'Generic CLI',
    });
    expect(running.active_run_id).toBe('run-158');
    expect(running.runtime_label).toBe('Generic CLI');

    const persistedResult = buildExternalWorkerResultEnvelope({
      job: running,
      result: ResultEnvelopeSchema.parse({
        task_id: task.task_id,
        status: 'success',
        output: ['done'],
        summary: 'done',
        cost: { tokens: 0, tool_calls: 0, elapsed_time: 10 },
        issues: [],
      }),
      artifacts: ['/tmp/job-158-result.json'],
      runtime_label: 'Generic CLI',
    });
    const pendingVerify = transitionExternalWorkerJob(running, 'completed_pending_verify', {
      result_envelope: persistedResult,
      verify_report: createPendingVerifyReport(running),
    });
    expect(pendingVerify.status).toBe('completed_pending_verify');
    expect(pendingVerify.completed_at).toBeTruthy();
    expect(pendingVerify.verify_report?.status).toBe('pending');

    const succeeded = transitionExternalWorkerJob(pendingVerify, 'succeeded', {
      verify_report: {
        ...pendingVerify.verify_report!,
        status: 'passed',
        artifact_check: 'passed',
      },
    });
    expect(succeeded.status).toBe('succeeded');

    expect(() => transitionExternalWorkerJob(succeeded, 'failed')).toThrow(
      'Invalid external worker job transition: succeeded -> failed',
    );
  });

  it('builds a passing synchronous verify report when runtime success has no explicit verifier requirements', () => {
    const running = transitionExternalWorkerJob(
      transitionExternalWorkerJob(createExternalWorkerJob(makeInput({
        metadata: {},
      })), 'launching'),
      'running',
      { active_run_id: 'run-verify', runtime_label: 'Generic CLI' },
    );
    const completed = transitionExternalWorkerJob(running, 'completed_pending_verify', {
      result_envelope: buildExternalWorkerResultEnvelope({
        job: running,
        result: ResultEnvelopeSchema.parse({
          task_id: task.task_id,
          status: 'success',
          output: ['Updated worker runtime'],
          summary: 'Updated worker runtime',
          cost: { tokens: 0, tool_calls: 0, elapsed_time: 25 },
          issues: [],
        }),
        runtime_label: 'Generic CLI',
      }),
      verify_report: createPendingVerifyReport(running),
    });

    const verify = createSynchronousVerifyReport(completed);
    expect(verify.status).toBe('passed');
    expect(verify.summary).toContain('Verification passed');
  });

  it('persists jobs and reloads them after database restart', () => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;
    dbPath = db.dbPath;

    const queued = createExternalWorkerJob(makeInput());
    persistExternalWorkerJob(queued);

    const running = transitionExternalWorkerJob(
      transitionExternalWorkerJob(queued, 'launching'),
      'running',
      {
        active_run_id: 'run-158',
        runtime_label: 'Generic CLI',
      },
    );

    const completed = transitionExternalWorkerJob(running, 'completed_pending_verify', {
      result_envelope: buildExternalWorkerResultEnvelope({
        job: running,
        result: ResultEnvelopeSchema.parse({
          task_id: task.task_id,
          status: 'success',
          output: ['completed'],
          summary: 'completed',
          cost: { tokens: 0, tool_calls: 0, elapsed_time: 25 },
          issues: [],
        }),
        artifacts: ['/tmp/job-158-result.json'],
        runtime_label: 'Generic CLI',
      }),
      verify_report: createPendingVerifyReport(running),
    });
    persistExternalWorkerJob(completed);

    closeDb();
    initDb(dbPath);

    const reloaded = getExternalWorkerJob('job-158', 'tenant-a');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.created_at).toBe(queued.created_at);
    expect(reloaded?.status).toBe('completed_pending_verify');
    expect(reloaded?.active_run_id).toBe('run-158');
    expect(reloaded?.result_envelope?.status).toBe('completed');
    expect(reloaded?.artifact_refs.result_path).toBe('/tmp/job-158-result.json');
    expect(reloaded?.verify_report?.tests_checked).toEqual(['pnpm vitest run src/workers/job-state.test.ts']);

    const listed = listExternalWorkerJobs({
      tenant_id: 'tenant-a',
      statuses: ['completed_pending_verify'],
      adapter_id: 'generic_cli',
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('job-158');
  });

  it('bounds list queries with an explicit limit', () => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;

    const first = createExternalWorkerJob(makeInput({ job_id: 'job-158-a' }));
    const second = createExternalWorkerJob(makeInput({ job_id: 'job-158-b' }));
    persistExternalWorkerJob(first);
    persistExternalWorkerJob(second);

    const listed = listExternalWorkerJobs({
      tenant_id: 'tenant-a',
      limit: 1,
    });

    expect(listed).toHaveLength(1);
    expect(['job-158-a', 'job-158-b']).toContain(listed[0]?.id);
  });

  it('lists and resolves worker jobs by chat id from metadata', () => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;

    const chatAJob = createExternalWorkerJob(makeInput({
      job_id: 'job-chat-a',
      metadata: { chat_id: 'chat-a', turn_id: 'turn-a' },
    }));
    const chatALaunching = transitionExternalWorkerJob(chatAJob, 'launching');
    const chatARunning = transitionExternalWorkerJob(chatALaunching, 'running', {
      active_run_id: 'run-chat-a',
      runtime_label: 'Claude Code',
    });
    persistExternalWorkerJob(chatARunning);

    const chatBJob = createExternalWorkerJob(makeInput({
      job_id: 'job-chat-b',
      metadata: { chat_id: 'chat-b', turn_id: 'turn-b' },
    }));
    persistExternalWorkerJob(chatBJob);

    const listed = listExternalWorkerJobsForChat('chat-a', 'tenant-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('job-chat-a');

    const latest = getLatestExternalWorkerJobForChat('chat-a', 'tenant-a');
    expect(latest?.id).toBe('job-chat-a');
    expect(latest?.metadata.chat_id).toBe('chat-a');
  });

  it('maps runtime failures into explicit external worker failure categories', () => {
    expect(deriveFailureCategory({ status: 'failed', launchFailed: true })).toBe('launch_failed');
    expect(deriveFailureCategory({ status: 'running', stalled: true })).toBe('stalled');
    expect(deriveFailureCategory({ status: 'failed', resultMissing: true })).toBe('result_missing');
    expect(deriveFailureCategory({ status: 'failed', verifyFailed: true })).toBe('verify_failed');
    expect(deriveFailureCategory({ status: 'timed_out' })).toBe('timed_out');
    expect(deriveFailureCategory({ status: 'failed' })).toBe('runtime_error');
    expect(deriveFailureCategory({ status: 'succeeded' })).toBeNull();
  });

  it('reaps stale in-flight jobs older than the age threshold', () => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;

    // Create a job and transition it to running
    const job = createExternalWorkerJob(makeInput({ job_id: 'stale-job-1' }));
    const launching = transitionExternalWorkerJob(job, 'launching');
    let running = transitionExternalWorkerJob(launching, 'running', {
      active_run_id: 'run-stale',
      runtime_label: 'Test CLI',
    });

    // Backdate updated_at to 2 hours ago so it's considered stale
    const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
    running = { ...running, updated_at: twoHoursAgo };
    persistExternalWorkerJob(running);

    // Also create a fresh running job that should NOT be reaped
    const fresh = createExternalWorkerJob(makeInput({ job_id: 'fresh-job-1' }));
    const freshLaunching = transitionExternalWorkerJob(fresh, 'launching');
    const freshRunning = transitionExternalWorkerJob(freshLaunching, 'running', {
      active_run_id: 'run-fresh',
      runtime_label: 'Test CLI',
    });
    persistExternalWorkerJob(freshRunning);

    // Also create a completed job that should NOT be reaped
    const completed = createExternalWorkerJob(makeInput({ job_id: 'done-job-1' }));
    const cLaunching = transitionExternalWorkerJob(completed, 'launching');
    const cRunning = transitionExternalWorkerJob(cLaunching, 'running', {
      active_run_id: 'run-done',
      runtime_label: 'Test CLI',
    });
    const cDone = transitionExternalWorkerJob(cRunning, 'completed_pending_verify', {
      result_envelope: buildExternalWorkerResultEnvelope({
        job: cRunning,
        result: ResultEnvelopeSchema.parse({
          task_id: task.task_id, status: 'success', output: ['ok'],
          summary: 'ok', cost: { tokens: 0, tool_calls: 0, elapsed_time: 5 }, issues: [],
        }),
        artifacts: [],
        runtime_label: 'Test CLI',
      }),
      verify_report: createPendingVerifyReport(cRunning),
    });
    persistExternalWorkerJob(cDone);

    const reaped = reapStaleWorkerJobs(3_600_000); // 1h threshold
    expect(reaped).toBe(1);

    // Stale job should now be failed
    const staleReloaded = getExternalWorkerJob('stale-job-1', 'tenant-a');
    expect(staleReloaded?.status).toBe('failed');
    expect(staleReloaded?.failure_category).toBe('stalled');
    expect(staleReloaded?.last_error).toContain('Reaped as stale');

    // Fresh running job should still be running
    const freshReloaded = getExternalWorkerJob('fresh-job-1', 'tenant-a');
    expect(freshReloaded?.status).toBe('running');

    // Completed job should still be completed
    const doneReloaded = getExternalWorkerJob('done-job-1', 'tenant-a');
    expect(doneReloaded?.status).toBe('completed_pending_verify');
  });
});
