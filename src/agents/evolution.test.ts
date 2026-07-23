import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import * as registry from './registry.js';
import { loadConfig } from '../config/index.js';
import { getPendingRequests } from '../security/gates.js';
import {
  calculateScore,
  getScore,
  getTopAgents,
  getUnderperformers,
  refreshScoreAndMaybeEvolve,
} from './agent-scoring.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

/** Helper: insert a task attempt directly into the DB */
function insertAttempt(opts: {
  id: string;
  taskId: string;
  agentId: string;
  attemptNumber: number;
  resultStatus?: string;
  resultPayload?: Record<string, unknown>;
  tenantId?: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_attempts (id, tenant_id, task_id, agent_id, attempt_number, result_status, result_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.tenantId ?? 'default',
    opts.taskId,
    opts.agentId,
    opts.attemptNumber,
    opts.resultStatus ?? null,
    opts.resultPayload ? JSON.stringify(opts.resultPayload) : null,
  );
}

describe('agents/evolution', () => {
  // Register test agents
  beforeAll(() => {
    registry.register({ id: 'evo-agent-1', name: 'Evo Agent 1', type: 'dynamic' });
    registry.register({ id: 'evo-agent-2', name: 'Evo Agent 2', type: 'dynamic' });
    registry.register({ id: 'evo-agent-3', name: 'Evo Agent 3', type: 'preset' });
    registry.register({
      id: 'evo-agent-budget',
      name: 'Evo Agent Budget',
      type: 'dynamic',
      config: { budget_allocated: 50000 },
    });
  });

  describe('calculateScore', () => {
    it('should return zero scores when no task attempts exist', () => {
      const result = calculateScore('evo-agent-2');

      expect(result.agentId).toBe('evo-agent-2');
      expect(result.totalTasks).toBe(0);
      expect(result.completedTasks).toBe(0);
      expect(result.successRate).toBe(0);
      expect(result.avgTokenCost).toBe(0);
      // efficiency = 1 - 0/100000 = 1
      expect(result.efficiencyScore).toBe(1);
      // reliability = 1 - 0/3 = 1
      expect(result.reliabilityScore).toBe(1);
      // score = 0.5*0 + 0.3*1 + 0.2*1 = 0.5
      expect(result.evolutionScore).toBeCloseTo(0.5, 5);
    });

    it('should calculate correct score with completed tasks', () => {
      // 2 tasks: task-a completed on first try, task-b failed
      insertAttempt({ id: 'att-1', taskId: 'task-a', agentId: 'evo-agent-1', attemptNumber: 1, resultStatus: 'completed', resultPayload: { token_cost: 1000 } });
      insertAttempt({ id: 'att-2', taskId: 'task-b', agentId: 'evo-agent-1', attemptNumber: 1, resultStatus: 'failed', resultPayload: { token_cost: 2000 } });

      const result = calculateScore('evo-agent-1');

      // success_rate = 1/2 = 0.5
      expect(result.successRate).toBeCloseTo(0.5, 5);
      expect(result.totalTasks).toBe(2);
      expect(result.completedTasks).toBe(1);
      // avg_token_cost = (1000+2000)/2 = 1500
      expect(result.avgTokenCost).toBeCloseTo(1500, 5);
      // efficiency = 1 - 1500/100000 = 0.985
      expect(result.efficiencyScore).toBeCloseTo(0.985, 3);
      // avg_retries = (2 attempts - 2 tasks) / 2 = 0
      expect(result.avgRetries).toBe(0);
      // reliability = 1 - 0/3 = 1
      expect(result.reliabilityScore).toBe(1);
      // score = 0.5*0.5 + 0.3*0.985 + 0.2*1 = 0.25 + 0.2955 + 0.2 = 0.7455
      expect(result.evolutionScore).toBeCloseTo(0.7455, 3);
    });

    it('should account for retries in reliability score', () => {
      // Agent 3: one task with 3 attempts (2 retries)
      insertAttempt({ id: 'att-3a', taskId: 'task-c', agentId: 'evo-agent-3', attemptNumber: 1, resultStatus: 'failed', resultPayload: { token_cost: 500 } });
      insertAttempt({ id: 'att-3b', taskId: 'task-c', agentId: 'evo-agent-3', attemptNumber: 2, resultStatus: 'failed', resultPayload: { token_cost: 500 } });
      insertAttempt({ id: 'att-3c', taskId: 'task-c', agentId: 'evo-agent-3', attemptNumber: 3, resultStatus: 'completed', resultPayload: { token_cost: 500 } });

      const result = calculateScore('evo-agent-3');

      // success_rate = 1/1 = 1
      expect(result.successRate).toBe(1);
      // avg_retries = (3 attempts - 1 task) / 1 task = 2
      expect(result.avgRetries).toBe(2);
      // reliability = 1 - 2/3 = 0.333...
      expect(result.reliabilityScore).toBeCloseTo(1 / 3, 3);
    });

    it('should use budget_allocated from agent config', () => {
      insertAttempt({ id: 'att-4', taskId: 'task-d', agentId: 'evo-agent-budget', attemptNumber: 1, resultStatus: 'completed', resultPayload: { token_cost: 25000 } });

      const result = calculateScore('evo-agent-budget');

      // efficiency = 1 - 25000/50000 = 0.5
      expect(result.efficiencyScore).toBeCloseTo(0.5, 5);
    });

    it('should use custom weights', () => {
      const result = calculateScore('evo-agent-1', 'default', { w1: 1.0, w2: 0, w3: 0 });

      // With w1=1, w2=0, w3=0 → score = success_rate
      expect(result.evolutionScore).toBeCloseTo(result.successRate, 5);
      expect(result.weights.w1).toBe(1.0);
      expect(result.weights.w2).toBe(0);
      expect(result.weights.w3).toBe(0);
    });

    it('should update agent_registry with computed scores', () => {
      const result = calculateScore('evo-agent-1');
      const agent = registry.get('evo-agent-1');

      expect(agent).not.toBeNull();
      expect(agent!.success_rate).toBeCloseTo(result.successRate, 5);
      expect(agent!.avg_token_cost).toBeCloseTo(result.avgTokenCost, 5);
      expect(agent!.evolution_score).toBeCloseTo(result.evolutionScore, 5);
    });

    it('should handle result_payload without token_cost', () => {
      registry.register({ id: 'evo-no-cost', name: 'No Cost', type: 'dynamic' });
      insertAttempt({ id: 'att-nc1', taskId: 'task-nc', agentId: 'evo-no-cost', attemptNumber: 1, resultStatus: 'completed', resultPayload: { some_field: 'value' } });

      const result = calculateScore('evo-no-cost');

      expect(result.avgTokenCost).toBe(0);
      expect(result.efficiencyScore).toBe(1);
    });

    it('should handle null result_payload', () => {
      registry.register({ id: 'evo-null-payload', name: 'Null Payload', type: 'dynamic' });
      insertAttempt({ id: 'att-np1', taskId: 'task-np', agentId: 'evo-null-payload', attemptNumber: 1, resultStatus: 'completed' });

      const result = calculateScore('evo-null-payload');

      expect(result.avgTokenCost).toBe(0);
    });
  });

  describe('getScore', () => {
    it('should return stored evolution_score', () => {
      // evo-agent-1 was scored above
      const score = getScore('evo-agent-1');
      expect(score).not.toBeNull();
      expect(typeof score).toBe('number');

      const agent = registry.get('evo-agent-1');
      expect(score).toBe(agent!.evolution_score);
    });

    it('should return null for unknown agent', () => {
      expect(getScore('nonexistent-agent')).toBeNull();
    });
  });

  describe('getTopAgents', () => {
    it('should return agents ordered by evolution_score desc', () => {
      // Ensure we have scores computed
      calculateScore('evo-agent-1');
      calculateScore('evo-agent-2');
      calculateScore('evo-agent-3');

      const top = getTopAgents(3);
      expect(top.length).toBeGreaterThanOrEqual(3);

      // Verify descending order
      for (let i = 1; i < top.length; i++) {
        expect(top[i - 1].evolution_score).toBeGreaterThanOrEqual(top[i].evolution_score);
      }
    });

    it('should respect the limit parameter', () => {
      const top = getTopAgents(2);
      expect(top.length).toBeLessThanOrEqual(2);
    });
  });

  describe('getUnderperformers', () => {
    it('should return agents below threshold', () => {
      const underperformers = getUnderperformers(0.8);

      for (const agent of underperformers) {
        expect(agent.evolution_score).toBeLessThan(0.8);
      }
    });

    it('should return empty array when all agents are above threshold', () => {
      const underperformers = getUnderperformers(0);
      expect(underperformers).toEqual([]);
    });

    it('should return all agents when threshold is very high', () => {
      const all = getUnderperformers(999);
      // Should include all agents in the DB
      expect(all.length).toBeGreaterThan(0);
    });
  });

  describe('lifecycle transitions', () => {
    it('proposes promotion when hard gate is enabled', () => {
      const gatedConfigPath = join(tmpDir, 'config-promote-gate.json');
      writeFileSync(gatedConfigPath, JSON.stringify({
        security: { hard_gates: ['agent_promote'] },
      }, null, 2));
      loadConfig(gatedConfigPath);
      registry.register({
        id: 'evo-promote-gated',
        name: 'Evo Promote Gated',
        type: 'dynamic',
        spawn_count: 6,
      });
      insertAttempt({
        id: 'att-promote-gated-1',
        taskId: 'task-promote-gated-1',
        agentId: 'evo-promote-gated',
        attemptNumber: 1,
        resultStatus: 'completed',
        resultPayload: { token_cost: 5 },
      });

      const result = refreshScoreAndMaybeEvolve('evo-promote-gated');
      const agent = registry.get('evo-promote-gated');
      const pending = getPendingRequests().find((req) => req.context?.agent_id === 'evo-promote-gated');

      expect(result.decision.action).toBe('promote_proposed');
      expect(result.decision.requiresApproval).toBe(true);
      expect(result.decision.applied).toBe(false);
      expect(agent?.type).toBe('dynamic');
      expect(pending?.action).toBe('agent_promote');
    });

    it('auto-promotes when hard gate is disabled', () => {
      const configPath = join(tmpDir, 'config-no-promote-gate.json');
      writeFileSync(configPath, JSON.stringify({
        security: {
          hard_gates: ['skill_register', 'l3_grant', 'external_comm'],
        },
      }, null, 2));
      loadConfig(configPath);

      registry.register({
        id: 'evo-promote-auto',
        name: 'Evo Promote Auto',
        type: 'dynamic',
        spawn_count: 6,
      });
      insertAttempt({
        id: 'att-promote-auto-1',
        taskId: 'task-promote-auto-1',
        agentId: 'evo-promote-auto',
        attemptNumber: 1,
        resultStatus: 'completed',
        resultPayload: { token_cost: 10 },
      });

      const result = refreshScoreAndMaybeEvolve('evo-promote-auto');
      const agent = registry.get('evo-promote-auto');

      expect(result.decision.action).toBe('promoted');
      expect(result.decision.applied).toBe(true);
      expect(result.decision.requiresApproval).toBe(false);
      expect(agent?.type).toBe('preset');
    });

    it('demotes low-performing preset agents at threshold', () => {
      loadConfig(join(tmpDir, 'missing-config.json'));
      registry.register({
        id: 'evo-demote-preset',
        name: 'Evo Demote Preset',
        type: 'preset',
        spawn_count: 20,
      });
      for (let i = 1; i <= 10; i++) {
        insertAttempt({
          id: `att-demote-${i}`,
          taskId: `task-demote-${i}`,
          agentId: 'evo-demote-preset',
          attemptNumber: 1,
          resultStatus: 'failed',
          resultPayload: { token_cost: 100000 },
        });
      }

      const result = refreshScoreAndMaybeEvolve('evo-demote-preset');
      const agent = registry.get('evo-demote-preset');

      expect(result.decision.action).toBe('demoted');
      expect(agent?.type).toBe('dynamic');
      expect(result.breakdown.totalTasks).toBe(10);
      expect(result.breakdown.evolutionScore).toBeLessThan(0.5);
    });

    it('blacklists repeated low-quality dynamic agents', () => {
      loadConfig(join(tmpDir, 'missing-config.json'));
      registry.register({
        id: 'evo-blacklist',
        name: 'Evo Blacklist',
        type: 'dynamic',
        spawn_count: 4,
      });
      for (let attempt = 1; attempt <= 4; attempt++) {
        insertAttempt({
          id: `att-blacklist-${attempt}`,
          taskId: 'task-blacklist-1',
          agentId: 'evo-blacklist',
          attemptNumber: attempt,
          resultStatus: 'failed',
          resultPayload: { token_cost: 100000 },
        });
      }

      const result = refreshScoreAndMaybeEvolve('evo-blacklist');
      const agent = registry.get('evo-blacklist');

      expect(result.decision.action).toBe('blacklisted');
      expect(agent?.status).toBe('inactive');
      expect(result.breakdown.evolutionScore).toBeLessThan(0.3);
    });
  });
});
