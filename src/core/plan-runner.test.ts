import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  executeDagMock: vi.fn(),
  verifyPlanSemanticsMock: vi.fn(),
  deliverAssistantMessageMock: vi.fn().mockReturnValue({ delivered: 1 }),
  deliverBackgroundTaskUpdateMock: vi.fn(),
  broadcastArtifactEventMock: vi.fn(),
}));

vi.mock('./dag-executor.js', () => ({
  executeDag: hoisted.executeDagMock,
}));

vi.mock('./plan-semantic-verifier.js', () => ({
  verifyPlanSemantics: hoisted.verifyPlanSemanticsMock,
}));

vi.mock('../channels/websocket.js', () => ({
  deliverAssistantMessage: hoisted.deliverAssistantMessageMock,
  deliverBackgroundTaskUpdate: hoisted.deliverBackgroundTaskUpdateMock,
  broadcastArtifactEvent: hoisted.broadcastArtifactEventMock,
}));

import {
  createPlanTasks,
  getPlanSteps,
  startDetachedPlanRun,
  resumeIncompletePlans,
  restartPlanFromMetadata,
  isPlanRunActive,
  waitForPlanRun,
  planBackgroundTurnId,
  buildPlanToolContext,
  type PlanRunContext,
} from './plan-runner.js';
import { getById, listPlanRootTasks, resetColumnsEnsured, updateStatus, updateTask, type TaskRecord } from '../store/task-dag.js';
import { getTurnEnvelope } from '../memory/turn-envelopes.js';
import { on as onProgressEvent, type ProgressEvent } from '../progress/event-bus.js';
import { loadTaskMetadata, loadTaskResult, persistTaskMetadata, persistTaskResult } from '../tasks/workspace.js';
import type { DecomposeTaskInput } from './dag-bridge.js';
import { addSessionScopeGrant, createSession, updateSessionPermissionLevel } from '../memory/sessions.js';
import { saveTimelineItem } from '../memory/session-timeline.js';

const PLAN: DecomposeTaskInput = {
  goal: 'Quarterly tax update report',
  all_steps_independent: false,
  subtasks: [
    { title: 'Collect policy sources', objective: 'Gather Q2 policy texts', done_criteria: 'sources listed', depends_on: [], agent_type_hint: 'any', constraints: {} },
    { title: 'Draft analysis', objective: 'Draft the analysis section', done_criteria: 'draft exists', depends_on: [0], agent_type_hint: 'any', constraints: {} },
  ],
};

function makeCtx(overrides: Partial<PlanRunContext> = {}): PlanRunContext {
  return {
    tenantId: 'default',
    chatId: 'chat-plan-test',
    sessionId: 'sess-plan-test',
    systemPrompt: '# SOUL.md — Runtime Identity\nTest plan brain.',
    ...overrides,
  };
}

