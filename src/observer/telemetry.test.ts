import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  classifyFailureCategory,
  completeTurnTrace,
  estimateLlmCostUsd,
  recordToolSpan,
  resetTelemetryTableFlag,
  startTurnTrace,
} from './telemetry.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('observer/telemetry', () => {
  it('persists turn traces and tool spans', () => {
    resetTelemetryTableFlag();
    const traceId = `trace-${Date.now()}`;
    startTurnTrace({
      trace_id: traceId,
      turn_id: 'turn-1',
      tenant_id: 'default',
      chat_id: 'chat-1',
      model: 'gpt-4.1',
      provider: 'openai',
    });

    recordToolSpan({
      trace_id: traceId,
      turn_id: 'turn-1',
      tenant_id: 'default',
      tool_call_id: 'tc-1',
      tool_name: 'shell_exec',
      iteration: 1,
      status: 'success',
      duration_ms: 120,
    });

    completeTurnTrace({
      trace_id: traceId,
      tenant_id: 'default',
      status: 'success',
      verify_status: 'passed',
      verify_summary: 'Ran diff review and tests.',
      latency_ms: 400,
      tool_call_count: 1,
      tool_failure_count: 0,
      llm_input_tokens: 100,
      llm_output_tokens: 50,
      cost_usd: 0.002,
    });

    const db = getDb();
    const trace = db.prepare('SELECT * FROM turn_traces WHERE trace_id = ?').get(traceId) as {
      status: string;
      verify_status: string;
      verify_summary: string;
      tool_call_count: number;
      latency_ms: number;
    } | undefined;
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('success');
    expect(trace!.verify_status).toBe('passed');
    expect(trace!.verify_summary).toContain('diff review');
    expect(trace!.tool_call_count).toBe(1);
    expect(trace!.latency_ms).toBe(400);

    const spans = db.prepare('SELECT * FROM tool_spans WHERE trace_id = ?').all(traceId) as Array<{ tool_name: string; duration_ms: number }>;
    expect(spans).toHaveLength(1);
    expect(spans[0].tool_name).toBe('shell_exec');
    expect(spans[0].duration_ms).toBe(120);
  });

  it('estimates LLM cost from provider model metadata', () => {
    const usd = estimateLlmCostUsd('openai', 'gpt-4.1', 1_000_000, 1_000_000);
    expect(usd).toBeCloseTo(10, 6);

    const cachedUsd = estimateLlmCostUsd('deepseek', 'deepseek-v4-pro', 1_000_000, 100_000, 800_000);
    expect(cachedUsd).toBeCloseTo(0.1769, 6);
  });

  it('classifies common failure categories', () => {
    expect(classifyFailureCategory('Command timed out after 60s')).toBe('timeout');
    expect(classifyFailureCategory('Permission denied')).toBe('permission');
    expect(classifyFailureCategory('Rate limit exceeded')).toBe('rate_limit');
    expect(classifyFailureCategory('File not found')).toBe('missing_resource');
  });
});
