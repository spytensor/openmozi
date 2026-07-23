import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../store/db.js';
import { saveLesson } from '../memory/lessons.js';
import { schedule, reset as resetScheduler } from '../scheduler/index.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { recordLlmCall, resetTableFlag as resetBillingTableFlag } from '../tenants/billing.js';
import { setQuota } from '../tenants/quotas.js';
import {
  addBackgroundTask,
  completeTask,
  failTask,
  resetBackgroundTaskTableFlag,
} from './background-tasks.js';
import {
  startAgentLoop,
  stopAgentLoop,
  getAgentLoopStatus,
  createGoal,
  updateGoalProgress,
  completeGoal,
  getActiveGoals,
  getThoughts,
  resetGoals,
  loadPersistedGoals,
  getAutonomyBudget,
  detectStalledGoals,
  getRecentDecisionLogs,
  replayDecisionLog,
  evaluateLoopDecisions,
} from './agent-loop.js';

let tmpDir: string;

describe('core/agent-loop deterministic engine', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;

    resetBackgroundTaskTableFlag();
    resetBillingTableFlag();
    resetScheduler();
    resetGoals();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    stopAgentLoop();
    resetScheduler();
    resetGoals();

    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();

    teardownTestDb(tmpDir);
  });

  it('starts with default interval and updates status', async () => {
    schedule({
      id: 'reminder_dispatch',
      interval_minutes: 1,
      run: () => {},
    });

    const sendFn = vi.fn(async () => {});
    startAgentLoop({
      ownerChatId: 'owner-chat',
      sendFn,
    });

    const runningStatus = getAgentLoopStatus();
    expect(runningStatus.running).toBe(true);
    expect(runningStatus.interval_minutes).toBe(5);
    expect(runningStatus.next_run_at).toBe(Date.now() + (5 * 60_000));

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sendFn).not.toHaveBeenCalled();

    stopAgentLoop();

    const stoppedStatus = getAgentLoopStatus();
    expect(stoppedStatus.running).toBe(false);
    expect(stoppedStatus.next_run_at).toBeNull();
  });

  it('produces structured decision logs and supports replay', async () => {
    addBackgroundTask('chat-1', 'Resume ETL processing');
    addBackgroundTask('chat-1', 'Already failed task');
    failTask(2, 'timeout');

    saveLesson('tool_timeout', 'retry with bounded backoff');

    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, status)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      'task-pending', 'default', 'Pending work', 'pending',
      'task-failed', 'default', 'Failed work', 'failed',
    );

    db.prepare(`
      INSERT INTO turn_traces (
        trace_id, tenant_id, turn_id, chat_id, model, provider, status, failure_category,
        tool_call_count, tool_failure_count, llm_input_tokens, llm_output_tokens, cost_usd,
        latency_ms, started_at, ended_at
      )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-59 minutes')),
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-58 minutes'), datetime('now', '-57 minutes')),
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-56 minutes'), datetime('now', '-55 minutes')),
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-54 minutes'), datetime('now', '-53 minutes'))
    `).run(
      'trace-1', 'default', 'turn-1', 'chat-1', 'gpt-4.1-mini', 'openai', 'failed', 'tool_protocol', 3, 1, 100, 50, 0.2, 3000,
      'trace-2', 'default', 'turn-2', 'chat-1', 'gpt-4.1-mini', 'openai', 'failed', 'tool_protocol', 2, 1, 120, 60, 0.2, 3200,
      'trace-3', 'default', 'turn-3', 'chat-1', 'gpt-4.1-mini', 'openai', 'failed', 'provider_error', 1, 1, 80, 30, 0.1, 2800,
      'trace-4', 'default', 'turn-4', 'chat-1', 'gpt-4.1-mini', 'openai', 'success', null, 1, 0, 50, 25, 0.05, 2500,
    );

    setQuota({ tenant_id: 'default', daily_token_limit: 1000 });
    recordLlmCall({
      tenant_id: 'default',
      model: 'gpt-4.1-mini',
      input_tokens: 850,
      output_tokens: 100,
      cost_usd: 0.45,
    });

    const sendFn = vi.fn(async () => {});
    startAgentLoop({
      ownerChatId: 'owner-chat',
      sendFn,
      intervalMinutes: 1,
      lessonsLookbackMinutes: 120,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn.mock.calls[0]?.[1]).toContain('Autonomous cycle update:');

    const loopStatus = getAgentLoopStatus();
    expect(loopStatus.last_decision).not.toBeNull();
    expect(loopStatus.last_check?.reminder_task_found).toBe(false);
    expect(loopStatus.last_check?.pending_background_tasks).toBe(1);
    expect(loopStatus.last_check?.daily_token_quota_state).toBe('soft_limit');

    const actionCodes = loopStatus.last_decision?.actions.map((action) => action.code) ?? [];
    expect(actionCodes).toContain('missing_reminder_scheduler');
    expect(actionCodes).toContain('pending_background_tasks');
    expect(actionCodes).toContain('high_turn_failure_rate');
    expect(actionCodes).toContain('token_quota_pressure');
    expect(actionCodes).toContain('task_failure_backlog');

    const decisionLogs = getRecentDecisionLogs('default', 10);
    expect(decisionLogs.length).toBeGreaterThanOrEqual(1);

    const latest = decisionLogs[0];
    const replayed = replayDecisionLog(latest!);
    expect(replayed).toEqual(latest!.actions);

    const recomputed = evaluateLoopDecisions(latest!.signals);
    expect(recomputed).toEqual(latest!.actions);
  });

  it('emits a healthy action and does not notify owner when signals are clean', async () => {
    schedule({
      id: 'reminder_dispatch',
      interval_minutes: 1,
      run: () => {},
    });

    setQuota({ tenant_id: 'default', daily_token_limit: 1000000 });

    const sendFn = vi.fn(async () => {});
    startAgentLoop({
      ownerChatId: 'owner-chat',
      sendFn,
      intervalMinutes: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendFn).not.toHaveBeenCalled();

    const decision = getAgentLoopStatus().last_decision;
    expect(decision).not.toBeNull();
    expect(decision?.actions).toHaveLength(1);
    expect(decision?.actions[0]?.code).toBe('healthy');
  });
});

