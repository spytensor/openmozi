/**
 * Dashboard Data Queries — provides aggregated views of system state,
 * agent statistics, task history, and cost summaries.
 */

import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:observer:dashboard' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemOverview {
  active_agents: number;
  running_tasks: number;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  total_token_usage: number;
  agent_types: { preset: number; dynamic: number };
}

export interface AgentStats {
  id: string;
  name: string;
  type: string;
  status: string;
  evolution_score: number;
  success_rate: number;
  avg_token_cost: number;
  spawn_count: number;
  task_history: TaskAttemptRecord[];
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
}

export interface TaskAttemptRecord {
  id: string;
  task_id: string;
  agent_id: string;
  attempt_number: number;
  started_at: string;
  ended_at: string | null;
  result_status: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: string;
  assigned_agent: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
  attempt_count: number;
}

export interface CostSummary {
  total_cost: number;
  by_agent: AgentCostBreakdown[];
  period: string;
  start_date: string;
  end_date: string;
}

export interface AgentCostBreakdown {
  agent_id: string;
  agent_name: string;
  total_cost: number;
  task_count: number;
}

export interface ToolSpanSummary {
  tool_call_id: string;
  tool_name: string;
  iteration: number;
  status: 'success' | 'error';
  duration_ms: number;
  error_category: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface RecentTraceSummary {
  trace_id: string;
  turn_id: string;
  chat_id: string;
  model: string;
  provider: string | null;
  status: string;
  failure_category: string | null;
  tool_call_count: number;
  tool_failure_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  started_at: string;
  ended_at: string | null;
  spans: ToolSpanSummary[];
}

export interface SloDashboardSummary {
  period: 'day' | 'week' | 'month';
  tenant_id: string;
  model: string | null;
  start_date: string;
  end_date: string;
  total_turns: number;
  successful_turns: number;
  failed_turns: number;
  success_rate: number;
  avg_latency_ms: number;
  avg_tool_span_ms: number;
  total_cost_usd: number;
  failure_breakdown: Array<{ category: string; count: number }>;
  recent_traces: RecentTraceSummary[];
}

// ---------------------------------------------------------------------------
// DB row helpers
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  status: string;
  spawn_count: number;
  success_rate: number;
  avg_token_cost: number;
  evolution_score: number;
  created_at: string;
  updated_at: string;
}

interface TaskAttemptRow {
  id: string;
  task_id: string;
  agent_id: string;
  attempt_number: number;
  started_at: string;
  ended_at: string | null;
  result_status: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  assigned_agent: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface RecentTraceRow {
  trace_id: string;
  turn_id: string;
  chat_id: string;
  model: string;
  provider: string | null;
  status: string;
  failure_category: string | null;
  tool_call_count: number;
  tool_failure_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  started_at: string;
  ended_at: string | null;
}

interface ToolSpanRow {
  trace_id: string;
  tool_call_id: string;
  tool_name: string;
  iteration: number;
  status: 'success' | 'error';
  duration_ms: number;
  error_category: string | null;
  started_at: string;
  ended_at: string | null;
}

function resolvePeriodWindow(period: 'day' | 'week' | 'month'): { start: string; end: string } {
  const now = new Date();
  let startDate: Date;
  switch (period) {
    case 'day':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
  }
  return { start: startDate.toISOString(), end: now.toISOString() };
}

function ensureBillingTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      record_type TEXT NOT NULL CHECK(record_type IN ('llm_call', 'tool_call')),
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0.0,
      tool TEXT,
      duration_ms INTEGER DEFAULT 0,
      task_id TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a high-level system overview with counts and token usage.
 */
export function getSystemOverview(tenantId = 'default'): SystemOverview {
  const db = getDb();

  const agentCounts = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active') AS active_agents,
      COUNT(*) FILTER (WHERE type = 'preset') AS preset_count,
      COUNT(*) FILTER (WHERE type = 'dynamic') AS dynamic_count,
      COALESCE(SUM(avg_token_cost * spawn_count), 0) AS total_token_usage
    FROM agent_registry
    WHERE tenant_id = ?
  `).get(tenantId) as { active_agents: number; preset_count: number; dynamic_count: number; total_token_usage: number } | undefined;

  const taskCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_tasks,
      COUNT(*) FILTER (WHERE status = 'running') AS running_tasks,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_tasks,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_tasks
    FROM tasks
    WHERE tenant_id = ?
  `).get(tenantId) as { total_tasks: number; running_tasks: number; completed_tasks: number; failed_tasks: number } | undefined;

  return {
    active_agents: agentCounts?.active_agents ?? 0,
    running_tasks: taskCounts?.running_tasks ?? 0,
    total_tasks: taskCounts?.total_tasks ?? 0,
    completed_tasks: taskCounts?.completed_tasks ?? 0,
    failed_tasks: taskCounts?.failed_tasks ?? 0,
    total_token_usage: agentCounts?.total_token_usage ?? 0,
    agent_types: {
      preset: agentCounts?.preset_count ?? 0,
      dynamic: agentCounts?.dynamic_count ?? 0,
    },
  };
}

