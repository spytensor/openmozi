/**
 * Billing Integration — records LLM and tool call usage per tenant.
 *
 * Every LLM call records: {tenant_id, model, input_tokens, output_tokens, cost_usd, timestamp}
 * Every tool call records: {tenant_id, tool, duration_ms, timestamp}
 * Aggregation functions for tenant usage reports.
 */

import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tenants:billing' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmCallRecord {
  tenant_id: string;
  user_id?: string;
  provider?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd: number;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  cache_read_cost_per_million?: number;
  cache_write_cost_per_million?: number;
  pricing_source?: 'catalog_estimate' | 'catalog_calculated' | 'catalog_upper_bound' | 'provider_reported' | 'provider_reconciled' | 'unknown';
  usage_status?: 'provider_reported' | 'legacy_provider_reported' | 'unavailable' | 'legacy_unverified';
  price_version?: string;
  currency?: 'usd';
  outcome?: 'success' | 'failure' | 'partial';
  failure_category?: string;
  duration_ms?: number;
  task_id?: string;
  agent_id?: string;
}

export interface ToolCallRecord {
  tenant_id: string;
  tool: string;
  duration_ms: number;
  task_id?: string;
  agent_id?: string;
}

export interface BillingRecord {
  id: number;
  tenant_id: string;
  record_type: 'llm_call' | 'tool_call';
  user_id: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  cache_read_cost_per_million: number | null;
  cache_write_cost_per_million: number | null;
  pricing_source: string;
  usage_status: string;
  price_version: string | null;
  currency: string;
  outcome: string;
  failure_category: string | null;
  tool: string | null;
  duration_ms: number;
  task_id: string | null;
  agent_id: string | null;
  created_at: string;
}

export interface TenantUsage {
  tenant_id: string;
  period: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  llm_calls: number;
  tool_calls: number;
  cost_by_model: Record<string, number>;
  cost_by_day: Record<string, number>;
}

export interface AllTenantsUsage {
  period: string;
  tenants: Array<{
    tenant_id: string;
    total_tokens: number;
    total_cost_usd: number;
    llm_calls: number;
    tool_calls: number;
  }>;
  totals: {
    total_tokens: number;
    total_cost_usd: number;
    llm_calls: number;
    tool_calls: number;
  };
}

