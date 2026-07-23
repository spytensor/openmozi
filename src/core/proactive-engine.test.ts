import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  pushEvent,
  getQueueLength,
  parseDecision,
  wake,
  startProactiveEngine,
  stopProactiveEngine,
  resetProactiveEngine,
  isProactiveEngineRunning,
  type ProactiveDecision,
  type ProactiveEngineConfig,
  evaluateActionSafety,
  getConsecutiveFailures,
  getBackoffInterval,
  fallbackDecision,
} from './proactive-engine.js';

let tmpDir: string;

describe('core/proactive-engine', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetProactiveEngine();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    resetProactiveEngine();
    vi.useRealTimers();
    teardownTestDb(tmpDir);
  });

  // ── Event Queue ──

  it('pushEvent accumulates events in queue', () => {
    expect(getQueueLength()).toBe(0);
    pushEvent({ type: 'task_failed', summary: 'Task X failed' });
    pushEvent({ type: 'agent_failed', summary: 'Agent Y crashed' });
    expect(getQueueLength()).toBe(2);
  });

  it('pushEvent auto-assigns timestamps', () => {
    pushEvent({ type: 'test', summary: 'test event' });
    expect(getQueueLength()).toBe(1);
  });

  // ── parseDecision ──

  it('parseDecision handles valid notify JSON', () => {
    const raw = JSON.stringify({
      action: 'notify',
      message: 'Hello user',
      reasoning: 'User should know',
    });
    const d = parseDecision(raw);
    expect(d.action).toBe('notify');
    expect(d.message).toBe('Hello user');
    expect(d.reasoning).toBe('User should know');
  });

  it('parseDecision handles wait with wait_minutes', () => {
    const raw = JSON.stringify({
      action: 'wait',
      wait_minutes: 10,
      reasoning: 'Not urgent',
    });
    const d = parseDecision(raw);
    expect(d.action).toBe('wait');
    expect(d.wait_minutes).toBe(10);
  });

  it('parseDecision handles act with autonomous_action', () => {
    const raw = JSON.stringify({
      action: 'act',
      autonomous_action: 'Restart failed agent',
      reasoning: 'Agent is critical',
    });
    const d = parseDecision(raw);
    expect(d.action).toBe('act');
    expect(d.autonomous_action).toBe('Restart failed agent');
  });

  it('parseDecision strips markdown code fences', () => {
    const raw = '```json\n{"action":"nothing","reasoning":"all good"}\n```';
    const d = parseDecision(raw);
    expect(d.action).toBe('nothing');
    expect(d.reasoning).toBe('all good');
  });

  it('parseDecision returns nothing for malformed JSON', () => {
    const d = parseDecision('not json at all');
    expect(d.action).toBe('nothing');
    expect(d.reasoning).toContain('Parse error');
  });

  it('parseDecision returns nothing for invalid action', () => {
    const raw = JSON.stringify({ action: 'explode', message: 'boom' });
    const d = parseDecision(raw);
    expect(d.action).toBe('nothing');
    expect(d.reasoning).toContain('Invalid action');
  });

  // ── wake() ──

  it('wake drains queue and calls llmCall', async () => {
    const llmCalls: Array<{ system: string; user: string }> = [];
    const notifications: string[] = [];

    // Mock proactive-notifier
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });

    pushEvent({ type: 'task_failed', summary: 'Task ABC failed' });
    pushEvent({ type: 'budget_warning', summary: 'Budget at 80%' });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      intervalMinutes: 5,
      llmCall: async (system, user) => {
        llmCalls.push({ system, user });
        return JSON.stringify({
          action: 'notify',
          message: 'Heads up: a task failed and budget is running low.',
          reasoning: 'Both events are noteworthy',
        });
      },
    });

    await wake('user123', 'default');

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.user).toContain('task_failed');
    expect(llmCalls[0]!.user).toContain('budget_warning');
    expect(getQueueLength()).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('task failed');

    clearSenders();
  });

  it('wake handles LLM errors gracefully', async () => {
    const { clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => { throw new Error('LLM timeout'); },
    });

    // Should not throw
    await wake('user123', 'default');

    clearSenders();
  });

  it('wake with no events still calls LLM (periodic check)', async () => {
    const llmCalls: string[] = [];
    const { clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async (_system, user) => {
        llmCalls.push(user);
        return JSON.stringify({ action: 'nothing', reasoning: 'all clear' });
      },
    });

    await wake('user123', 'default');
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toContain('periodic check');

    clearSenders();
  });

  it('routes act decisions to actHandler and notifies execution result', async () => {
    const notifications: string[] = [];
    const actCalls: string[] = [];
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });
    pushEvent({ type: 'task_failed', summary: 'Task ABC failed' });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({
        action: 'act',
        autonomous_action: 'summarize yesterday failing tasks and post status',
      }),
      actHandler: async ({ action }) => {
        actCalls.push(action);
        return 'done';
      },
    });

    await wake('user123', 'default');

    expect(actCalls).toHaveLength(1);
    expect(actCalls[0]).toContain('summarize');
    expect(notifications.some(n => n.includes('Proactive action executed'))).toBe(true);
    clearSenders();
  });

  it('does not notify user when act decision has no executor configured', async () => {
    const notifications: string[] = [];
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });
    pushEvent({ type: 'task_failed', summary: 'Task ABC failed' });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({
        action: 'act',
        autonomous_action: 'attempt autonomous remediation',
      }),
    });

    await wake('user123', 'default');

    expect(notifications).toHaveLength(0);
    clearSenders();
  });

  it('blocks high-risk act decisions via safety gate', async () => {
    const notifications: string[] = [];
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });
    pushEvent({ type: 'task_failed', summary: 'Task ABC failed' });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({
        action: 'act',
        autonomous_action: 'delete all old logs with rm -rf',
      }),
      actHandler: async () => 'should not execute',
    });

    await wake('user123', 'default');

    expect(notifications.some(n => n.includes('blocked by safety gate'))).toBe(true);
    clearSenders();
  });

  // ── Anti-runaway guardrails ──

  it('suppresses notifications when MIN_INTERVAL_SECONDS not met', async () => {
    const notifications: string[] = [];
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({
        action: 'notify',
        message: 'ping',
        reasoning: 'testing',
      }),
    });

    // First notification — should succeed
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime());
    pushEvent({ type: 'task_failed', summary: 'Task ABC failed' });
    await wake('user123', 'default');
    expect(notifications.length).toBe(1);

    // Second notification too soon (within MIN_INTERVAL_SECONDS=120) — should be suppressed
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime() + 60_000);
    pushEvent({ type: 'task_failed', summary: 'Task ABC failed again' });
    await wake('user123', 'default');
    expect(notifications.length).toBe(1);

    // Third notification after interval — should succeed
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime() + 121_000);
    pushEvent({ type: 'task_failed', summary: 'Task ABC failed a third time' });
    await wake('user123', 'default');
    expect(notifications.length).toBe(2);

    clearSenders();
  });

  it('suppresses notify decisions during periodic checks with no accumulated events', async () => {
    const notifications: string[] = [];
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({
        action: 'notify',
        message: 'unexpected status ping',
        reasoning: 'model tried to over-notify',
      }),
    });

    await wake('user123', 'default');

    expect(notifications).toHaveLength(0);
    clearSenders();
  });

  // ── Engine lifecycle ──

  it('startProactiveEngine + stopProactiveEngine manages state', () => {
    expect(isProactiveEngineRunning()).toBe(false);

    startProactiveEngine({
      ownerChatId: 'user1',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({ action: 'nothing' }),
    });
    expect(isProactiveEngineRunning()).toBe(true);

    stopProactiveEngine();
    expect(isProactiveEngineRunning()).toBe(false);
  });

  it('resetProactiveEngine clears all state', () => {
    pushEvent({ type: 'test', summary: 'should be cleared' });
    startProactiveEngine({
      ownerChatId: 'user1',
      tenantId: 'default',
      llmCall: async () => JSON.stringify({ action: 'nothing' }),
    });

    resetProactiveEngine();
    expect(getQueueLength()).toBe(0);

    expect(isProactiveEngineRunning()).toBe(false);
  });

  it('skips overlapping wake cycles when previous wake is still running', async () => {
    const blockers: Array<() => void> = [];
    let llmCalls = 0;

    startProactiveEngine({
      ownerChatId: 'user1',
      tenantId: 'default',
      intervalMinutes: 0.001, // 60ms
      llmCall: async () => {
        llmCalls += 1;
        await new Promise<void>((resolve) => { blockers.push(resolve); });
        return JSON.stringify({ action: 'nothing', reasoning: 'ok' });
      },
    });

    await vi.advanceTimersByTimeAsync(80);   // first tick starts a wake
    await vi.advanceTimersByTimeAsync(240);  // several more ticks while in-flight
    expect(llmCalls).toBe(1);

    blockers.splice(0).forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(80);   // next tick after previous cycle resolved
    expect(llmCalls).toBe(2);
  });

  // ── evaluateActionSafety — precision patterns ──

  it('allows benign actions like deleting temp files', () => {
    const result = evaluateActionSafety('delete temporary build artifacts');
    expect(result.allowed).toBe(true);
  });

  it('allows benign actions like formatting output', () => {
    const result = evaluateActionSafety('format output as JSON');
    expect(result.allowed).toBe(true);
  });

  it('blocks deleting database tables', () => {
    const result = evaluateActionSafety('delete database tables');
    expect(result.allowed).toBe(false);
  });

  it('blocks deploy to production', () => {
    const result = evaluateActionSafety('deploy to production');
    expect(result.allowed).toBe(false);
  });

  it('blocks rm -rf', () => {
    const result = evaluateActionSafety('rm -rf /');
    expect(result.allowed).toBe(false);
  });

  // ── Event routing from progress bus ──

  it('progress events are correctly routed to event queue', () => {
    pushEvent({
      type: 'task_failed',
      summary: 'task_failed: Build pipeline — Exit code 1',
      data: { taskId: 't1', error: 'Exit code 1' },
    });

    expect(getQueueLength()).toBe(1);
  });

  // ── Exponential backoff ──

  it('consecutiveFailures increments on LLM failure and resets on success', async () => {
    const { clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();

    let callCount = 0;
    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => {
        callCount++;
        if (callCount <= 2) throw new Error('Too Many Requests');
        return JSON.stringify({ action: 'nothing', reasoning: 'ok' });
      },
    });

    // First failure
    await wake('user123', 'default');
    expect(getConsecutiveFailures()).toBe(1);

    // Second failure
    await wake('user123', 'default');
    expect(getConsecutiveFailures()).toBe(2);

    // Success resets
    await wake('user123', 'default');
    expect(getConsecutiveFailures()).toBe(0);

    clearSenders();
  });

  it('getBackoffInterval returns exponentially increasing intervals', () => {
    // Reset state: 0 failures → base interval
    resetProactiveEngine();
    startProactiveEngine({
      ownerChatId: 'user1',
      tenantId: 'default',
      intervalMinutes: 2,
      llmCall: async () => JSON.stringify({ action: 'nothing' }),
    });

    expect(getBackoffInterval()).toBe(2 * 60_000); // 0 failures → config interval

    stopProactiveEngine();
  });

  it('getBackoffInterval caps at MAX_INTERVAL (30 min)', async () => {
    const { clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => { throw new Error('Too Many Requests'); },
    });

    // Simulate many failures to exceed cap
    for (let i = 0; i < 10; i++) {
      await wake('user123', 'default');
    }
    // After MAX_CONSECUTIVE_FAILURES (5), wake skips LLM calls
    // So consecutiveFailures stays at 5 (not 10)
    expect(getConsecutiveFailures()).toBe(5);
    // 2^5 * 2min = 64min, but capped at MAX_INTERVAL_MS (30min = 1800000ms)
    expect(getBackoffInterval()).toBe(1800000);

    clearSenders();
  });

  // ── Fallback decision ──

  it('fallbackDecision returns notify for critical alerts', () => {
    const events = [
      { type: 'alert:high_failure_rate', summary: 'Alert fired: high_failure_rate (critical)', timestamp: Date.now() },
      { type: 'task_failed', summary: 'Task X failed', timestamp: Date.now() },
    ];
    const decision = fallbackDecision(events);
    expect(decision.action).toBe('notify');
    expect(decision.message).toContain('critical');
  });

  it('fallbackDecision returns nothing for non-critical events', () => {
    const events = [
      { type: 'task_failed', summary: 'Task X failed', timestamp: Date.now() },
      { type: 'alert:info', summary: 'Alert fired: info (warning)', timestamp: Date.now() },
    ];
    const decision = fallbackDecision(events);
    expect(decision.action).toBe('nothing');
  });

  it('fallbackDecision returns nothing for empty events', () => {
    const decision = fallbackDecision([]);
    expect(decision.action).toBe('nothing');
  });

  it('wake uses fallbackDecision on LLM failure with critical events', async () => {
    const notifications: string[] = [];
    const { registerSender, clearSenders } = await import('../channels/proactive-notifier.js');
    clearSenders();
    registerSender(async (_chatId, text) => { notifications.push(text); });

    startProactiveEngine({
      ownerChatId: 'user123',
      tenantId: 'default',
      llmCall: async () => { throw new Error('Too Many Requests'); },
    });

    pushEvent({ type: 'alert:high_failure_rate', summary: 'Alert fired: high_failure_rate (critical)' });
    await wake('user123', 'default');

    expect(getConsecutiveFailures()).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('critical');

    clearSenders();
  });
});