/**
 * Get detailed stats for a specific agent.
 */
export function getAgentStats(agentId: string, tenantId = 'default'): AgentStats | null {
  const db = getDb();

  const agent = db.prepare(`
    SELECT * FROM agent_registry WHERE id = ? AND tenant_id = ?
  `).get(agentId, tenantId) as AgentRow | undefined;

  if (!agent) return null;

  const attempts = db.prepare(`
    SELECT id, task_id, agent_id, attempt_number, started_at, ended_at, result_status
    FROM task_attempts
    WHERE agent_id = ? AND tenant_id = ?
    ORDER BY started_at DESC
    LIMIT 50
  `).all(agentId, tenantId) as TaskAttemptRow[];

  const taskStats = db.prepare(`
    SELECT
      COUNT(DISTINCT task_id) AS total_tasks,
      COUNT(DISTINCT task_id) FILTER (WHERE result_status = 'completed') AS completed_tasks,
      COUNT(DISTINCT task_id) FILTER (WHERE result_status = 'failed') AS failed_tasks
    FROM task_attempts
    WHERE agent_id = ? AND tenant_id = ?
  `).get(agentId, tenantId) as { total_tasks: number; completed_tasks: number; failed_tasks: number } | undefined;

  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    status: agent.status,
    evolution_score: agent.evolution_score,
    success_rate: agent.success_rate,
    avg_token_cost: agent.avg_token_cost,
    spawn_count: agent.spawn_count,
    task_history: attempts.map((a) => ({
      id: a.id,
      task_id: a.task_id,
      agent_id: a.agent_id,
      attempt_number: a.attempt_number,
      started_at: a.started_at,
      ended_at: a.ended_at,
      result_status: a.result_status,
    })),
    total_tasks: taskStats?.total_tasks ?? 0,
    completed_tasks: taskStats?.completed_tasks ?? 0,
    failed_tasks: taskStats?.failed_tasks ?? 0,
  };
}

/**
 * Get paginated task history with optional filters.
 */
export function getTaskHistory(filters?: {
  status?: string;
  agent_id?: string;
  limit?: number;
  offset?: number;
  tenant_id?: string;
}): TaskRecord[] {
  const db = getDb();
  const tenantId = filters?.tenant_id ?? 'default';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const conditions: string[] = ['t.tenant_id = ?'];
  const params: (string | number)[] = [tenantId];

  if (filters?.status) {
    conditions.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters?.agent_id) {
    conditions.push('t.assigned_agent = ?');
    params.push(filters.agent_id);
  }

  const where = conditions.join(' AND ');
  params.push(limit, offset);

  const rows = db.prepare(`
    SELECT
      t.id, t.title, t.status, t.assigned_agent, t.priority, t.created_at, t.updated_at,
      (SELECT COUNT(*) FROM task_attempts ta WHERE ta.task_id = t.id AND ta.tenant_id = t.tenant_id) AS attempt_count
    FROM tasks t
    WHERE ${where}
    ORDER BY t.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params) as Array<TaskRow & { attempt_count: number }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    assigned_agent: row.assigned_agent,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attempt_count: row.attempt_count,
  }));
}

/**
 * Get cost summary broken down by model for a given period.
 */
export function getCostSummary(
  period: 'day' | 'week' | 'month',
  tenantId = 'default',
  model?: string,
): CostSummary {
  const db = getDb();
  ensureBillingTable(db);
  const window = resolvePeriodWindow(period);
  const params: Array<string | number> = [tenantId, window.start, window.end];
  const modelFilter = model?.trim();
  let modelClause = '';
  if (modelFilter) {
    modelClause = ' AND model = ?';
    params.push(modelFilter);
  }

  const rows = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') AS model_name,
      COALESCE(SUM(CASE WHEN pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN cost_usd ELSE 0 END), 0) AS total_cost,
      COUNT(*) AS task_count
    FROM billing_records
    WHERE tenant_id = ? AND record_type = 'llm_call'
      AND julianday(created_at) >= julianday(?)
      AND julianday(created_at) <= julianday(?)${modelClause}
    GROUP BY model_name
    ORDER BY total_cost DESC
  `).all(...params) as Array<{ model_name: string; total_cost: number; task_count: number }>;

  const byAgent: AgentCostBreakdown[] = rows.map((row) => ({
    agent_id: row.model_name,
    agent_name: row.model_name,
    total_cost: row.total_cost,
    task_count: row.task_count,
  }));

  const totalCost = byAgent.reduce((sum, row) => sum + row.total_cost, 0);

  return {
    total_cost: totalCost,
    by_agent: byAgent,
    period,
    start_date: window.start,
    end_date: window.end,
  };
}

/**
 * List observed models in turn traces for dashboard filters.
 */