export interface UsageAnalyticsFilters {
  user_id?: string;
  provider?: string;
  model?: string;
  outcome?: 'success' | 'failure' | 'partial';
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface UsageAnalyticsRow {
  id: number;
  created_at: string;
  user_id: string | null;
  user_email: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number;
  pricing_source: string;
  usage_status: string;
  price_version: string | null;
  currency: string;
  outcome: string;
  failure_category: string | null;
  duration_ms: number;
}

export interface UsageAnalytics {
  filters: Required<Pick<UsageAnalyticsFilters, 'from' | 'to' | 'limit' | 'offset'>> & Omit<UsageAnalyticsFilters, 'from' | 'to' | 'limit' | 'offset'>;
  summary: UsageAggregate;
  by_user: Array<UsageAggregate & { user_id: string | null; user_email: string | null }>;
  by_model: Array<UsageAggregate & { provider: string | null; model: string | null }>;
  by_day: Array<UsageAggregate & { day: string }>;
  rows: UsageAnalyticsRow[];
  total: number;
}

export interface UsageAggregate {
  calls: number;
  success_calls: number;
  failed_calls: number;
  partial_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_reported_calls: number;
  cache_write_reported_calls: number;
  usage_reported_calls: number;
  legacy_calls: number;
  priced_calls: number;
  exact_priced_calls: number;
  upper_bound_calls: number;
  measured_latency_calls: number;
  unattributed_calls: number;
  cache_hit_rate: number | null;
  cost_usd: number;
  exact_cost_usd: number;
  upper_bound_cost_usd: number;
  average_latency_ms: number;
}

// ---------------------------------------------------------------------------
// Ensure table exists (migration-safe)
// ---------------------------------------------------------------------------

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      record_type TEXT NOT NULL CHECK(record_type IN ('llm_call', 'tool_call')),
      user_id TEXT,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL DEFAULT 0.0,
      input_cost_per_million REAL,
      output_cost_per_million REAL,
      cache_read_cost_per_million REAL,
      cache_write_cost_per_million REAL,
      pricing_source TEXT NOT NULL DEFAULT 'unknown',
      usage_status TEXT NOT NULL DEFAULT 'legacy_unverified',
      price_version TEXT,
      currency TEXT NOT NULL DEFAULT 'usd',
      outcome TEXT NOT NULL DEFAULT 'success',
      failure_category TEXT,
      tool TEXT,
      duration_ms INTEGER DEFAULT 0,
      task_id TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const columns = new Set((db.prepare('PRAGMA table_info(billing_records)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [column, definition] of [
    ['user_id', 'TEXT'], ['provider', 'TEXT'], ['cache_read_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'],
    ['input_cost_per_million', 'REAL'], ['output_cost_per_million', 'REAL'], ['cache_read_cost_per_million', 'REAL'],
    ['cache_write_cost_per_million', 'REAL'],
    ['pricing_source', "TEXT NOT NULL DEFAULT 'unknown'"], ['usage_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'"],
    ['price_version', 'TEXT'], ['currency', "TEXT NOT NULL DEFAULT 'usd'"],
    ['outcome', "TEXT NOT NULL DEFAULT 'success'"], ['failure_category', 'TEXT'],
  ] as const) {
    if (!columns.has(column)) db.exec(`ALTER TABLE billing_records ADD COLUMN ${column} ${definition}`);
  }
  tableEnsured = true;
}

/** Reset table flag (for testing) */
export function resetTableFlag(): void {
  tableEnsured = false;
}

// ---------------------------------------------------------------------------
// Record functions
// ---------------------------------------------------------------------------

/**
 * Record an LLM call for billing.
 */
export function recordLlmCall(record: LlmCallRecord): { id: number } {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO billing_records (
      tenant_id, record_type, user_id, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd, input_cost_per_million,
      output_cost_per_million, cache_read_cost_per_million, cache_write_cost_per_million, pricing_source,
      usage_status, price_version, currency, outcome, failure_category,
      duration_ms, task_id, agent_id, created_at
    ) VALUES (?, 'llm_call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    record.tenant_id,
    record.user_id ?? null,
    record.provider ?? null,
    record.model,
    record.input_tokens,
    record.output_tokens,
    record.cache_read_tokens ?? null,
    record.cache_write_tokens ?? null,
    record.cost_usd,
    record.input_cost_per_million ?? null,
    record.output_cost_per_million ?? null,
    record.cache_read_cost_per_million ?? null,
    record.cache_write_cost_per_million ?? null,
    record.pricing_source ?? 'unknown',
    record.usage_status ?? 'provider_reported',
    record.price_version ?? null,
    record.currency ?? 'usd',
    record.outcome ?? 'success',
    record.failure_category ?? null,
    record.duration_ms ?? 0,
    record.task_id ?? null,
    record.agent_id ?? null,
  );

  logger.debug({
    tenant_id: record.tenant_id,
    model: record.model,
    provider: record.provider,
    user_id: record.user_id,
    tokens: record.input_tokens + record.output_tokens,
    cache_read_tokens: record.cache_read_tokens,
    cost: record.cost_usd,
    outcome: record.outcome ?? 'success',
  }, 'LLM call recorded');

  return { id: Number(result.lastInsertRowid) };
}

/**
 * Record a tool call for billing.
 */
export function recordToolCall(record: ToolCallRecord): { id: number } {
  ensureTable();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO billing_records (tenant_id, record_type, tool, duration_ms, task_id, agent_id, created_at)
    VALUES (?, 'tool_call', ?, ?, ?, ?, datetime('now'))
  `).run(
    record.tenant_id,
    record.tool,
    record.duration_ms,
    record.task_id ?? null,
    record.agent_id ?? null,
  );

  logger.debug({
    tenant_id: record.tenant_id,
    tool: record.tool,
    duration_ms: record.duration_ms,
  }, 'Tool call recorded');

  return { id: Number(result.lastInsertRowid) };
}

// ---------------------------------------------------------------------------
// Aggregation functions
// ---------------------------------------------------------------------------

/**
 * Get usage summary for a specific tenant within a date range.
 *
 * @param tenantId - Tenant to query
 * @param period   - "daily" | "monthly" | custom date range "YYYY-MM-DD:YYYY-MM-DD"
 */
export function getTenantUsage(tenantId: string, period: string): TenantUsage {
  ensureTable();
  const db = getDb();
  const { fromDate, toDate, periodLabel } = parsePeriod(period);

  // Total tokens and cost
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(CASE WHEN pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN cost_usd ELSE 0 END), 0) as total_cost,
      COUNT(CASE WHEN record_type = 'llm_call' THEN 1 END) as llm_calls,
      COUNT(CASE WHEN record_type = 'tool_call' THEN 1 END) as tool_calls
    FROM billing_records
    WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
  `).get(tenantId, fromDate, toDate) as Record<string, number>;

  // Cost by model
  const modelRows = db.prepare(`
    SELECT model, COALESCE(SUM(CASE WHEN pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN cost_usd ELSE 0 END), 0) as cost
    FROM billing_records
    WHERE tenant_id = ? AND record_type = 'llm_call' AND created_at >= ? AND created_at < ?
    GROUP BY model
  `).all(tenantId, fromDate, toDate) as Array<{ model: string; cost: number }>;

  const costByModel: Record<string, number> = {};
  for (const row of modelRows) {
    if (row.model) costByModel[row.model] = row.cost;
  }

  // Cost by day
  const dayRows = db.prepare(`
    SELECT date(created_at) as day, COALESCE(SUM(CASE WHEN pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN cost_usd ELSE 0 END), 0) as cost
    FROM billing_records
    WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY date(created_at)
    ORDER BY day
  `).all(tenantId, fromDate, toDate) as Array<{ day: string; cost: number }>;

  const costByDay: Record<string, number> = {};
  for (const row of dayRows) {
    costByDay[row.day] = row.cost;
  }

  return {
    tenant_id: tenantId,
    period: periodLabel,
    total_input_tokens: totals.total_input,
    total_output_tokens: totals.total_output,
    total_tokens: totals.total_input + totals.total_output,
    total_cost_usd: totals.total_cost,
    llm_calls: totals.llm_calls,
    tool_calls: totals.tool_calls,
    cost_by_model: costByModel,
    cost_by_day: costByDay,
  };
}

/**
 * Get usage overview for all tenants within a date range.
 */
export function getAllTenantsUsage(period: string): AllTenantsUsage {
  ensureTable();
  const db = getDb();
  const { fromDate, toDate, periodLabel } = parsePeriod(period);

  const rows = db.prepare(`
    SELECT
      tenant_id,
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
      COALESCE(SUM(CASE WHEN pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN cost_usd ELSE 0 END), 0) as total_cost,
      COUNT(CASE WHEN record_type = 'llm_call' THEN 1 END) as llm_calls,
      COUNT(CASE WHEN record_type = 'tool_call' THEN 1 END) as tool_calls
    FROM billing_records
    WHERE created_at >= ? AND created_at < ?
    GROUP BY tenant_id
    ORDER BY total_cost DESC
  `).all(fromDate, toDate) as Array<{
    tenant_id: string;
    total_tokens: number;
    total_cost: number;
    llm_calls: number;
    tool_calls: number;
  }>;

  const tenants = rows.map(r => ({
    tenant_id: r.tenant_id,
    total_tokens: r.total_tokens,
    total_cost_usd: r.total_cost,
    llm_calls: r.llm_calls,
    tool_calls: r.tool_calls,
  }));

  const totalTokens = tenants.reduce((s, t) => s + t.total_tokens, 0);
  const totalCost = tenants.reduce((s, t) => s + t.total_cost_usd, 0);
  const totalLlm = tenants.reduce((s, t) => s + t.llm_calls, 0);
  const totalTool = tenants.reduce((s, t) => s + t.tool_calls, 0);

  return {
    period: periodLabel,
    tenants,
    totals: {
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      llm_calls: totalLlm,
      tool_calls: totalTool,
    },
  };
}

export function getUsageAnalytics(tenantId: string, input: UsageAnalyticsFilters = {}): UsageAnalytics {
  ensureTable();
  const db = getDb();
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(input.from ?? '') ? input.from! : defaultFrom;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input.to ?? '') ? input.to! : today.toISOString().slice(0, 10);
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const conditions = ["b.tenant_id = ?", "b.record_type = 'llm_call'", "date(b.created_at) >= date(?)", "date(b.created_at) <= date(?)"];
  const params: Array<string | number> = [tenantId, from, to];
  for (const [column, value] of [
    ['b.user_id', input.user_id], ['b.provider', input.provider], ['b.model', input.model], ['b.outcome', input.outcome],
  ] as const) {
    if ((column === 'b.user_id' || column === 'b.provider') && value === '__unattributed__') {
      conditions.push(`${column} IS NULL`);
      continue;
    }
    if (value?.trim()) {
      conditions.push(`${column} = ?`);
      params.push(value.trim());
    }
  }
  // Legacy rows were backfilled as `success` without a provider outcome.
  // An outcome filter must not turn that placeholder into verified evidence.
  if (input.outcome?.trim()) conditions.push("b.usage_status = 'provider_reported'");
  const where = conditions.join(' AND ');
  const aggregateSelect = `
    COUNT(*) AS calls,
    SUM(CASE WHEN b.outcome = 'success' AND b.usage_status = 'provider_reported' THEN 1 ELSE 0 END) AS success_calls,
    SUM(CASE WHEN b.outcome = 'failure' THEN 1 ELSE 0 END) AS failed_calls,
    SUM(CASE WHEN b.outcome = 'partial' AND b.usage_status = 'provider_reported' THEN 1 ELSE 0 END) AS partial_calls,
    COALESCE(SUM(b.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(b.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(CASE WHEN b.usage_status IN ('provider_reported', 'legacy_provider_reported') AND b.cache_read_tokens IS NOT NULL THEN b.cache_read_tokens ELSE 0 END), 0) AS cache_read_tokens,
    COALESCE(SUM(CASE WHEN b.usage_status IN ('provider_reported', 'legacy_provider_reported') AND b.cache_write_tokens IS NOT NULL THEN b.cache_write_tokens ELSE 0 END), 0) AS cache_write_tokens,
    SUM(CASE WHEN b.usage_status IN ('provider_reported', 'legacy_provider_reported') AND b.cache_read_tokens IS NOT NULL THEN 1 ELSE 0 END) AS cache_reported_calls,
    SUM(CASE WHEN b.usage_status IN ('provider_reported', 'legacy_provider_reported') AND b.cache_write_tokens IS NOT NULL THEN 1 ELSE 0 END) AS cache_write_reported_calls,
    COALESCE(SUM(CASE WHEN b.usage_status IN ('provider_reported', 'legacy_provider_reported') AND b.cache_read_tokens IS NOT NULL THEN b.input_tokens ELSE 0 END), 0) AS cache_reported_input_tokens,
    SUM(CASE WHEN b.usage_status IN ('provider_reported', 'legacy_provider_reported') THEN 1 ELSE 0 END) AS usage_reported_calls,
    SUM(CASE WHEN b.usage_status IN ('legacy_provider_reported', 'legacy_unverified') THEN 1 ELSE 0 END) AS legacy_calls,
    SUM(CASE WHEN b.pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN 1 ELSE 0 END) AS priced_calls,
    SUM(CASE WHEN b.pricing_source IN ('catalog_estimate', 'catalog_calculated', 'provider_reported', 'provider_reconciled') THEN 1 ELSE 0 END) AS exact_priced_calls,
    SUM(CASE WHEN b.pricing_source = 'catalog_upper_bound' THEN 1 ELSE 0 END) AS upper_bound_calls,
    SUM(CASE WHEN b.usage_status = 'provider_reported' AND b.duration_ms > 0 THEN 1 ELSE 0 END) AS measured_latency_calls,
    SUM(CASE WHEN b.user_id IS NULL OR b.user_id = '' THEN 1 ELSE 0 END) AS unattributed_calls,
    COALESCE(SUM(CASE WHEN b.pricing_source IN ('catalog_estimate', 'catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled') THEN b.cost_usd ELSE 0 END), 0) AS cost_usd,
    COALESCE(SUM(CASE WHEN b.pricing_source IN ('catalog_estimate', 'catalog_calculated', 'provider_reported', 'provider_reconciled') THEN b.cost_usd ELSE 0 END), 0) AS exact_cost_usd,
    COALESCE(SUM(CASE WHEN b.pricing_source = 'catalog_upper_bound' THEN b.cost_usd ELSE 0 END), 0) AS upper_bound_cost_usd,
    COALESCE(AVG(CASE WHEN b.usage_status = 'provider_reported' AND b.duration_ms > 0 THEN b.duration_ms END), 0) AS average_latency_ms`;
  const toAggregate = (row: Record<string, unknown>): UsageAggregate => {
    const inputTokens = Number(row.input_tokens ?? 0);
    const cacheTokens = Number(row.cache_read_tokens ?? 0);
    const reported = Number(row.cache_reported_calls ?? 0);
    const cacheReportedInput = Number(row.cache_reported_input_tokens ?? 0);
    return {
      calls: Number(row.calls ?? 0),
      success_calls: Number(row.success_calls ?? 0),
      failed_calls: Number(row.failed_calls ?? 0),
      partial_calls: Number(row.partial_calls ?? 0),
      input_tokens: inputTokens,
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_tokens: cacheTokens,
      cache_write_tokens: Number(row.cache_write_tokens ?? 0),
      cache_reported_calls: reported,
      cache_write_reported_calls: Number(row.cache_write_reported_calls ?? 0),
      usage_reported_calls: Number(row.usage_reported_calls ?? 0),
      legacy_calls: Number(row.legacy_calls ?? 0),
      priced_calls: Number(row.priced_calls ?? 0),
      exact_priced_calls: Number(row.exact_priced_calls ?? 0),
      upper_bound_calls: Number(row.upper_bound_calls ?? 0),
      measured_latency_calls: Number(row.measured_latency_calls ?? 0),
      unattributed_calls: Number(row.unattributed_calls ?? 0),
      cache_hit_rate: reported > 0 && cacheReportedInput > 0 ? cacheTokens / cacheReportedInput : null,
      cost_usd: Number(row.cost_usd ?? 0),
      exact_cost_usd: Number(row.exact_cost_usd ?? 0),
      upper_bound_cost_usd: Number(row.upper_bound_cost_usd ?? 0),
      average_latency_ms: Number(row.average_latency_ms ?? 0),
    };
  };

