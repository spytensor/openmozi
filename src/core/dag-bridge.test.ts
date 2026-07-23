import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { loadConfig } from '../config/index.js';
import {
  DecomposeTaskInputSchema,
  criticReviewPlan,
  executeDecomposeTask,
  validateDecomposePlan,
  verifyDagOutput,
  replanFromVerifierFailure,
} from './dag-bridge.js';
import type { LLMClient } from './llm.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

afterEach(() => {
  delete process.env.MOZI_TEST_INLINE_DAG;
  delete process.env.MOZI_E2E_LLM;
  delete process.env.MOZI_BRAIN_MAX_PLAN_STEPS;
  loadConfig('/nonexistent/dag-bridge-test-default.json');
});

function makePlan(stepCount: number) {
  return {
    goal: `Run ${stepCount} step plan`,
    all_steps_independent: true,
    subtasks: Array.from({ length: stepCount }, (_, i) => ({
      title: `Step ${i + 1}`,
      objective: `Complete step ${i + 1}`,
      done_criteria: 'done',
      depends_on: [],
    })),
  };
}

function makeFallbackClient(): LLMClient {
  return {
    provider: 'test',
    async chat() {
      return {
        content: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'test-model',
        stop_reason: 'end_turn',
      };
    },
    async *chatStream() {
      yield {
        type: 'done',
        response: {
          content: 'done',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'test-model',
          stop_reason: 'end_turn',
        },
      };
    },
  };
}