export function listObservedModels(tenantId = 'default'): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT model
    FROM turn_traces
    WHERE tenant_id = ? AND model IS NOT NULL AND model != ''
    ORDER BY model ASC
  `).all(tenantId) as Array<{ model: string }>;
  return rows.map(row => row.model);
}

/**
 * SLO-focused dashboard rollup with recent traces and tool spans.
 */
export function getSloSummary(filters?: {
  tenant_id?: string;
  model?: string;
  period?: 'day' | 'week' | 'month';
  limit?: number;
}): SloDashboardSummary {
  const db = getDb();
  const tenantId = filters?.tenant_id ?? 'default';
  const period = filters?.period ?? 'day';
  const limit = Math.max(1, Math.min(filters?.limit ?? 20, 100));
  const model = filters?.model?.trim() || null;
  const window = resolvePeriodWindow(period);

  const whereConditions = [
    'tenant_id = ?',
    'julianday(started_at) >= julianday(?)',
    'julianday(started_at) <= julianday(?)',
  ];
  const params: Array<string | number> = [tenantId, window.start, window.end];
  if (model) {
    whereConditions.push('model = ?');
    params.push(model);
  }
  const where = whereConditions.join(' AND ');

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_turns,
      COUNT(*) FILTER (WHERE status = 'success') AS successful_turns,
      COUNT(*) FILTER (WHERE status != 'success') AS failed_turns,
      COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd
    FROM turn_traces
    WHERE ${where}
  `).get(...params) as {
    total_turns: number;
    successful_turns: number;
    failed_turns: number;
    avg_latency_ms: number;
    total_cost_usd: number;
  };

  const failureBreakdown = db.prepare(`
    SELECT COALESCE(failure_category, 'unknown') AS category, COUNT(*) AS count
    FROM turn_traces
    WHERE ${where} AND status != 'success'
    GROUP BY category
    ORDER BY count DESC
  `).all(...params) as Array<{ category: string; count: number }>;

  const traceRows = db.prepare(`
    SELECT
      trace_id, turn_id, chat_id, model, provider, status, failure_category,
      tool_call_count, tool_failure_count, llm_input_tokens, llm_output_tokens,
      cost_usd, latency_ms, started_at, ended_at
    FROM turn_traces
    WHERE ${where}
    ORDER BY started_at DESC
    LIMIT ?
  `).all(...params, limit) as RecentTraceRow[];

  const traceIds = traceRows.map(row => row.trace_id);
  const spansByTrace = new Map<string, ToolSpanSummary[]>();
  if (traceIds.length > 0) {
    const placeholders = traceIds.map(() => '?').join(',');
    const spanRows = db.prepare(`
      SELECT trace_id, tool_call_id, tool_name, iteration, status, duration_ms, error_category, started_at, ended_at
      FROM tool_spans
      WHERE tenant_id = ? AND trace_id IN (${placeholders})
      ORDER BY started_at ASC
    `).all(tenantId, ...traceIds) as ToolSpanRow[];
    for (const row of spanRows) {
      const existing = spansByTrace.get(row.trace_id) ?? [];
      existing.push({
        tool_call_id: row.tool_call_id,
        tool_name: row.tool_name,
        iteration: row.iteration,
        status: row.status,
        duration_ms: row.duration_ms,
        error_category: row.error_category,
        started_at: row.started_at,
        ended_at: row.ended_at,
      });
      spansByTrace.set(row.trace_id, existing);
    }
  }

  const recentTraces: RecentTraceSummary[] = traceRows.map(row => ({
    trace_id: row.trace_id,
    turn_id: row.turn_id,
    chat_id: row.chat_id,
    model: row.model,
    provider: row.provider,
    status: row.status,
    failure_category: row.failure_category,
    tool_call_count: row.tool_call_count,
    tool_failure_count: row.tool_failure_count,
    llm_input_tokens: row.llm_input_tokens,
    llm_output_tokens: row.llm_output_tokens,
    cost_usd: row.cost_usd,
    latency_ms: row.latency_ms,
    started_at: row.started_at,
    ended_at: row.ended_at,
    spans: spansByTrace.get(row.trace_id) ?? [],
  }));

  const spanAgg = db.prepare(`
    SELECT COALESCE(AVG(duration_ms), 0) AS avg_tool_span_ms
    FROM tool_spans
    WHERE tenant_id = ? AND trace_id IN (
      SELECT trace_id FROM turn_traces WHERE ${where}
    )
  `).get(tenantId, ...params) as { avg_tool_span_ms: number } | undefined;

  const totalTurns = totals.total_turns ?? 0;
  const successfulTurns = totals.successful_turns ?? 0;
  const successRate = totalTurns > 0 ? successfulTurns / totalTurns : 0;

  return {
    period,
    tenant_id: tenantId,
    model,
    start_date: window.start,
    end_date: window.end,
    total_turns: totalTurns,
    successful_turns: successfulTurns,
    failed_turns: totals.failed_turns ?? 0,
    success_rate: successRate,
    avg_latency_ms: Math.round(totals.avg_latency_ms ?? 0),
    avg_tool_span_ms: Math.round(spanAgg?.avg_tool_span_ms ?? 0),
    total_cost_usd: totals.total_cost_usd ?? 0,
    failure_breakdown: failureBreakdown,
    recent_traces: recentTraces,
  };
}