describe('core/agent-loop goal lifecycle', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetGoals();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    resetGoals();
    teardownTestDb(tmpDir);
    vi.useRealTimers();
  });

  it('supports create/update/complete flows', () => {
    const goal = createGoal('goal-1', 'Ship deterministic loop');
    expect(goal.status).toBe('pending');

    const updated = updateGoalProgress('goal-1', 50, 'Midpoint reached');
    expect(updated?.progress).toBe(50);
    expect(updated?.evidence).toContain('Midpoint reached');

    const completed = completeGoal('goal-1', true, 'Delivered');
    expect(completed?.status).toBe('completed');
    expect(completed?.autonomy_budget).toBe(2);
  });

  it('persists and reloads goals by tenant', () => {
    createGoal('tenant-a-goal', 'A', 'tenant-a');
    createGoal('tenant-b-goal', 'B', 'tenant-b');

    resetGoals();
    const loadedA = loadPersistedGoals('tenant-a');
    expect(loadedA).toHaveLength(1);
    expect(loadedA[0]?.id).toBe('tenant-a-goal');

    resetGoals();
    const loadedB = loadPersistedGoals('tenant-b');
    expect(loadedB).toHaveLength(1);
    expect(loadedB[0]?.id).toBe('tenant-b-goal');
  });

  it('detects stalled goals and exposes deterministic thoughts', () => {
    createGoal('stalled-1', 'Wait forever');
    const active = getActiveGoals().find((goal) => goal.id === 'stalled-1');
    expect(active).toBeDefined();
    active!.status = 'in_progress';
    updateGoalProgress('stalled-1', 10);

    vi.setSystemTime(new Date('2026-01-01T14:00:00.000Z'));

    const stalled = detectStalledGoals('default');
    expect(stalled.length).toBeGreaterThanOrEqual(1);
    expect(getAutonomyBudget('default')).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(getThoughts())).toBe(true);
  });

  it('updates background task state transitions used by loop signals', () => {
    const pending = addBackgroundTask('chat-1', 'Pending item', 'default');
    const done = addBackgroundTask('chat-1', 'Done item', 'default');
    const failed = addBackgroundTask('chat-1', 'Failed item', 'default');

    completeTask(done.id, 'ok');
    failTask(failed.id, 'error');

    const db = getDb();
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM background_tasks
      WHERE tenant_id = 'default'
    `).get() as { pending: number; completed: number; failed: number };

    expect(row.pending).toBe(1);
    expect(row.completed).toBe(1);
    expect(row.failed).toBe(1);
    expect(pending.id).toBeGreaterThan(0);
  });
});
