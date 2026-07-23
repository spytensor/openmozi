/**
 * Telemetry Trace Store — turn-level traces and tool-level spans.
 *
 * This module is intentionally lightweight and SQLite-native so it can be
 * written from hot paths (gateway/tool loop) without introducing extra infra.
 */

import pino from 'pino';
import { resolveRuntimeModel } from '../core/providers.js';
import { getDb } from '../store/db.js';

const logger = pino({ name: 'mozi:observer:telemetry' });

export type TurnTraceStatus = 'success' | 'failed' | 'timeout' | 'cancelled';
export type ToolSpanStatus = 'success' | 'error';
export type TurnTraceVerifyStatus = 'not_required' | 'pending' | 'passed' | 'failed';

export interface StartTurnTraceInput {
  trace_id: string;
  turn_id: string;
  tenant_id: string;
  chat_id: string;
  model: string;
  provider?: string;
  prompt_cache_key?: string;
  stable_prefix_hash?: string;
  cache_profile?: string;
  started_at?: string;
}

export interface CompleteTurnTraceInput {
  trace_id: string;
  tenant_id: string;
  status: TurnTraceStatus;
  verify_status?: TurnTraceVerifyStatus;
  verify_summary?: string;
  ended_at?: string;
  latency_ms: number;
  failure_category?: string;
  tool_call_count?: number;
  tool_failure_count?: number;
  llm_input_tokens?: number;
  llm_output_tokens?: number;
  /** Prompt tokens the provider served from its cache across the turn's LLM calls. */
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

export interface ToolSpanInput {
  trace_id: string;
  turn_id: string;
  tenant_id: string;
  tool_call_id: string;
  tool_name: string;
  iteration: number;
  status: ToolSpanStatus;
  duration_ms: number;
  started_at?: string;
  ended_at?: string;
  error_category?: string;
  error_message?: string;
}

let tablesEnsured = false;

function ensureTables(): void {
  if (tablesEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_traces (
      trace_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      turn_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL DEFAULT 'failed' CHECK(status IN ('success', 'failed', 'timeout', 'cancelled')),
      verify_status TEXT NOT NULL DEFAULT 'not_required' CHECK(verify_status IN ('not_required', 'pending', 'passed', 'failed')),
      verify_summary TEXT NOT NULL DEFAULT '',
      failure_category TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_failure_count INTEGER NOT NULL DEFAULT 0,
      llm_input_tokens INTEGER NOT NULL DEFAULT 0,
      llm_output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_cache_key TEXT,
      stable_prefix_hash TEXT,
      cache_profile TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_started
      ON turn_traces(tenant_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_model_started
      ON turn_traces(tenant_id, model, started_at DESC);

    CREATE TABLE IF NOT EXISTS tool_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('success', 'error')),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_category TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY(trace_id) REFERENCES turn_traces(trace_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tool_spans_trace
      ON tool_spans(trace_id, started_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tool_spans_tenant_started
      ON tool_spans(tenant_id, started_at DESC);
  `);

  // Additive migration for DBs created before cache telemetry existed.
  const columns = db.prepare('PRAGMA table_info(turn_traces)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'cache_read_tokens')) {
    db.exec('ALTER TABLE turn_traces ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(column => column.name === 'cache_write_tokens')) {
    db.exec('ALTER TABLE turn_traces ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(column => column.name === 'prompt_cache_key')) {
    db.exec('ALTER TABLE turn_traces ADD COLUMN prompt_cache_key TEXT');
  }
  if (!columns.some(column => column.name === 'stable_prefix_hash')) {
    db.exec('ALTER TABLE turn_traces ADD COLUMN stable_prefix_hash TEXT');
  }
  if (!columns.some(column => column.name === 'cache_profile')) {
    db.exec('ALTER TABLE turn_traces ADD COLUMN cache_profile TEXT');
  }

  tablesEnsured = true;
}

export function resetTelemetryTableFlag(): void {
  tablesEnsured = false;
}

export function startTurnTrace(input: StartTurnTraceInput): void {
  ensureTables();
  const db = getDb();
  const startedAt = input.started_at ?? new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO turn_traces (
      trace_id, tenant_id, turn_id, chat_id, model, provider,
      prompt_cache_key, stable_prefix_hash, cache_profile, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)
  `).run(
    input.trace_id,
    input.tenant_id,
    input.turn_id,
    input.chat_id,
    input.model,
    input.provider ?? null,
    input.prompt_cache_key ?? null,
    input.stable_prefix_hash ?? null,
    input.cache_profile ?? null,
    startedAt,
  );
}

export function completeTurnTrace(input: CompleteTurnTraceInput): void {
  ensureTables();
  const db = getDb();
  const endedAt = input.ended_at ?? new Date().toISOString();
  db.prepare(`
    UPDATE turn_traces
    SET status = ?,
        verify_status = ?,
        verify_summary = ?,
        failure_category = ?,
        tool_call_count = ?,
        tool_failure_count = ?,
        llm_input_tokens = ?,
        llm_output_tokens = ?,
        cache_read_tokens = ?,
        cache_write_tokens = ?,
        cost_usd = ?,
        latency_ms = ?,
        ended_at = ?
    WHERE trace_id = ? AND tenant_id = ?
  `).run(
    input.status,
    input.verify_status ?? 'not_required',
    input.verify_summary ?? '',
    input.failure_category ?? null,
    input.tool_call_count ?? 0,
    input.tool_failure_count ?? 0,
    input.llm_input_tokens ?? 0,
    input.llm_output_tokens ?? 0,
    input.cache_read_tokens ?? 0,
    input.cache_write_tokens ?? 0,
    input.cost_usd ?? 0,
    Math.max(0, Math.round(input.latency_ms)),
    endedAt,
    input.trace_id,
    input.tenant_id,
  );
}

export function recordToolSpan(input: ToolSpanInput): void {
  ensureTables();
  const db = getDb();
  const startedAt = input.started_at ?? new Date().toISOString();
  const endedAt = input.ended_at ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO tool_spans (
      trace_id, tenant_id, turn_id, tool_call_id, tool_name, iteration,
      status, duration_ms, error_category, error_message, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.trace_id,
    input.tenant_id,
    input.turn_id,
    input.tool_call_id,
    input.tool_name,
    input.iteration,
    input.status,
    Math.max(0, Math.round(input.duration_ms)),
    input.error_category ?? null,
    input.error_message ?? null,
    startedAt,
    endedAt,
  );
}

/** Count recorded spans for a trace — used to fill turn-level tool counters at completion. */
export function getTraceToolCounts(traceId: string, tenantId = 'default'): { total: number; failures: number } {
  ensureTables();
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failures
    FROM tool_spans
    WHERE trace_id = ? AND tenant_id = ?
  `).get(traceId, tenantId) as { total: number; failures: number | null } | undefined;
  return { total: row?.total ?? 0, failures: row?.failures ?? 0 };
}

export function estimateLlmCostUsd(
  provider: string | undefined,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  if (!provider || !model) return 0;
  const modelDef = resolveRuntimeModel(provider, model, { allowUnknown: true });
  if (!modelDef) return 0;

  const inputCost = modelDef.inputCostPer1M ?? 0;
  const outputCost = modelDef.outputCostPer1M ?? 0;
  const cacheReadCost = modelDef.cacheReadCostPer1M;
  const cacheWriteCost = modelDef.cacheWriteCostPer1M;
  if (inputCost <= 0 && outputCost <= 0) return 0;
  if (cacheReadTokens > 0 && cacheReadCost === undefined) return 0;
  if (cacheWriteTokens > 0 && cacheWriteCost === undefined) return 0;

  const boundedCacheReadTokens = Math.max(0, Math.min(inputTokens, cacheReadTokens));
  const boundedCacheWriteTokens = Math.max(0, Math.min(inputTokens - boundedCacheReadTokens, cacheWriteTokens));
  const uncachedInputTokens = Math.max(0, inputTokens - boundedCacheReadTokens - boundedCacheWriteTokens);
  const usd = (uncachedInputTokens / 1_000_000) * inputCost
    + (boundedCacheReadTokens / 1_000_000) * (cacheReadCost ?? inputCost)
    + (boundedCacheWriteTokens / 1_000_000) * (cacheWriteCost ?? inputCost)
    + (Math.max(0, outputTokens) / 1_000_000) * outputCost;
  return Number(usd.toFixed(8));
}

/**
 * Coarse error bucket for SLO rollups.
 */
export function classifyFailureCategory(raw: string | undefined): string {
  const msg = (raw ?? '').toLowerCase();

  if (!msg) return 'unknown';
  if (/timeout|timed out|abort|deadline/.test(msg)) return 'timeout';
  if (/rate limit|too many requests|429/.test(msg)) return 'rate_limit';
  if (/permission|forbidden|denied|unauthorized|approval/.test(msg)) return 'permission';
  if (/context|token|prompt.*length|max.*token|too long/.test(msg)) return 'context_overflow';
  if (/network|econn|enotfound|socket|dns|connection/.test(msg)) return 'network';
  if (/not found|enoent|missing/.test(msg)) return 'missing_resource';
  if (/invalid|required|schema|parse|json/.test(msg)) return 'validation';
  return 'tool_error';
}

export function safeRecordToolSpan(input: ToolSpanInput): void {
  try {
    recordToolSpan(input);
  } catch (err) {
    logger.warn({
      trace_id: input.trace_id,
      tool_call_id: input.tool_call_id,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist tool span');
  }
}
