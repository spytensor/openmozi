import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  getSystemOverview,
  getAgentStats,
  getTaskHistory,
  getCostSummary,
  getSloSummary,
  listObservedModels,
} from './dashboard.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM agent_registry').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM task_attempts').run();
  db.prepare('DELETE FROM billing_records').run();
  db.prepare('DELETE FROM tool_spans').run();
  db.prepare('DELETE FROM turn_traces').run();
});

// ---------------------------------------------------------------------------
// Helpers to insert test data
// ---------------------------------------------------------------------------

function insertAgent(overrides: Record<string, unknown> = {}): string {
  const db = getDb();
  const defaults = {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    tenant_id: 'default',
    name: 'Test Agent',
    type: 'preset',
    status: 'active',
    spawn_count: 1,
    success_rate: 0.8,
    avg_token_cost: 100.0,
    evolution_score: 0.75,
  };
  const data = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO agent_registry (id, tenant_id, name, type, status, spawn_count, success_rate, avg_token_cost, evolution_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.id, data.tenant_id, data.name, data.type, data.status, data.spawn_count, data.success_rate, data.avg_token_cost, data.evolution_score);
  return data.id as string;
}

function insertTask(overrides: Record<string, unknown> = {}): string {
  const db = getDb();
  const defaults = {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    tenant_id: 'default',
    title: 'Test Task',
    status: 'pending',
    priority: 0,
    assigned_agent: null,
  };
  const data = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO tasks (id, tenant_id, title, status, priority, assigned_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.id, data.tenant_id, data.title, data.status, data.priority, data.assigned_agent);
  return data.id as string;
}

function insertAttempt(overrides: Record<string, unknown> = {}): string {
  const db = getDb();
  const defaults = {
    id: `attempt-${Math.random().toString(36).slice(2, 8)}`,
    tenant_id: 'default',
    task_id: 'task-1',
    agent_id: 'agent-1',
    attempt_number: 1,
    result_status: null,
    ended_at: null,
  };
  const data = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO task_attempts (id, tenant_id, task_id, agent_id, attempt_number, result_status, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.id, data.tenant_id, data.task_id, data.agent_id, data.attempt_number, data.result_status, data.ended_at);
  return data.id as string;
}

