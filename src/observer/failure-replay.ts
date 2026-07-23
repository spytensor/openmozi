import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getDb } from '../store/db.js';
import { classifyFailureCategory, type TurnTraceStatus } from './telemetry.js';

export interface ReplayTraceRecord {
  trace_id: string;
  tenant_id: string;
  turn_id: string;
  chat_id: string;
  model: string;
  provider: string | null;
  status: TurnTraceStatus;
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

export interface ReplayToolSpanRecord {
  id: number;
  trace_id: string;
  tenant_id: string;
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  iteration: number;
  status: 'success' | 'error';
  duration_ms: number;
  error_category: string | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface ReplayEventRecord {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  created_at: string;
}

export interface FailureReplayFixture {
  version: 1;
  exported_at: string;
  trace: ReplayTraceRecord;
  tool_spans: ReplayToolSpanRecord[];
  related_events: ReplayEventRecord[];
  expected: {
    status: TurnTraceStatus;
    failure_category: string | null;
    tool_calls: number;
    tool_failures: number;
  };
}

export interface ReplayToolOutcome {
  tool_call_id: string;
  tool_name: string;
  status: 'success' | 'error';
  error_category?: string;
  error_message?: string;
}

export interface ReplayProviderOutcome {
  status: TurnTraceStatus;
  failure_category?: string;
}

export type ReplayToolMock = (
  span: ReplayToolSpanRecord,
  fixture: FailureReplayFixture,
) => ReplayToolOutcome | Promise<ReplayToolOutcome>;

export type ReplayProviderMock = (
  fixture: FailureReplayFixture,
  toolOutcomes: ReplayToolOutcome[],
) => ReplayProviderOutcome | Promise<ReplayProviderOutcome>;

export interface RunFailureReplayOptions {
  toolMock?: ReplayToolMock;
  providerMock?: ReplayProviderMock;
}

export interface FailureReplayResult {
  passed: boolean;
  mismatches: string[];
  expected: FailureReplayFixture['expected'];
  observed: {
    status: TurnTraceStatus;
    failure_category: string | null;
    tool_calls: number;
    tool_failures: number;
  };
  tool_outcomes: ReplayToolOutcome[];
}

export interface GenerateFailureReplayArtifactsOptions {
  tenantId?: string;
  outputDir?: string;
}

export interface FailureReplayArtifacts {
  fixture: FailureReplayFixture;
  fixturePath: string;
  testPath: string;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function inferFailureCategoryFromSpans(spans: ReplayToolSpanRecord[]): string | null {
  const firstError = spans.find((span) => span.status === 'error');
  if (!firstError) return null;
  if (firstError.error_category && firstError.error_category.trim().length > 0) {
    return firstError.error_category.trim();
  }
  if (firstError.error_message && firstError.error_message.trim().length > 0) {
    return classifyFailureCategory(firstError.error_message);
  }
  return 'tool_error';
}

function inferFailureCategoryFromOutcomes(outcomes: ReplayToolOutcome[]): string | null {
  const firstError = outcomes.find((outcome) => outcome.status === 'error');
  if (!firstError) return null;
  if (firstError.error_category && firstError.error_category.trim().length > 0) {
    return firstError.error_category.trim();
  }
  if (firstError.error_message && firstError.error_message.trim().length > 0) {
    return classifyFailureCategory(firstError.error_message);
  }
  return 'tool_error';
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function exportFailureReplayFixture(traceId: string, tenantId = 'default'): FailureReplayFixture | null {
  const db = getDb();

  const traceRow = db.prepare(`
    SELECT
      trace_id,
      tenant_id,
      turn_id,
      chat_id,
      model,
      provider,
      status,
      failure_category,
      tool_call_count,
      tool_failure_count,
      llm_input_tokens,
      llm_output_tokens,
      cost_usd,
      latency_ms,
      started_at,
      ended_at
    FROM turn_traces
    WHERE trace_id = ? AND tenant_id = ?
  `).get(traceId, tenantId) as ReplayTraceRecord | undefined;

  if (!traceRow) return null;

  const spans = db.prepare(`
    SELECT
      id,
      trace_id,
      tenant_id,
      turn_id,
      tool_call_id,
      tool_name,
      iteration,
      status,
      duration_ms,
      error_category,
      error_message,
      started_at,
      ended_at
    FROM tool_spans
    WHERE trace_id = ? AND tenant_id = ?
    ORDER BY iteration ASC, id ASC
  `).all(traceId, tenantId) as ReplayToolSpanRecord[];

  const eventRows = db.prepare(`
    SELECT id, event_type, entity_type, entity_id, payload, created_at
    FROM event_log
    WHERE tenant_id = ?
      AND (
        entity_id = ?
        OR entity_id = ?
        OR payload LIKE ?
      )
    ORDER BY created_at ASC, id ASC
    LIMIT 500
  `).all(tenantId, traceRow.turn_id, traceRow.trace_id, `%${traceId}%`) as Array<{
    id: number;
    event_type: string;
    entity_type: string;
    entity_id: string;
    payload: string;
    created_at: string;
  }>;

  const relatedEvents: ReplayEventRecord[] = eventRows.map((row) => ({
    id: row.id,
    event_type: row.event_type,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    payload: parsePayload(row.payload),
    created_at: row.created_at,
  }));

  const inferredFailureCategory = traceRow.failure_category ?? inferFailureCategoryFromSpans(spans);

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    trace: {
      ...traceRow,
      tool_call_count: Number(traceRow.tool_call_count ?? 0),
      tool_failure_count: Number(traceRow.tool_failure_count ?? 0),
      llm_input_tokens: Number(traceRow.llm_input_tokens ?? 0),
      llm_output_tokens: Number(traceRow.llm_output_tokens ?? 0),
      cost_usd: Number(traceRow.cost_usd ?? 0),
      latency_ms: Number(traceRow.latency_ms ?? 0),
    },
    tool_spans: spans,
    related_events: relatedEvents,
    expected: {
      status: traceRow.status,
      failure_category: traceRow.status === 'success' ? null : inferredFailureCategory,
      tool_calls: Number(traceRow.tool_call_count ?? spans.length),
      tool_failures: Number(traceRow.tool_failure_count ?? spans.filter((span) => span.status === 'error').length),
    },
  };
}

function defaultToolMock(span: ReplayToolSpanRecord): ReplayToolOutcome {
  return {
    tool_call_id: span.tool_call_id,
    tool_name: span.tool_name,
    status: span.status,
    error_category: span.error_category ?? undefined,
    error_message: span.error_message ?? undefined,
  };
}

function defaultProviderMock(fixture: FailureReplayFixture): ReplayProviderOutcome {
  return {
    status: fixture.trace.status,
    failure_category: fixture.expected.failure_category ?? undefined,
  };
}

export async function runFailureReplay(
  fixture: FailureReplayFixture,
  options: RunFailureReplayOptions = {},
): Promise<FailureReplayResult> {
  const toolMock = options.toolMock ?? defaultToolMock;
  const providerMock = options.providerMock ?? defaultProviderMock;

  const toolOutcomes: ReplayToolOutcome[] = [];
  for (const span of fixture.tool_spans) {
    const outcome = await Promise.resolve(toolMock(span, fixture));
    toolOutcomes.push(outcome);
  }

  const providerOutcome = await Promise.resolve(providerMock(fixture, toolOutcomes));

  const observedStatus = providerOutcome.status;
  const observedFailureCategory = observedStatus === 'success'
    ? null
    : providerOutcome.failure_category
      ?? inferFailureCategoryFromOutcomes(toolOutcomes)
      ?? 'unknown';
  const observedToolCalls = toolOutcomes.length;
  const observedToolFailures = toolOutcomes.filter((outcome) => outcome.status === 'error').length;

  const mismatches: string[] = [];

  if (observedStatus !== fixture.expected.status) {
    mismatches.push(`status mismatch: expected ${fixture.expected.status}, got ${observedStatus}`);
  }

  if ((fixture.expected.failure_category ?? null) !== (observedFailureCategory ?? null)) {
    mismatches.push(
      `failure_category mismatch: expected ${fixture.expected.failure_category ?? 'null'}, got ${observedFailureCategory ?? 'null'}`,
    );
  }

  if (observedToolCalls !== fixture.expected.tool_calls) {
    mismatches.push(`tool_calls mismatch: expected ${fixture.expected.tool_calls}, got ${observedToolCalls}`);
  }

  if (observedToolFailures !== fixture.expected.tool_failures) {
    mismatches.push(`tool_failures mismatch: expected ${fixture.expected.tool_failures}, got ${observedToolFailures}`);
  }

  return {
    passed: mismatches.length === 0,
    mismatches,
    expected: fixture.expected,
    observed: {
      status: observedStatus,
      failure_category: observedFailureCategory,
      tool_calls: observedToolCalls,
      tool_failures: observedToolFailures,
    },
    tool_outcomes: toolOutcomes,
  };
}

export function buildFailureReplayTestSkeleton(
  fixtureFileName: string,
  traceId: string,
): string {
  const fixtureBase = basename(fixtureFileName);
  return `import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runFailureReplay, type FailureReplayFixture } from '../../../src/observer/failure-replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('failure replay ${traceId}', () => {
  it('reconstructs the expected failure path', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '${fixtureBase}'), 'utf-8'),
    ) as FailureReplayFixture;

    const result = await runFailureReplay(fixture);
    expect(result.passed).toBe(true);
  });
});
`;
}

export function generateFailureReplayArtifacts(
  traceId: string,
  options: GenerateFailureReplayArtifactsOptions = {},
): FailureReplayArtifacts | null {
  const tenantId = options.tenantId ?? 'default';
  const fixture = exportFailureReplayFixture(traceId, tenantId);
  if (!fixture) return null;

  const outputDir = resolve(options.outputDir ?? 'tests/integration/replay');
  mkdirSync(outputDir, { recursive: true });

  const stem = sanitizeFileStem(traceId);
  const fixtureFileName = `${stem}.fixture.json`;
  const testFileName = `${stem}.replay.integration.test.ts`;
  const fixturePath = join(outputDir, fixtureFileName);
  const testPath = join(outputDir, testFileName);

  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
  writeFileSync(testPath, buildFailureReplayTestSkeleton(fixtureFileName, traceId), 'utf-8');

  return {
    fixture,
    fixturePath,
    testPath,
  };
}