describe('core/dag-bridge', () => {
  describe('DecomposeTaskInputSchema', () => {
    it('parses valid input with dependencies', () => {
      const input = {
        goal: 'Build a REST API',
        subtasks: [
          { title: 'Design schema', objective: 'Create database schema for the API', done_criteria: 'Schema is persisted and validated', depends_on: [] },
          { title: 'Implement endpoints', objective: 'Build CRUD endpoints', done_criteria: 'Endpoints pass contract tests', depends_on: [0] },
          { title: 'Write tests', objective: 'Unit tests for all endpoints', done_criteria: 'All endpoint tests pass', depends_on: [1] },
        ],
      };

      const result = DecomposeTaskInputSchema.parse(input);
      expect(result.goal).toBe('Build a REST API');
      expect(result.subtasks).toHaveLength(3);
      expect(result.subtasks[1].depends_on).toEqual([0]);
      expect(result.subtasks[2].depends_on).toEqual([1]);
    });

    it('rejects fewer than 2 subtasks', () => {
      const input = {
        goal: 'Simple task',
        subtasks: [{ title: 'Only one', objective: 'Not enough', done_criteria: 'One verified', depends_on: [] }],
      };

      expect(() => DecomposeTaskInputSchema.parse(input)).toThrow();
    });

    it('rejects more than 20 subtasks', () => {
      const subtasks = Array.from({ length: 21 }, (_, i) => ({
        title: `Task ${i}`,
        objective: `Do thing ${i}`,
        done_criteria: `Thing ${i} verified`,
        depends_on: [],
      }));

      expect(() => DecomposeTaskInputSchema.parse({ goal: 'Too many', subtasks })).toThrow();
    });

    it('requires every subtask to declare depends_on', () => {
      expect(() => DecomposeTaskInputSchema.parse({
        goal: 'Missing dependency declaration',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A verified' },
          { title: 'B', objective: 'Do B', done_criteria: 'B verified', depends_on: [0] },
        ],
      })).toThrow();
    });

    it('requires acceptance criteria while defaulting optional execution hints', () => {
      const input = {
        goal: 'Test defaults',
        subtasks: [
          { title: 'A', objective: 'Do A', depends_on: [] },
          { title: 'B', objective: 'Do B', depends_on: [] },
        ],
      };
      expect(() => DecomposeTaskInputSchema.parse(input)).toThrow();

      const result = DecomposeTaskInputSchema.parse({
        ...input,
        subtasks: input.subtasks.map((subtask) => ({ ...subtask, done_criteria: `${subtask.title} is verified` })),
      });
      expect(result.subtasks[0].depends_on).toEqual([]);
      expect(result.subtasks[0].done_criteria).toBe('A is verified');
      expect(result.subtasks[0].agent_type_hint).toBe('any');
      expect(result.subtasks[0].constraints).toEqual({});
      expect(result.all_steps_independent).toBe(false);
    });

    it('parses constraints when provided', () => {
      const input = {
        goal: 'With constraints',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A verified', depends_on: [], constraints: { timeout_seconds: 60, max_retries: 3, max_tokens: 4000 } },
          { title: 'B', objective: 'Do B', done_criteria: 'B verified', depends_on: [] },
        ],
      };

      const result = DecomposeTaskInputSchema.parse(input);
      expect(result.subtasks[0].constraints.timeout_seconds).toBe(60);
      expect(result.subtasks[0].constraints.max_retries).toBe(3);
      expect(result.subtasks[0].constraints.max_tokens).toBe(4000);
    });

    it('rejects every multi-step zero-edge plan without an independence attestation', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Produce a report',
        subtasks: [
          { title: 'Research', objective: 'Gather facts', done_criteria: 'Sources persisted', depends_on: [] },
          { title: 'Report', objective: 'Write the report', done_criteria: 'Report persisted', depends_on: [] },
        ],
      });
      expect(() => validateDecomposePlan(plan, 12)).toThrow('zero dependency edges');
    });

    it('accepts an explicitly independent 3-step zero-edge plan', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Research independent markets',
        all_steps_independent: true,
        subtasks: [
          { title: 'Market A', objective: 'Research A', done_criteria: 'A evidenced', depends_on: [] },
          { title: 'Market B', objective: 'Research B', done_criteria: 'B evidenced', depends_on: [] },
          { title: 'Market C', objective: 'Research C', done_criteria: 'C evidenced', depends_on: [] },
        ],
      });
      expect(() => validateDecomposePlan(plan, 12)).not.toThrow();
    });

    it('rejects duplicate dependency indices and contradictory attestations', () => {
      const duplicate = DecomposeTaskInputSchema.parse({
        goal: 'Duplicate edge',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A verified', depends_on: [] },
          { title: 'B', objective: 'Do B', done_criteria: 'B verified', depends_on: [0, 0] },
        ],
      });
      expect(() => validateDecomposePlan(duplicate, 12)).toThrow('repeats depends_on index 0');

      const contradictory = DecomposeTaskInputSchema.parse({
        goal: 'Contradictory graph',
        all_steps_independent: true,
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A verified', depends_on: [] },
          { title: 'B', objective: 'Do B', done_criteria: 'B verified', depends_on: [0] },
        ],
      });
      expect(() => validateDecomposePlan(contradictory, 12)).toThrow('contradicts');
    });

    it('preserves the dependency error and adds a corrective indexing hint', () => {
      const selfDependent = DecomposeTaskInputSchema.parse({
        goal: 'Self dependency',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A verified', depends_on: [] },
          { title: 'B', objective: 'Do B', done_criteria: 'B verified', depends_on: [1] },
        ],
      });

      expect(() => validateDecomposePlan(selfDependent, 12)).toThrow(
        'depends_on index 1, which must be less than its own index 1',
      );
      expect(() => validateDecomposePlan(selfDependent, 12)).toThrow(
        'depends_on indices are 0-based; a subtask cannot depend on itself; "the previous subtask" is index N-1. Re-call decompose_task with corrected depends_on.',
      );
    });
  });

  describe('executeDecomposeTask plan step limit', () => {
    it('allows a 6-step plan with default max_plan_steps', async () => {
      loadConfig('/nonexistent/dag-bridge-defaults.json');
      process.env.MOZI_TEST_INLINE_DAG = '1';
      process.env.MOZI_E2E_LLM = 'scripted';

      const result = await executeDecomposeTask(makePlan(6), {
        chatId: 'chat-six-step-default',
        tenantId: 'default',
        systemPrompt: '# SOUL.md — Runtime Identity\nTest DAG brain.',
        fallbackClient: makeFallbackClient(),
      });

      expect(result).toContain('Planner-Critic-Verifier Results');
      expect(result).toContain('Verifier passed: yes');
    });

    it('rejects plans exceeding max_plan_steps with the new message', async () => {
      process.env.MOZI_BRAIN_MAX_PLAN_STEPS = '5';
      loadConfig('/nonexistent/dag-bridge-max-plan-steps.json');
      process.env.MOZI_TEST_INLINE_DAG = '1';
      process.env.MOZI_E2E_LLM = 'scripted';

      await expect(executeDecomposeTask(makePlan(6), {
        chatId: 'chat-max-plan-steps',
        tenantId: 'default',
        systemPrompt: '# SOUL.md — Runtime Identity\nTest DAG brain.',
        fallbackClient: makeFallbackClient(),
      })).rejects.toThrow(
        'Too many subtasks: 6 exceeds max_plan_steps=5. Reduce the number of subtasks or increase brain.max_plan_steps in config.',
      );
    });
  });

  describe('planner-critic-verifier helpers', () => {
    it('criticReviewPlan reports risk hints after schema-enforced criteria', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Ship production change',
        subtasks: [
          { title: 'Deploy to production', objective: 'Deploy safely', done_criteria: 'Deployment health passes', depends_on: [] },
          { title: 'Validate', objective: 'Check health', done_criteria: 'Health is green', depends_on: [0] },
        ],
      });
      const review = criticReviewPlan(plan);
      expect(review.warnings.join('\n')).not.toContain('missing done_criteria');
      expect(review.risks.join('\n')).toContain('high-risk');
    });

    it('verifyDagOutput detects failed subtasks from DAG output text', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Test verifier',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A done', depends_on: [] },
          { title: 'B', objective: 'Do B', done_criteria: 'B done', depends_on: [] },
        ],
      });
      const output = [
        'Task 1: A',
        'All good. A done successfully.',
        '',
        '---',
        '',
        'Task 2: B',
        'Error (task skipped): boom',
      ].join('\n');

      const report = verifyDagOutput(plan, output);
      expect(report.passed).toBe(false);
      expect(report.failedSubtaskIndexes).toContain(1);
      expect(report.findings.join('\n')).toContain('failed execution');
    });

    it('replanFromVerifierFailure rebuilds failed subtasks for next planner iteration', () => {
      const plan = DecomposeTaskInputSchema.parse({
        goal: 'Retry plan',
        subtasks: [
          { title: 'A', objective: 'Do A', done_criteria: 'A done', depends_on: [] },
          { title: 'B', objective: 'Do B', done_criteria: 'B done', depends_on: [0] },
        ],
      });
      const replanned = replanFromVerifierFailure(plan, {
        passed: false,
        failedSubtaskIndexes: [1],
        findings: ['Subtask 1 failed'],
      }, 1);

      expect(replanned).not.toBeNull();
      expect(replanned!.subtasks[0].title).toContain('Iteration 2');
      expect(replanned!.subtasks.length).toBeGreaterThanOrEqual(2);
    });
  });
});
