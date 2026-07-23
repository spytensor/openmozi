import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { buildActivePlanContext, hasNonTerminalPlanForChat } from './plan-grounding.js';
import { createPlanTasks, getPlanSteps } from './plan-runner.js';
import { resetColumnsEnsured, updateStatus } from '../store/task-dag.js';
import type { DecomposeTaskInput } from './dag-bridge.js';

const PLAN: DecomposeTaskInput = {
  goal: 'Ship the quarterly report',
  all_steps_independent: false,
  subtasks: [
    { title: 'Gather data', objective: 'obj', done_criteria: 'Data is persisted and sourced', depends_on: [], agent_type_hint: 'any', constraints: {} },
    { title: 'Write draft', objective: 'obj', done_criteria: 'Draft satisfies the requested scope', depends_on: [0], agent_type_hint: 'any', constraints: {} },
  ],
};

describe('core/plan-grounding', () => {
  let tmpDir: string;

  beforeEach(() => {
    ({ tmpDir } = setupTestDb());
    resetColumnsEnsured();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('returns null when the chat has no plans', () => {
    expect(buildActivePlanContext('chat-without-plans')).toBeNull();
  });

  it('renders per-step status from the DB for the owning chat only', () => {
    const created = createPlanTasks(PLAN, {
      tenantId: 'default',
      chatId: 'chat-a',
      sessionId: 'sess-a',
      systemPrompt: '# SOUL.md — Runtime Identity\nPlan grounding test.',
    });
    updateStatus(created.rootTaskId, 'running', 'default');
    const steps = getPlanSteps(created.rootTaskId, 'default');
    updateStatus(steps[0].id, 'completed', 'default');
    updateStatus(steps[1].id, 'failed', 'default');

    const block = buildActivePlanContext('chat-a');
    expect(block).not.toBeNull();
    expect(block).toContain('Ship the quarterly report');
    expect(block).toContain('1/2 steps done');
    expect(block).toContain('[done] Gather data');
    expect(block).toContain('[FAILED] Write draft');
    expect(block).toContain('do not re-decompose');
    expect(hasNonTerminalPlanForChat('chat-a')).toBe(true);

    // A different chat sees nothing.
    expect(buildActivePlanContext('chat-b')).toBeNull();
    expect(hasNonTerminalPlanForChat('chat-b')).toBe(false);

    updateStatus(created.rootTaskId, 'completed', 'default');
    expect(hasNonTerminalPlanForChat('chat-a')).toBe(false);
  });
});