function insertLlmBilling(overrides: Record<string, unknown> = {}): void {
  const db = getDb();
  const defaults = {
    tenant_id: 'default',
    model: 'mock-model',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.01,
    created_at: new Date().toISOString(),
  };
  const data = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO billing_records (tenant_id, record_type, model, input_tokens, output_tokens, cost_usd, pricing_source, usage_status, created_at)
    VALUES (?, 'llm_call', ?, ?, ?, ?, 'catalog_estimate', 'provider_reported', ?)
  `).run(
    data.tenant_id,
    data.model,
    data.input_tokens,
    data.output_tokens,
    data.cost_usd,
    data.created_at,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard', () => {
  describe('getSystemOverview', () => {
    it('should return zeros for empty database', () => {
      const overview = getSystemOverview();
      expect(overview.active_agents).toBe(0);
      expect(overview.running_tasks).toBe(0);
      expect(overview.total_tasks).toBe(0);
      expect(overview.completed_tasks).toBe(0);
      expect(overview.failed_tasks).toBe(0);
      expect(overview.total_token_usage).toBe(0);
      expect(overview.agent_types.preset).toBe(0);
      expect(overview.agent_types.dynamic).toBe(0);
    });

    it('should return correct counts with populated data', () => {
      // Insert agents
      insertAgent({ id: 'a1', type: 'preset', status: 'active', spawn_count: 5, avg_token_cost: 100 });
      insertAgent({ id: 'a2', type: 'dynamic', status: 'active', spawn_count: 3, avg_token_cost: 200 });
      insertAgent({ id: 'a3', type: 'preset', status: 'inactive', spawn_count: 1, avg_token_cost: 50 });

      // Insert tasks
      insertTask({ id: 't1', status: 'running' });
      insertTask({ id: 't2', status: 'completed' });
      insertTask({ id: 't3', status: 'completed' });
      insertTask({ id: 't4', status: 'failed' });
      insertTask({ id: 't5', status: 'pending' });

      const overview = getSystemOverview();
      expect(overview.active_agents).toBe(2);
      expect(overview.running_tasks).toBe(1);
      expect(overview.total_tasks).toBe(5);
      expect(overview.completed_tasks).toBe(2);
      expect(overview.failed_tasks).toBe(1);
      // total_token_usage = (100*5) + (200*3) + (50*1) = 500+600+50 = 1150
      expect(overview.total_token_usage).toBe(1150);
      expect(overview.agent_types.preset).toBe(2);
      expect(overview.agent_types.dynamic).toBe(1);
    });
  });

  describe('getAgentStats', () => {
    it('should return null for non-existent agent', () => {
      const stats = getAgentStats('non-existent');
      expect(stats).toBeNull();
    });

    it('should return correct metrics for an agent', () => {
      const agentId = insertAgent({
        id: 'agent-stats',
        name: 'Stats Agent',
        type: 'preset',
        status: 'active',
        evolution_score: 0.85,
        success_rate: 0.9,
        avg_token_cost: 150,
        spawn_count: 10,
      });

      const taskId1 = insertTask({ id: 'task-s1', assigned_agent: agentId });
      const taskId2 = insertTask({ id: 'task-s2', assigned_agent: agentId });

      insertAttempt({
        id: 'att-1',
        task_id: taskId1,
        agent_id: agentId,
        attempt_number: 1,
        result_status: 'completed',
      });
      insertAttempt({
        id: 'att-2',
        task_id: taskId2,
        agent_id: agentId,
        attempt_number: 1,
        result_status: 'failed',
      });

      const stats = getAgentStats(agentId);
      expect(stats).not.toBeNull();
      expect(stats!.id).toBe(agentId);
      expect(stats!.name).toBe('Stats Agent');
      expect(stats!.evolution_score).toBe(0.85);
      expect(stats!.success_rate).toBe(0.9);
      expect(stats!.avg_token_cost).toBe(150);
      expect(stats!.spawn_count).toBe(10);
      expect(stats!.task_history).toHaveLength(2);
      expect(stats!.total_tasks).toBe(2);
      expect(stats!.completed_tasks).toBe(1);
      expect(stats!.failed_tasks).toBe(1);
    });
  });

  describe('getTaskHistory', () => {
    it('should return empty array when no tasks exist', () => {
      const tasks = getTaskHistory();
      expect(tasks).toHaveLength(0);
    });

    it('should return tasks with attempt counts', () => {
      const taskId = insertTask({ id: 'th-task-1', title: 'My Task', status: 'running' });
      insertAttempt({ id: 'th-att-1', task_id: taskId, agent_id: 'a1', attempt_number: 1 });
      insertAttempt({ id: 'th-att-2', task_id: taskId, agent_id: 'a1', attempt_number: 2 });

      const tasks = getTaskHistory();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskId);
      expect(tasks[0].title).toBe('My Task');
      expect(tasks[0].attempt_count).toBe(2);
    });

    it('should filter by status', () => {
      insertTask({ id: 'f-t1', status: 'completed' });
      insertTask({ id: 'f-t2', status: 'running' });
      insertTask({ id: 'f-t3', status: 'completed' });

      const completed = getTaskHistory({ status: 'completed' });
      expect(completed).toHaveLength(2);
      completed.forEach((t) => expect(t.status).toBe('completed'));
    });

    it('should filter by agent_id', () => {
      insertTask({ id: 'fa-t1', assigned_agent: 'agent-x' });
      insertTask({ id: 'fa-t2', assigned_agent: 'agent-y' });
      insertTask({ id: 'fa-t3', assigned_agent: 'agent-x' });

      const filtered = getTaskHistory({ agent_id: 'agent-x' });
      expect(filtered).toHaveLength(2);
      filtered.forEach((t) => expect(t.assigned_agent).toBe('agent-x'));
    });

    it('should respect limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        insertTask({ id: `pg-t${i}`, title: `Task ${i}` });
      }

      const page1 = getTaskHistory({ limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);

      const page2 = getTaskHistory({ limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);

      // No overlap
      const page1Ids = page1.map((t) => t.id);
      const page2Ids = page2.map((t) => t.id);
      for (const id of page1Ids) {
        expect(page2Ids).not.toContain(id);
      }
    });
  });

  describe('getCostSummary', () => {
    it('should return zero cost when no llm billing rows exist', () => {
      const summary = getCostSummary('day');
      expect(summary.total_cost).toBe(0);
      expect(summary.by_agent).toHaveLength(0);
      expect(summary.period).toBe('day');
    });

    it('aggregates costs by model from billing_records', () => {
      insertLlmBilling({ model: 'gpt-4.1', cost_usd: 0.2 });
      insertLlmBilling({ model: 'gpt-4.1', cost_usd: 0.3 });
      insertLlmBilling({ model: 'claude-sonnet', cost_usd: 0.5 });

      const summary = getCostSummary('day');
      expect(summary.period).toBe('day');
      expect(summary.total_cost).toBeCloseTo(1.0, 6);
      expect(summary.by_agent).toHaveLength(2);

      const gpt = summary.by_agent.find((a) => a.agent_id === 'gpt-4.1');
      expect(gpt).toBeDefined();
      expect(gpt!.total_cost).toBeCloseTo(0.5, 6);
      expect(gpt!.task_count).toBe(2);
    });

    it('filters by model when requested', () => {
      insertLlmBilling({ model: 'gpt-4.1', cost_usd: 0.2 });
      insertLlmBilling({ model: 'claude-sonnet', cost_usd: 0.5 });
      const summary = getCostSummary('day', 'default', 'gpt-4.1');
      expect(summary.total_cost).toBeCloseTo(0.2, 6);
      expect(summary.by_agent).toHaveLength(1);
      expect(summary.by_agent[0].agent_name).toBe('gpt-4.1');
    });

    it('works with week and month periods', () => {
      insertLlmBilling({ model: 'gpt-4.1', cost_usd: 0.07 });
      const weekSummary = getCostSummary('week');
      expect(weekSummary.period).toBe('week');
      expect(weekSummary.total_cost).toBeCloseTo(0.07, 6);

      const monthSummary = getCostSummary('month');
      expect(monthSummary.period).toBe('month');
      expect(monthSummary.total_cost).toBeCloseTo(0.07, 6);
    });
  });

  describe('listObservedModels', () => {
    it('returns distinct observed models', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO turn_traces (trace_id, tenant_id, turn_id, chat_id, model, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('t1', 'default', 'turn-1', 'chat-1', 'gpt-4.1', 'success', new Date().toISOString());
      db.prepare(`
        INSERT INTO turn_traces (trace_id, tenant_id, turn_id, chat_id, model, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('t2', 'default', 'turn-2', 'chat-2', 'claude-sonnet', 'failed', new Date().toISOString());
      db.prepare(`
        INSERT INTO turn_traces (trace_id, tenant_id, turn_id, chat_id, model, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('t3', 'default', 'turn-3', 'chat-3', 'gpt-4.1', 'success', new Date().toISOString());

      const models = listObservedModels('default');
      expect(models).toEqual(['claude-sonnet', 'gpt-4.1']);
    });
  });

  describe('getSloSummary', () => {
    it('aggregates success/failure metrics and attaches spans', () => {
      const db = getDb();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO turn_traces (
          trace_id, tenant_id, turn_id, chat_id, model, provider, status, failure_category,
          tool_call_count, tool_failure_count, llm_input_tokens, llm_output_tokens, cost_usd, latency_ms, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('trace-1', 'default', 'turn-1', 'chat-1', 'gpt-4.1', 'openai', 'success', null, 2, 0, 100, 50, 0.01, 1200, now, now);

      db.prepare(`
        INSERT INTO turn_traces (
          trace_id, tenant_id, turn_id, chat_id, model, provider, status, failure_category,
          tool_call_count, tool_failure_count, llm_input_tokens, llm_output_tokens, cost_usd, latency_ms, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('trace-2', 'default', 'turn-2', 'chat-2', 'gpt-4.1', 'openai', 'failed', 'timeout', 1, 1, 120, 60, 0.02, 2000, now, now);

      db.prepare(`
        INSERT INTO tool_spans (
          trace_id, tenant_id, turn_id, tool_call_id, tool_name, iteration, status, duration_ms, error_category, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('trace-1', 'default', 'turn-1', 'tc-1', 'web_search', 1, 'success', 220, null, now, now);

      db.prepare(`
        INSERT INTO tool_spans (
          trace_id, tenant_id, turn_id, tool_call_id, tool_name, iteration, status, duration_ms, error_category, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('trace-2', 'default', 'turn-2', 'tc-2', 'read_file', 1, 'error', 140, 'missing_resource', now, now);

      const summary = getSloSummary({ tenant_id: 'default', period: 'day', model: 'gpt-4.1' });
      expect(summary.total_turns).toBe(2);
      expect(summary.successful_turns).toBe(1);
      expect(summary.failed_turns).toBe(1);
      expect(summary.success_rate).toBe(0.5);
      expect(summary.total_cost_usd).toBeCloseTo(0.03, 6);
      expect(summary.avg_latency_ms).toBe(1600);
      expect(summary.failure_breakdown[0].category).toBe('timeout');
      expect(summary.recent_traces).toHaveLength(2);
      expect(summary.recent_traces[0].spans.length).toBeGreaterThan(0);
    });
  });
});
