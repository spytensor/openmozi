import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/store/db.js';
import { setupTestDb, teardownTestDb } from '../../src/test-helpers.js';
import { setQuota } from '../../src/tenants/quotas.js';
import { recordLlmCall, resetTableFlag as resetBillingTableFlag } from '../../src/tenants/billing.js';
import { addBackgroundTask, resetBackgroundTaskTableFlag } from '../../src/core/background-tasks.js';
import { reset as resetScheduler } from '../../src/scheduler/index.js';
import {
  getRecentDecisionLogs,
  replayDecisionLog,
  resetGoals,
  startAgentLoop,
  stopAgentLoop,
} from '../../src/core/agent-loop.js';

let tmpDir: string;

describe('integration/agent-loop-replay', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;

    resetBillingTableFlag();
    resetBackgroundTaskTableFlag();
    resetScheduler();
    resetGoals();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    stopAgentLoop();
    resetScheduler();
    resetGoals();

    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();

    teardownTestDb(tmpDir);
  });

  it('replays agent-loop decision logs into the same deterministic action set', async () => {
    addBackgroundTask('chat-1', 'Recover interrupted pipeline', 'default');

    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, status)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      'task-a', 'default', 'Backlog', 'pending',
      'task-b', 'default', 'Failed run', 'failed',
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
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-56 minutes'), datetime('now', '-55 minutes'))
    `).run(
      'trace-a', 'default', 'turn-a', 'chat-1', 'gpt-4.1-mini', 'openai', 'failed', 'provider_error', 2, 1, 100, 50, 0.15, 3000,
      'trace-b', 'default', 'turn-b', 'chat-1', 'gpt-4.1-mini', 'openai', 'failed', 'provider_error', 1, 1, 90, 30, 0.12, 2800,
      'trace-c', 'default', 'turn-c', 'chat-1', 'gpt-4.1-mini', 'openai', 'failed', 'tool_protocol', 3, 2, 140, 70, 0.2, 3500,
    );

    setQuota({ tenant_id: 'default', daily_token_limit: 1000 });
    recordLlmCall({
      tenant_id: 'default',
      model: 'gpt-4.1-mini',
      input_tokens: 820,
      output_tokens: 90,
      cost_usd: 0.4,
    });

    const sendFn = vi.fn(async () => {});
    startAgentLoop({
      ownerChatId: 'owner-chat',
      sendFn,
      intervalMinutes: 1,
    });

    await vi.advanceTimersByTimeAsync(120_000);

    const logs = getRecentDecisionLogs('default', 2);
    expect(logs).toHaveLength(2);

    const latest = logs[0]!;
    const previous = logs[1]!;

    expect(latest.actions).toEqual(previous.actions);

    const replayLatest = replayDecisionLog(latest);
    const replayPrevious = replayDecisionLog(previous);
    expect(replayLatest).toEqual(latest.actions);
    expect(replayPrevious).toEqual(previous.actions);

    const codes = latest.actions.map((action) => action.code);
    expect(codes).toContain('missing_reminder_scheduler');
    expect(codes).toContain('pending_background_tasks');
    expect(codes).toContain('high_turn_failure_rate');
    expect(codes).toContain('token_quota_pressure');
  });
});