async function waitForRunToFinish(rootTaskId: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (isPlanRunActive(rootTaskId)) {
    if (Date.now() - start > timeoutMs) throw new Error('plan run did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Simulate the real executor contract: mark scope tasks terminal in the DB. */
function executeDagMarks(status: 'completed' | 'failed', output = 'dag output') {
  hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
    for (const task of tasks) {
      updateStatus(task.id, status, task.tenant_id);
    }
    return output;
  });
}

describe('core/plan-runner', () => {
  let tmpDir: string;

  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetColumnsEnsured();
    hoisted.executeDagMock.mockReset();
    hoisted.verifyPlanSemanticsMock.mockReset().mockResolvedValue({
      required: true,
      passed: true,
      outcome: 'passed',
      verdict: 'passed',
      summary: 'Persisted results satisfy the original request.',
      findings: [],
      evidenceIds: ['result:test'],
      checkedAt: '2026-07-19T00:00:00.000Z',
      asOf: '2026-07-19T00:00:00.000Z',
    });
    hoisted.deliverAssistantMessageMock.mockClear();
    hoisted.deliverBackgroundTaskUpdateMock.mockClear();
    hoisted.broadcastArtifactEventMock.mockClear();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('createPlanTasks persists root + children with dependencies and delivery metadata', () => {
    const executionModel = { provider: 'openai', model: 'gpt-5.6-luna' };
    const created = createPlanTasks(PLAN, makeCtx({ executionModel }));

    const root = getById(created.rootTaskId, 'default');
    expect(root).not.toBeNull();
    expect(root!.parent_task_id).toBeNull();
    expect(root!.tags).toContain('plan:root');
    expect(listPlanRootTasks('default').map((t) => t.id)).toContain(created.rootTaskId);

    const steps = getPlanSteps(created.rootTaskId, 'default');
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('Collect policy sources');
    expect(steps[0].status).toBe('ready');
    expect(steps[1].status).toBe('pending'); // has a dependency

    const meta = loadTaskMetadata(created.rootTaskId);
    expect(meta?.chat_id).toBe('chat-plan-test');
    expect(meta?.session_id).toBe('sess-plan-test');
    expect(meta?.system_prompt).toBe('# SOUL.md — Runtime Identity\nTest plan brain.');
    expect(meta?.execution_model).toEqual(executionModel);
    expect(meta?.source_request).toBe(PLAN.goal);
  });

  it('persists and verifies the original request instead of the planner goal', async () => {
    executeDagMarks('completed', 'All requested outputs are persisted.');
    const originalRequest = '请覆盖1950至2100年，并标出中国2035年的拐点。';
    const ctx = makeCtx({
      sourceTurnId: 'turn-original',
      originalRequest,
      locale: 'zh-CN',
    });
    const created = createPlanTasks(PLAN, ctx);

    expect(loadTaskMetadata(created.rootTaskId)).toMatchObject({
      source_turn_id: 'turn-original',
      source_request: originalRequest,
      plan_goal: PLAN.goal,
    });

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);
    expect(hoisted.verifyPlanSemanticsMock).toHaveBeenCalledWith(expect.objectContaining({
      originalRequest,
      planGoal: PLAN.goal,
      turnId: `turn_bg_${created.rootTaskId}`,
    }));
  });

  it('detached run passes live session permission context into DAG execution', async () => {
    const session = createSession('user-plan-test', 'Plan context', 'default');
    updateSessionPermissionLevel(session.id, 'L0_READ_ONLY', 'default');
    addSessionScopeGrant(session.id, '/tmp/granted-plan', 'default');
    executeDagMarks('completed');
    const ctx = makeCtx({
      sessionId: session.id,
      userId: 'user-plan-test',
      permissionLevel: 'L3_FULL_ACCESS',
    });
    const created = createPlanTasks(PLAN, ctx);

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const options = hoisted.executeDagMock.mock.calls[0][6];
    expect(options.toolContext).toMatchObject({
      chatId: 'chat-plan-test',
      tenantId: 'default',
      sessionId: session.id,
      userId: 'user-plan-test',
      agentId: created.rootTaskId,
      permissionLevel: 'L0_READ_ONLY',
      scopeGrants: ['/tmp/granted-plan'],
    });
    expect(loadTaskMetadata(created.rootTaskId)).toMatchObject({
      user_id: 'user-plan-test',
      permission_level: 'L0_READ_ONLY',
    });
    // Regression: plan steps create real deliverables — without onArtifact the
    // artifact never reaches the session timeline and the user only sees a
    // container file path in the completion text.
    expect(typeof options.toolContext.onArtifact).toBe('function');
  });

  it('waits for artifact timeline persistence before semantic verification', async () => {
    let artifactPersisted = false;
    hoisted.broadcastArtifactEventMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      artifactPersisted = true;
    });
    hoisted.executeDagMock.mockImplementationOnce(async (tasks: TaskRecord[], ...args: unknown[]) => {
      for (const task of tasks) updateStatus(task.id, 'completed', task.tenant_id);
      const options = args[5] as { toolContext: { onArtifact: (event: unknown) => void } };
      options.toolContext.onArtifact({
        type: 'open',
        artifact: {
          id: 'artifact-persist-order', plugin_id: 'sandpack_v1', title: 'Dashboard', status: 'completed',
          collapsed_by_default: false, fallback_text: '', data: { code: '<h1>Dashboard</h1>' },
          updated_at: new Date().toISOString(),
        },
      });
      return 'All steps done.';
    });
    hoisted.verifyPlanSemanticsMock.mockImplementationOnce(async () => {
      expect(artifactPersisted).toBe(true);
      return {
        required: true, passed: true, outcome: 'passed', verdict: 'passed', summary: 'Artifact verified.', findings: [],
        evidenceIds: ['artifact:artifact-persist-order'], checkedAt: new Date().toISOString(), asOf: new Date().toISOString(),
      };
    });
    const ctx = makeCtx({ userId: 'user-plan-test', permissionLevel: 'L3_FULL_ACCESS' });
    const created = createPlanTasks(PLAN, ctx);

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    expect(hoisted.verifyPlanSemanticsMock).toHaveBeenCalledTimes(1);
    expect(getById(created.rootTaskId, 'default')?.status).toBe('completed');
  });

  it('detached run completes the plan, persists the result, and delivers a completion message', async () => {
    executeDagMarks('completed', 'All steps done.');
    const created = createPlanTasks(PLAN, makeCtx());

    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('completed');
    expect(loadTaskResult(created.rootTaskId)?.success).toBe(true);

    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.chatId).toBe('chat-plan-test');
    expect(delivered.sessionId).toBe('sess-plan-test');
    expect(delivered.content).toContain('Plan completed');
    // No step-count tallies in user-facing prose — the plan card owns phase
    // progress (presentation matrix).
    expect(delivered.content).not.toContain('Steps:');

    // Issue #626: the detached plan is its OWN background turn, delivered under a
    // distinct id with origin=background — never the foreground turn.
    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    expect(delivered.turnId).toBe(bgTurnId);
    expect(delivered.origin).toBe('background');
    // The DAG ran under that background turn id (6th positional arg), so all step
    // events group with the completion, not with any foreground turn.
    expect(hoisted.executeDagMock.mock.calls[0][5]).toBe(bgTurnId);
    // A durable, terminalized background envelope exists for restore.
    const envelope = getTurnEnvelope('sess-plan-test', bgTurnId, 'default');
    expect(envelope?.origin).toBe('background');
    expect(envelope?.status).toBe('completed');
  });

  it('stamps the plan presentation locale on the background turn envelope at birth', async () => {
    // Without this the envelope stayed NULL until the completion delivery
    // inferred a locale from the completion TEXT — a Chinese-writing model on
    // an English task flipped every card label to Chinese (mixed-language card).
    executeDagMarks('completed');
    const ctx = makeCtx({ locale: 'en' });
    const created = createPlanTasks(PLAN, ctx);

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const envelope = getTurnEnvelope('sess-plan-test', `turn_bg_${created.rootTaskId}`, 'default');
    expect(envelope?.locale).toBe('en');
    // Resume path inherits the locale from plan metadata, not from context.
    expect(loadTaskMetadata(created.rootTaskId)?.plan_locale).toBe('en');
  });

  it('uses the admitted turn locale for completion even when the planner goal is English', async () => {
    executeDagMarks('completed', 'All steps done.');
    const failingClient = {
      chat: vi.fn().mockRejectedValue(new Error('summary unavailable')),
    } as unknown as NonNullable<PlanRunContext['fallbackClient']>;
    const ctx = makeCtx({
      locale: 'zh-CN',
      originalRequest: '请制作人口分析报告。',
      fallbackClient: failingClient,
    });
    const created = createPlanTasks(PLAN, ctx);
    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    expect(delivered.content).toContain('计划完成');
    expect(delivered.content).not.toContain('Plan completed');
  });

  it("promotes the plan's final workspace document to the primary deliverable", async () => {
    // Plan steps stamp every document `workspace` (Issue #746) — completion
    // must promote the LAST one to `primary` or the turn ends with a text
    // wall and no hero card (operator report 2026-07-18).
    executeDagMarks('completed', 'All steps done.');
    const ctx = makeCtx({ userId: 'user-plan-test' });
    const created = createPlanTasks(PLAN, ctx);
    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    saveTimelineItem({
      tenantId: 'default',
      sessionId: 'sess-plan-test',
      chatId: 'chat-plan-test',
      turnId: bgTurnId,
      type: 'artifact',
      eventKey: 'artifact:doc-final',
      timestamp: Date.now(),
      data: {
        id: 'doc-final',
        plugin_id: 'document_v1',
        title: 'Structured Research Brief',
        status: 'completed',
        data: { role: 'workspace', content: '# Brief' },
      },
    });

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const promote = hoisted.broadcastArtifactEventMock.mock.calls.find(
      (call) => call[0]?.type === 'patch' && call[0]?.artifactId === 'doc-final',
    );
    expect(promote).toBeTruthy();
    expect(promote![0].patch).toMatchObject({ data: { role: 'primary' } });
    expect(promote![4]).toBe(bgTurnId);
  });

  it('demotes a cross-step primary data file at completion, unblocking the report promotion (G2 HIGH-1)', async () => {
    // Per-step trackers cannot see each other: step 1 hero-carded the raw
    // dataset, step 3 authored the sandpack report. Without the turn-wide
    // backstop, the xlsx stays the hero AND its primary row trips the
    // promotion guard, leaving the report at workspace (never a chat row).
    executeDagMarks('completed', 'All steps done.');
    const ctx = makeCtx({ userId: 'user-plan-test' });
    const created = createPlanTasks(PLAN, ctx);
    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    saveTimelineItem({
      tenantId: 'default', sessionId: 'sess-plan-test', chatId: 'chat-plan-test',
      turnId: bgTurnId, type: 'artifact', eventKey: 'artifact:raw-xlsx', timestamp: Date.now(),
      data: {
        id: 'raw-xlsx', plugin_id: 'file_v1', title: 'Online_Retail.xlsx', status: 'completed',
        data: { filename: 'Online_Retail.xlsx', ext: 'xlsx', kind: 'sheet', role: 'primary' },
      },
    });
    saveTimelineItem({
      tenantId: 'default', sessionId: 'sess-plan-test', chatId: 'chat-plan-test',
      turnId: bgTurnId, type: 'artifact', eventKey: 'artifact:report-page', timestamp: Date.now() + 1,
      data: {
        id: 'report-page', plugin_id: 'sandpack_v1', title: 'RFM Report', status: 'completed',
        data: { files: {}, role: 'workspace' },
      },
    });

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const demotion = hoisted.broadcastArtifactEventMock.mock.calls.find(
      (call) => call[0]?.type === 'patch' && call[0]?.artifactId === 'raw-xlsx',
    );
    expect(demotion).toBeTruthy();
    expect(demotion![0].patch).toMatchObject({ data: { role: 'supporting' } });
    const promote = hoisted.broadcastArtifactEventMock.mock.calls.find(
      (call) => call[0]?.type === 'patch' && call[0]?.artifactId === 'report-page',
    );
    expect(promote).toBeTruthy();
    expect(promote![0].patch).toMatchObject({ data: { role: 'primary' } });
  });

  it('does NOT promote a working note when the turn already has a visible deliverable', async () => {
    // Real counterexample class: the plan's actual deliverable is a
    // non-document artifact (sandpack chart, role-less → renders as a card);
    // hero-carding the last research note next to it would be wrong.
    executeDagMarks('completed', 'All steps done.');
    const ctx = makeCtx({ userId: 'user-plan-test' });
    const created = createPlanTasks(PLAN, ctx);
    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    const baseRow = {
      tenantId: 'default',
      sessionId: 'sess-plan-test',
      chatId: 'chat-plan-test',
      turnId: bgTurnId,
      type: 'artifact' as const,
      timestamp: Date.now(),
    };
    saveTimelineItem({
      ...baseRow,
      eventKey: 'artifact:note-1',
      data: { id: 'note-1', plugin_id: 'document_v1', title: 'Research note', status: 'completed', data: { role: 'workspace', content: '# note' } },
    });
    saveTimelineItem({
      ...baseRow,
      eventKey: 'artifact:chart-1',
      data: { id: 'chart-1', plugin_id: 'sandpack_v1', title: 'Assessment Report', status: 'completed', data: { code: '<div/>' } },
    });

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    const promote = hoisted.broadcastArtifactEventMock.mock.calls.find(
      (call) => call[0]?.type === 'patch' && call[0]?.patch?.data?.role === 'primary',
    );
    expect(promote).toBeUndefined();
  });

  it('does not turn structural DAG success into success when latest-data evidence is missing', async () => {
    hoisted.verifyPlanSemanticsMock.mockResolvedValueOnce({
      required: true,
      passed: false,
      outcome: 'failed',
      verdict: 'failed',
      summary: 'Runtime acceptance verification failed.',
      findings: ['No persisted source evidence for the research step.'],
      evidenceIds: [],
      checkedAt: '2026-07-19T00:00:00.000Z',
      asOf: '2026-07-19T00:00:00.000Z',
    });
    const freshnessPlan: DecomposeTaskInput = {
      goal: 'Collect the latest U.S. CPI data and write a report',
      all_steps_independent: false,
      subtasks: [{
        title: 'Research latest CPI',
        objective: 'Collect the latest CPI release and sources',
        done_criteria: 'Current release is dated and cited',
        depends_on: [],
        agent_type_hint: 'any',
        constraints: {},
      }],
    };
    executeDagMarks('completed', 'The file exists.');
    const created = createPlanTasks(freshnessPlan, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const result = loadTaskResult(created.rootTaskId);
    expect(result?.success).toBe(false);
    expect(result?.metadata).toMatchObject({
      structurally_succeeded: true,
      semantic_verification: {
        required: true,
        passed: false,
        outcome: 'failed',
        verdict: 'failed',
      },
    });
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
    expect(delivered.content).toContain('Semantic verification');
    expect(getTurnEnvelope('sess-plan-test', `turn_bg_${created.rootTaskId}`, 'default')?.status).toBe('failed');
    // The quality check is internal machinery — it never gets its own timeline
    // row. The failure reaches the user only through the final message (asserted
    // above) and the failed turn envelope, never a "结果质量校验" step.
    const verificationRows = hoisted.deliverBackgroundTaskUpdateMock.mock.calls
      .filter((call) => String(call[0]?.taskId ?? '').endsWith(':verification'));
    expect(verificationRows).toHaveLength(0);
  });

  it('completes with an honest quality_unverified marker when the verifier cannot render a verdict', async () => {
    hoisted.verifyPlanSemanticsMock.mockResolvedValueOnce({
      required: true,
      passed: false,
      outcome: 'unverified',
      verdict: 'uncertain',
      summary: 'The deliverable was produced, but its quality was not verified because the verifier returned invalid JSON.',
      findings: ['Bad Request: unexpected end of hex escape'],
      evidenceIds: [],
      checkedAt: '2026-07-22T00:00:00.000Z',
      asOf: '2026-07-22T00:00:00.000Z',
    });
    executeDagMarks('completed', 'The requested deliverable is available.');
    const ctx = makeCtx({ fallbackClient: { chat: vi.fn() } as never });
    const created = createPlanTasks(PLAN, ctx);

    startDetachedPlanRun(created.rootTaskId, ctx);
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')?.status).toBe('completed');
    const result = loadTaskResult(created.rootTaskId);
    expect(result?.success).toBe(true);
    expect(result?.metadata).toMatchObject({
      quality_unverified: true,
      semantic_verification: { outcome: 'unverified' },
    });
    const content = hoisted.deliverAssistantMessageMock.mock.calls[0][0].content as string;
    expect(content).toContain('quality was not verified');
    expect(content).toContain('invalid JSON');
    expect(content).not.toMatch(/passed verification|succeeded|successfully/i);
    expect(getTurnEnvelope('sess-plan-test', `turn_bg_${created.rootTaskId}`, 'default')?.status).toBe('completed');
    // Unverified quality also never gets a timeline row — the honesty lives in
    // the final message (asserted above), not a "结果质量校验" step.
    const verificationRows = hoisted.deliverBackgroundTaskUpdateMock.mock.calls
      .filter((call) => String(call[0]?.taskId ?? '').endsWith(':verification'));
    expect(verificationRows).toHaveLength(0);
  });

  it('announces the background turn envelope on both lifecycle transitions (Issue #714)', async () => {
    executeDagMarks('completed', 'All steps done.');
    const created = createPlanTasks(PLAN, makeCtx());
    const bgTurnId = `turn_bg_${created.rootTaskId}`;

    // Subscribe to the real bus — index.ts hands every event straight to
    // broadcastProgressEvent, so what lands here is what a live client gets.
    const seen: ProgressEvent[] = [];
    const unsubscribe = onProgressEvent((event) => { seen.push(event); });
    try {
      expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(true);
      await waitForRunToFinish(created.rootTaskId);
    } finally {
      unsubscribe();
    }

    // A client that never reloads learns this turn's startedAt only from these
    // events. Without them the projection falls back to parsing an epoch out of
    // the turn id — and `turn_bg_${uuid}` carries none, so `Number('bg')` is NaN,
    // the turn sorts to MAX_SAFE_INTEGER, and its result renders below messages
    // the user sent later.
    const announced = seen.filter((event) => event.type === 'turn_envelope_updated');
    expect(announced.map((event) => event.turnId)).toEqual([bgTurnId, bgTurnId]);
    expect(announced[0]).toMatchObject({
      tenantId: 'default',
      sessionId: 'sess-plan-test',
      chatId: 'chat-plan-test',
    });

    // The id shape is the whole bug: a `turn_${epoch}_` fixture sorts fine even
    // unannounced, so a test using one would pass while the defect stands.
    expect(bgTurnId.split('_')[1]).toBe('bg');
    expect(Number(bgTurnId.split('_')[1])).toBeNaN();

    // A background turn must never drive the session FSM: `turn_state` is what
    // websocket.ts translates into workspace_session_state, and this plan runs
    // concurrently with whatever the foreground is doing.
    expect(seen.some((event) => event.type === 'turn_state')).toBe(false);

    // Persist-then-announce: an event that outran its durable row would
    // disagree with a simultaneous REST restore.
    expect(getTurnEnvelope('sess-plan-test', bgTurnId, 'default')?.status).toBe('completed');
  });

  it('isolates a detached plan from the foreground turn that spawned it (Issue #626)', async () => {
    executeDagMarks('completed');
    const created = createPlanTasks(PLAN, makeCtx());
    // The spawning foreground turn id must NOT leak into the plan's execution.
    startDetachedPlanRun(created.rootTaskId, makeCtx({ turnId: 'turn_foreground' }));
    await waitForRunToFinish(created.rootTaskId);

    const bgTurnId = `turn_bg_${created.rootTaskId}`;
    expect(hoisted.executeDagMock.mock.calls[0][5]).toBe(bgTurnId);
    expect(hoisted.executeDagMock.mock.calls[0][5]).not.toBe('turn_foreground');
    expect(hoisted.deliverAssistantMessageMock.mock.calls[0][0].turnId).toBe(bgTurnId);
  });

  it('failed steps mark the plan failed and the delivery says so honestly', async () => {
    executeDagMarks('failed', 'step blew up');
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
  });

  it('marks transient-only failure retryable and re-enters only failed steps', async () => {
    const created = createPlanTasks(PLAN, makeCtx({ deliveryMode: 'caller' }));
    const stepIds = getPlanSteps(created.rootTaskId, 'default').map((step) => step.id);
    hoisted.executeDagMock
      .mockImplementationOnce(async (tasks: TaskRecord[]) => {
        persistTaskResult(tasks[0].id, {
          task_id: tasks[0].id,
          success: true,
          output: 'completed result to reuse',
          tokens_used: 0,
          elapsed_ms: 1,
          completed_at: new Date().toISOString(),
        });
        updateStatus(tasks[0].id, 'completed', tasks[0].tenant_id);
        updateTask(tasks[1].id, {
          constraints: { ...tasks[1].constraints, failure_retryable: true },
        }, tasks[1].tenant_id);
        expect(getById(tasks[1].id, tasks[1].tenant_id)?.constraints.failure_retryable).toBe(true);
        updateStatus(tasks[1].id, 'failed', tasks[1].tenant_id);
        return 'transient provider failure';
      })
      .mockImplementationOnce(async (tasks: TaskRecord[]) => {
        expect(tasks.map((task) => task.id)).toEqual([stepIds[1]]);
        updateStatus(tasks[0].id, 'completed', tasks[0].tenant_id);
        return 'retry completed';
      });

    startDetachedPlanRun(created.rootTaskId, makeCtx({ deliveryMode: 'caller' }));
    const firstOutcome = await waitForPlanRun(created.rootTaskId, 'default');
    expect(firstOutcome).toMatchObject({ success: false, retryableFailure: true });

    const restarted = restartPlanFromMetadata(created.rootTaskId, {
      systemPrompt: makeCtx().systemPrompt,
      retryFailedSteps: true,
    });
    expect(restarted.started).toBe(true);
    const secondOutcome = await waitForPlanRun(created.rootTaskId, 'default');

    expect(secondOutcome.success).toBe(true);
    expect(hoisted.executeDagMock).toHaveBeenCalledTimes(2);
    expect(loadTaskResult(stepIds[0])?.output).toBe('completed result to reuse');
  });

  it('cancelled steps mark the plan failed and the delivery reports cancellation honestly (no whitewash)', async () => {
    // Regression for the 2026-07-08 live cancel-whitewash incident: an
    // interrupted step must NOT be delivered as "Plan completed". Simulate the
    // executor marking the scope cancelled (what the fixed dag-executor does
    // when executeSingleTask returns an interruption-fallback string).
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      for (const task of tasks) updateStatus(task.id, 'cancelled', task.tenant_id);
      return 'Task 1: Collect policy sources\nCancelled: 任务执行中断。';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
    expect(delivered.content).not.toContain('Plan completed');
    // Cancellations are named distinctly from generic failures — per problem
    // step by title, never as "Steps: N/N" tallies (presentation matrix).
    expect(delivered.content).toContain('Collect policy sources — cancelled');
    expect(delivered.content).toContain('Draft analysis — cancelled');
    expect(delivered.content).not.toContain('Steps:');

    const result = loadTaskResult(created.rootTaskId);
    expect(result?.success).toBe(false);
    expect(result?.metadata).toMatchObject({ cancelled: 2, failed: 0 });
  });

  it('keeps an explicit user-cancelled plan terminal and suppresses failure delivery', async () => {
    let rootTaskId = '';
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      updateStatus(rootTaskId, 'cancelled', 'default');
      for (const task of tasks) updateStatus(task.id, 'cancelled', task.tenant_id);
      return 'cancelled';
    });
    const created = createPlanTasks(PLAN, makeCtx());
    rootTaskId = created.rootTaskId;

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')?.status).toBe('cancelled');
    expect(hoisted.deliverAssistantMessageMock).not.toHaveBeenCalled();
    expect(getTurnEnvelope(makeCtx().sessionId!, planBackgroundTurnId(created.rootTaskId), 'default')?.status)
      .toBe('cancelled');
  });

  it('mixed completed + cancelled reports partial honest stats', async () => {
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      // First step completes, second is cancelled.
      updateStatus(tasks[0].id, 'completed', tasks[0].tenant_id);
      if (tasks[1]) updateStatus(tasks[1].id, 'cancelled', tasks[1].tenant_id);
      return 'partial output';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    // Only the problem step is named; the completed step and any count tallies
    // stay out of the prose (the plan card carries full phase state).
    expect(delivered.content).toContain('Draft analysis — cancelled');
    expect(delivered.content).not.toContain('Collect policy sources —');
    expect(delivered.content).not.toContain('Steps:');
    expect(delivered.content).not.toContain('Plan completed:');
  });

  it('reports blocked downstream work honestly and never reuses a successful step excerpt as completion', async () => {
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      updateStatus(tasks[0].id, 'failed', tasks[0].tenant_id);
      if (tasks[1]) updateStatus(tasks[1].id, 'blocked', tasks[1].tenant_id);
      return '已完成: 研究报告已经交付';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    startDetachedPlanRun(created.rootTaskId, makeCtx());
    await waitForRunToFinish(created.rootTaskId);

    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0];
    expect(delivered.content).toContain('Plan finished with problems');
    expect(delivered.content).toContain('Collect policy sources — failed');
    expect(delivered.content).toContain('Draft analysis — blocked by an earlier step');
    expect(delivered.content).not.toContain('已完成: 研究报告已经交付');
    expect(loadTaskResult(created.rootTaskId)?.metadata).toMatchObject({ blocked: 1, failed: 1 });
  });

  it('refuses a second concurrent run of the same plan', async () => {
    let release: () => void = () => {};
    hoisted.executeDagMock.mockImplementation(async (tasks: TaskRecord[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      for (const task of tasks) updateStatus(task.id, 'completed', task.tenant_id);
      return 'ok';
    });
    const created = createPlanTasks(PLAN, makeCtx());

    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(true);
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(false);

    release();
    await waitForRunToFinish(created.rootTaskId);
  });

  it('resumeIncompletePlans normalizes stranded steps and re-runs only incomplete ones', async () => {
    const created = createPlanTasks(PLAN, makeCtx());
    // Simulate a crash mid-run: root running, step0 completed, step1 stranded running.
    updateStatus(created.rootTaskId, 'running', 'default');
    const steps = getPlanSteps(created.rootTaskId, 'default');
    updateStatus(steps[0].id, 'completed', 'default');
    updateStatus(steps[1].id, 'running', 'default');

    executeDagMarks('completed', 'resumed output');
    const report = resumeIncompletePlans({ systemPrompt: '# SOUL.md — Runtime Identity\nfallback prompt' });
    expect(report.resumed).toContain(created.rootTaskId);
    await waitForRunToFinish(created.rootTaskId);

    // Only the incomplete step went to the executor.
    const scope = hoisted.executeDagMock.mock.calls[0][0] as TaskRecord[];
    expect(scope.map((t) => t.id)).toEqual([steps[1].id]);
    // Resume used the system prompt captured at creation, not the fallback.
    expect(hoisted.executeDagMock.mock.calls[0][1]).toBe('# SOUL.md — Runtime Identity\nTest plan brain.');

    expect(getById(created.rootTaskId, 'default')!.status).toBe('completed');
    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
  });

  it('resume reconstructs permission context from metadata when the session row is unavailable', async () => {
    const created = createPlanTasks(PLAN, makeCtx({
      sessionId: 'missing-session-plan',
      userId: 'user-resume-plan',
      permissionLevel: 'L1_READ_WRITE',
    }));
    updateStatus(created.rootTaskId, 'running', 'default');

    executeDagMarks('completed', 'resumed output');
    const report = resumeIncompletePlans({ systemPrompt: '# SOUL.md — Runtime Identity\nfallback prompt' });
    expect(report.resumed).toContain(created.rootTaskId);
    await waitForRunToFinish(created.rootTaskId);

    const options = hoisted.executeDagMock.mock.calls[0][6];
    expect(options.toolContext).toMatchObject({
      chatId: 'chat-plan-test',
      tenantId: 'default',
      sessionId: 'missing-session-plan',
      userId: 'user-resume-plan',
      agentId: created.rootTaskId,
      permissionLevel: 'L1_READ_WRITE',
      scopeGrants: [],
    });
  });

  it('repairs an invalid persisted prompt from the current SOUL identity before resume', async () => {
    const created = createPlanTasks(PLAN, makeCtx());
    const metadata = loadTaskMetadata(created.rootTaskId)!;
    persistTaskMetadata(created.rootTaskId, { ...metadata, system_prompt: 'legacy generic prompt' });
    updateStatus(created.rootTaskId, 'running', 'default');
    executeDagMarks('completed', 'resumed with repaired identity');

    const currentPrompt = '# SOUL.md — Runtime Identity\nCurrent tenant identity.';
    const result = restartPlanFromMetadata(created.rootTaskId, {
      systemPrompt: currentPrompt,
      normalizeStrandedSteps: true,
    });
    expect(result.started).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(hoisted.executeDagMock.mock.calls[0][1]).toBe(currentPrompt);
    expect(loadTaskMetadata(created.rootTaskId)?.system_prompt).toBe(currentPrompt);
  });

  it('resume skips plans without delivery metadata and marks them failed', () => {
    const created = createPlanTasks(PLAN, makeCtx());
    updateStatus(created.rootTaskId, 'running', 'default');
    // Wipe the metadata chat target.
    persistTaskMetadata(created.rootTaskId, {
      task_id: created.rootTaskId,
      title: 'x',
      objective: 'x',
      status: 'running',
      created_at: new Date().toISOString(),
      workspace_path: '',
    });

    const report = resumeIncompletePlans({ systemPrompt: '# SOUL.md — Runtime Identity\nfallback' });
    expect(report.resumed).not.toContain(created.rootTaskId);
    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
  });

  it('executeDecomposeTask (background mode) creates the plan, starts a detached run, and returns a turn-ending handoff', async () => {
    const { loadConfig } = await import('../config/index.js');
    loadConfig('/nonexistent/mozi-plan-runner-test.json'); // defaults: dag_execution_mode=background
    executeDagMarks('completed', 'background dag output');
    saveTimelineItem({
      tenantId: 'default', sessionId: 'sess-plan-test', chatId: 'chat-plan-test', turnId: 'turn-source',
      type: 'message', eventKey: 'message:source', timestamp: Date.now(),
      data: { role: 'user', content: '请生成完整的季度税务更新报告。' },
    });

    const { executeDecomposeTask } = await import('./dag-bridge.js');
    const outcome = await executeDecomposeTask(PLAN, {
      chatId: 'chat-plan-test',
      tenantId: 'default',
      systemPrompt: '# SOUL.md — Runtime Identity\nTest plan brain.',
      sessionId: 'sess-plan-test',
      turnId: 'turn-source',
    });

    // Background mode returns a structured DetachedPlanStarted outcome — the
    // runtime (not prompt text) ends the foreground turn on it.
    expect(typeof outcome).not.toBe('string');
    const detached = outcome as Exclude<typeof outcome, string>;
    expect(detached.detached).toBe(true);
    expect(detached.content).toContain('RUNNING IN BACKGROUND');
    expect(detached.content).toContain('1. Collect policy sources');
    // The user-facing handoff is one sentence (Issue #735): the phase list
    // travels as the typed plan_started event, not as persisted prose.
    expect(detached.userMessage).toContain('2-step plan');
    expect(detached.userMessage).not.toContain('1. Collect policy sources');
    expect(detached.rootTaskId).toMatch(/[0-9a-f-]+/);
    expect(loadTaskMetadata(detached.rootTaskId)).toMatchObject({
      source_turn_id: 'turn-source',
      source_request: '请生成完整的季度税务更新报告。',
    });

    await waitForRunToFinish(detached.rootTaskId);
    expect(getById(detached.rootTaskId, 'default')!.status).toBe('completed');
    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
  });

  it('delivers a Brain-written completion summary grounded in step results', async () => {
    executeDagMarks('completed', 'raw dag output');
    const chatMock = vi.fn().mockResolvedValue({
      content: '模板与初版内容已完成,交付文件:/data/output/report.xlsx。',
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'test-model',
      stop_reason: 'end_turn',
    });
    const fakeClient = { chat: chatMock } as unknown as NonNullable<PlanRunContext['fallbackClient']>;

    const created = createPlanTasks(PLAN, makeCtx({ fallbackClient: fakeClient }));
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx({ fallbackClient: fakeClient }))).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(chatMock).toHaveBeenCalledTimes(1);
    // Summarization input is grounded: goal + per-step status block.
    const [messages] = chatMock.mock.calls[0] as [Array<{ role: string; content: string }>];
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('Quarterly tax update report');
    expect(userMsg.content).toContain('Collect policy sources');

    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    // The Brain summary stands alone — no "Plan completed:" template prefix
    // (the typed plan card already carries goal and progress).
    expect(delivered.content).not.toContain('Plan completed');
    expect(delivered.content).toContain('/data/output/report.xlsx');
    // The old behavior dumped raw step outputs; the Brain summary replaces it.
    expect(delivered.content).not.toContain('raw dag output');
  });

  it('returns the persisted completion to a scheduler caller without direct chat delivery', async () => {
    executeDagMarks('completed', 'scheduled dag output');
    const chatMock = vi.fn().mockResolvedValue({
      content: 'A 股收盘复盘已生成。',
      usage: { input_tokens: 100, output_tokens: 20 },
      model: 'test-model',
      stop_reason: 'end_turn',
    });
    const fallbackClient = { chat: chatMock } as unknown as NonNullable<PlanRunContext['fallbackClient']>;
    const ctx = makeCtx({
      fallbackClient,
      deliveryMode: 'caller',
      turnOrigin: 'scheduler',
    });
    const created = createPlanTasks(PLAN, ctx);
    expect(startDetachedPlanRun(created.rootTaskId, ctx)).toBe(true);

    const outcome = await waitForPlanRun(created.rootTaskId, 'default');

    expect(outcome).toMatchObject({ success: true, content: 'A 股收盘复盘已生成。' });
    expect(hoisted.deliverAssistantMessageMock).not.toHaveBeenCalled();
    expect(loadTaskMetadata(created.rootTaskId)).toMatchObject({
      plan_delivery_mode: 'caller',
      plan_turn_origin: 'scheduler',
    });
    expect(loadTaskResult(created.rootTaskId)?.metadata).toMatchObject({
      completion_content: 'A 股收盘复盘已生成。',
    });
  });

  it('rejects provider-specific sandbox links before a plan completion becomes durable', async () => {
    executeDagMarks('completed', 'raw dag output');
    const chatMock = vi.fn().mockResolvedValue({
      content: '报告已完成：[季度报告](sandbox:/reports/quarterly.pdf)。',
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'test-model',
      stop_reason: 'end_turn',
    });
    const fakeClient = { chat: chatMock } as unknown as NonNullable<PlanRunContext['fallbackClient']>;

    const created = createPlanTasks(PLAN, makeCtx({ fallbackClient: fakeClient }));
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx({ fallbackClient: fakeClient }))).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    expect(delivered.content).toContain('季度报告');
    expect(delivered.content).toContain('运行时说明');
    expect(delivered.content).not.toContain('sandbox:');
  });

  it('falls back to the compact template when the Brain summary call fails', async () => {
    executeDagMarks('completed', 'raw dag output');
    const failingClient = {
      chat: vi.fn().mockRejectedValue(new Error('provider down')),
    } as unknown as NonNullable<PlanRunContext['fallbackClient']>;

    const created = createPlanTasks(PLAN, makeCtx({ fallbackClient: failingClient }));
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx({ fallbackClient: failingClient }))).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    expect(delivered.content).toContain('Plan completed');
    // Compact template: no step counts, no raw status tokens, and it points
    // at the plan card (the floating execution panel no longer exists).
    expect(delivered.content).not.toContain('Steps:');
    expect(delivered.content).not.toContain('[completed]');
    expect(delivered.content).toContain('Step details are in the plan card.');
  });

  it('discards a token-cap-truncated Brain summary and uses the compact template (G3)', async () => {
    executeDagMarks('completed', 'raw dag output');
    // Real incident 2026-07-18: a summary cut mid-sentence at "**Key findings
    // from completed" was delivered verbatim. stop_reason 'length' (Vercel AI
    // SDK finishReason for a cap hit) must route to the bounded fallback.
    const chatMock = vi.fn().mockResolvedValue({
      content: 'All five steps completed, producing dashboards and **Key findings from completed',
      usage: { input_tokens: 100, output_tokens: 700 },
      model: 'test-model',
      stop_reason: 'length',
    });
    const truncatingClient = { chat: chatMock } as unknown as NonNullable<PlanRunContext['fallbackClient']>;

    const created = createPlanTasks(PLAN, makeCtx({ fallbackClient: truncatingClient }));
    expect(startDetachedPlanRun(created.rootTaskId, makeCtx({ fallbackClient: truncatingClient }))).toBe(true);
    await waitForRunToFinish(created.rootTaskId);

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverAssistantMessageMock).toHaveBeenCalledTimes(1);
    const delivered = hoisted.deliverAssistantMessageMock.mock.calls[0][0] as { content: string };
    // The half-sentence never reaches the user; the runtime-truth template does.
    expect(delivered.content).not.toContain('Key findings from completed');
    expect(delivered.content).toContain('Plan completed');
  });

  // Regression (2026-07-22 incident): buildPlanToolContext dropped turnOrigin,
  // so every detached plan step looked interactive to the executor's unattended
  // discipline (#824) and a scheduled plan's out-of-scope write raised an
  // approval card nobody was there to click.
  it('carries turnOrigin into the plan step tool context', () => {
    const context = buildPlanToolContext('root-task-origin', makeCtx({
      permissionLevel: 'L2_SHELL_EXEC',
      turnOrigin: 'scheduler',
    }));

    expect(context?.turnOrigin).toBe('scheduler');
  });

  it('enforces the run attempt cap', async () => {
    executeDagMarks('completed');
    const created = createPlanTasks(PLAN, makeCtx());
    const { incrementAttempts } = await import('../store/task-dag.js');
    incrementAttempts(created.rootTaskId, 'default');
    incrementAttempts(created.rootTaskId, 'default');
    incrementAttempts(created.rootTaskId, 'default');

    expect(startDetachedPlanRun(created.rootTaskId, makeCtx())).toBe(false);
    expect(getById(created.rootTaskId, 'default')!.status).toBe('failed');
  });
});