  const summaryRow = db.prepare(`SELECT ${aggregateSelect} FROM billing_records b WHERE ${where}`).get(...params) as Record<string, unknown>;
  const userRows = db.prepare(`
    SELECT b.user_id, u.email AS user_email, ${aggregateSelect}
    FROM billing_records b LEFT JOIN users u ON u.tenant_id = b.tenant_id AND u.id = b.user_id
    WHERE ${where}
    GROUP BY b.user_id, u.email ORDER BY cost_usd DESC, calls DESC
  `).all(...params) as Array<Record<string, unknown>>;
  const modelRows = db.prepare(`
    SELECT b.provider, b.model, ${aggregateSelect}
    FROM billing_records b WHERE ${where}
    GROUP BY b.provider, b.model ORDER BY cost_usd DESC, calls DESC
  `).all(...params) as Array<Record<string, unknown>>;
  const dayRows = db.prepare(`
    SELECT date(b.created_at) AS day, ${aggregateSelect}
    FROM billing_records b WHERE ${where}
    GROUP BY date(b.created_at) ORDER BY day ASC
  `).all(...params) as Array<Record<string, unknown>>;
  const count = db.prepare(`SELECT COUNT(*) AS total FROM billing_records b WHERE ${where}`).get(...params) as { total: number };
  const rows = db.prepare(`
    SELECT b.id, b.created_at, b.user_id, u.email AS user_email, b.provider, b.model,
      b.input_tokens, b.output_tokens, b.cache_read_tokens, b.cache_write_tokens, b.cost_usd, b.pricing_source,
      b.usage_status, b.price_version, b.currency, b.outcome, b.failure_category, b.duration_ms
    FROM billing_records b LEFT JOIN users u ON u.tenant_id = b.tenant_id AND u.id = b.user_id
    WHERE ${where} ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as UsageAnalyticsRow[];

  return {
    filters: { ...input, from, to, limit, offset },
    summary: toAggregate(summaryRow),
    by_user: userRows.map(row => ({ user_id: row.user_id as string | null, user_email: row.user_email as string | null, ...toAggregate(row) })),
    by_model: modelRows.map(row => ({ provider: row.provider as string | null, model: row.model as string | null, ...toAggregate(row) })),
    by_day: dayRows.map(row => ({ day: String(row.day), ...toAggregate(row) })),
    rows,
    total: Number(count.total),
  };
}

/**
 * Get total tokens consumed today for a specific tenant.
 * Used by quota enforcement.
 */
export function getDailyTokenCount(tenantId: string): number {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
    FROM billing_records
    WHERE tenant_id = ? AND date(created_at) = date('now')
  `).get(tenantId) as { total: number };
  return row.total;
}

/**
 * Get total tokens consumed this month for a specific tenant.
 * Used by quota enforcement.
 */
export function getMonthlyTokenCount(tenantId: string): number {
  ensureTable();
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
    FROM billing_records
    WHERE tenant_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(tenantId) as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parsePeriod(period: string): { fromDate: string; toDate: string; periodLabel: string } {
  const now = new Date();

  if (period === 'daily') {
    const today = now.toISOString().slice(0, 10);
    return { fromDate: today, toDate: `${today}T23:59:59`, periodLabel: `daily:${today}` };
  }

  if (period === 'monthly') {
    const yearMonth = now.toISOString().slice(0, 7);
    const from = `${yearMonth}-01`;
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const to = nextMonth.toISOString().slice(0, 10);
    return { fromDate: from, toDate: to, periodLabel: `monthly:${yearMonth}` };
  }

  // Custom range: "YYYY-MM-DD:YYYY-MM-DD"
  if (period.includes(':')) {
    const [from, to] = period.split(':');
    return { fromDate: from, toDate: to, periodLabel: period };
  }

  // Default: today
  const today = now.toISOString().slice(0, 10);
  return { fromDate: today, toDate: `${today}T23:59:59`, periodLabel: `daily:${today}` };
}
