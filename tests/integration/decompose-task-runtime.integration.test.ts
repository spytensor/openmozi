import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../src/test-helpers.js';
import { loadConfig } from '../../src/config/index.js';
import { createSession } from '../../src/memory/sessions.js';
import { getSessionTimeline, saveTimelineItem } from '../../src/memory/session-timeline.js';
import { executeTool } from '../../src/tools/executor.js';
import { getById, listPlanRootTasks, resetColumnsEnsured } from '../../src/store/task-dag.js';
import { getPlanSteps, isPlanRunActive } from '../../src/core/plan-runner.js';
import { on, type ProgressEvent } from '../../src/progress/event-bus.js';
import type { ChatResponse, LLMClient } from '../../src/core/llm.js';

function response(content: string): ChatResponse {
  return {
    content,
    usage: { input_tokens: 5, output_tokens: 2 },
    model: 'scripted-decompose-smoke',
    stop_reason: 'end_turn',
  };
}

async function waitForPlan(rootTaskId: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (isPlanRunActive(rootTaskId)) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('detached plan did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('registered decompose_task durable runtime', () => {
  let tmpDir: string;
  let previousMoziHome: string | undefined;
  let previousE2eLlm: string | undefined;

  beforeEach(() => {
    previousMoziHome = process.env.MOZI_HOME;
    previousE2eLlm = process.env.MOZI_E2E_LLM;
    const setup = setupTestDb();
    tmpDir = setup.tmpDir;
    process.env.MOZI_HOME = tmpDir;
    process.env.MOZI_E2E_LLM = 'scripted';
    resetColumnsEnsured();
    loadConfig('/nonexistent/mozi-decompose-runtime-smoke.json');
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
    if (previousMoziHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = previousMoziHome;
    if (previousE2eLlm === undefined) delete process.env.MOZI_E2E_LLM;
    else process.env.MOZI_E2E_LLM = previousE2eLlm;
    vi.restoreAllMocks();
  });

  it('persists, executes, reports, and delivers a detached plan without legacy project events', async () => {
    const tenantId = 'tenant-decompose-smoke';
    const userId = 'user-decompose-smoke';
    const chatId = 'chat-decompose-smoke';
    const turnId = 'turn-decompose-smoke';
    const session = createSession(userId, 'Decompose runtime smoke', tenantId);
    const client = {
      provider: 'scripted',
      chat: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        const system = messages.find(message => message.role === 'system')?.content ?? '';
        if (system.includes('strict runtime acceptance verifier')) {
          const evidenceId = /Result evidence ID: (result:[^\s]+)/.exec(
            messages.find(message => message.role === 'user')?.content ?? '',
          )?.[1];
          return response(JSON.stringify({
            verdict: 'passed',
            summary: 'Persisted results satisfy the original request.',
            findings: [],
            evidence_ids: evidenceId ? [evidenceId] : [],
          }));
        }
        if (system.includes('reporting the completion of a background plan')) {
          return response('Plan completed with persisted runtime evidence.');
        }
        return response('Step completed with runtime evidence.');
      }),
      chatStream: vi.fn(),
    } as unknown as LLMClient;
    const events: ProgressEvent[] = [];
    const unsubscribe = on(event => events.push(event));

    try {
      saveTimelineItem({
        tenantId, sessionId: session.id, chatId, turnId,
        type: 'message', eventKey: 'message:source-request', timestamp: Date.now(),
        data: { role: 'user', content: 'Verify the durable plan runtime end to end.' },
      });
      const result = await executeTool({
        id: 'decompose-smoke-call',
        type: 'function',
        function: {
          name: 'decompose_task',
          arguments: JSON.stringify({
            goal: 'Verify the durable plan runtime',
            subtasks: [
              { title: 'Collect evidence', objective: 'Return deterministic evidence', done_criteria: 'Evidence returned', depends_on: [] },
              { title: 'Summarize evidence', objective: 'Return a deterministic summary', done_criteria: 'Summary returned', depends_on: [0] },
            ],
          }),
        },
      }, {
        tenantId,
        userId,
        chatId,
        sessionId: session.id,
        turnId,
        agentId: `session:${session.id}`,
        permissionLevel: 'L3_FULL_ACCESS',
        systemPrompt: '# SOUL.md — Runtime Identity\nMOZI integration smoke identity.',
        client,
      });

      expect(result.is_error).toBe(false);
      expect(result.ends_turn).toBe(true);
      expect(result.content).toContain('RUNNING IN BACKGROUND');

      const root = listPlanRootTasks(tenantId, { limit: 1 })[0];
      expect(root).toBeTruthy();
      expect(root.status).toBe('running');
      expect(getPlanSteps(root.id, tenantId)).toHaveLength(2);

      await waitForPlan(root.id);

      expect(getById(root.id, tenantId)?.status).toBe('completed');
      expect(getPlanSteps(root.id, tenantId).map(step => step.status)).toEqual(['completed', 'completed']);
      expect(events.some(event => event.type === 'dag_created' && event.taskId === root.id)).toBe(true);
      expect(events.some(event => event.type === 'task_started')).toBe(true);
      expect(events.some(event => event.type === 'task_completed')).toBe(true);

      // Typed plan presentation contract (Issue #735): the plan's structure is
      // emitted as data on the live path, not persisted as formatted prose.
      const planStarted = events.find(event => event.type === 'plan_started');
      expect(planStarted?.taskId).toBe(root.id);
      expect(planStarted?.taskTitle).toBe('Verify the durable plan runtime');
      expect(planStarted?.locale).toBe('en');
      const steps = getPlanSteps(root.id, tenantId);
      expect(planStarted?.planPhases).toEqual([
        { taskId: steps[0].id, title: 'Collect evidence', dependsOn: [] },
        { taskId: steps[1].id, title: 'Summarize evidence', dependsOn: [steps[0].id] },
      ]);

      // The turn's final assistant text is a one-sentence handoff — the phase
      // list must not be duplicated into persisted prose on the new path.
      expect(result.ends_turn_message).toContain('2-step plan');
      expect(result.ends_turn_message).not.toMatch(/\n\s*1\./);

      const removedEventTypes = new Set([
        'project_mode_kickoff', 'project_plan_updated', 'team_assignment', 'milestone_reached',
        'blocker_detected', 'risk_detected', 'next_step_updated', 'project_report',
      ]);
      expect(events.some(event => removedEventTypes.has(event.type))).toBe(false);

      const timeline = getSessionTimeline(session.id, 100, tenantId);
      expect(timeline.some(item => item.type === 'message'
        && JSON.stringify(item.data).includes('Plan completed'))).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
