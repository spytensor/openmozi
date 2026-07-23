import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import { log as logEvent } from '../store/events.js';
import {
  completeTurnTrace,
  recordToolSpan,
  resetTelemetryTableFlag,
  startTurnTrace,
} from './telemetry.js';
import {
  exportFailureReplayFixture,
  generateFailureReplayArtifacts,
  runFailureReplay,
} from './failure-replay.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('observer/failure-replay', () => {
  const traceId = 'trace-replay-1';

  it('exports replay fixture by trace_id', () => {
    resetTelemetryTableFlag();

    startTurnTrace({
      trace_id: traceId,
      turn_id: 'turn-replay-1',
      tenant_id: 'default',
      chat_id: 'chat-replay-1',
      model: 'gpt-4.1-mini',
      provider: 'openai',
    });

    recordToolSpan({
      trace_id: traceId,
      turn_id: 'turn-replay-1',
      tenant_id: 'default',
      tool_call_id: 'tool-1',
      tool_name: 'shell_exec',
      iteration: 1,
      status: 'error',
      duration_ms: 120,
      error_category: 'tool_protocol',
      error_message: 'Tool results are missing',
    });

    completeTurnTrace({
      trace_id: traceId,
      tenant_id: 'default',
      status: 'failed',
      failure_category: 'tool_protocol',
      tool_call_count: 1,
      tool_failure_count: 1,
      llm_input_tokens: 123,
      llm_output_tokens: 45,
      cost_usd: 0.0123,
      latency_ms: 456,
    });

    logEvent('turn_failed', 'turn', 'turn-replay-1', { trace_id: traceId, detail: 'simulated' }, 'default');

    const fixture = exportFailureReplayFixture(traceId, 'default');
    expect(fixture).not.toBeNull();
    expect(fixture?.trace.trace_id).toBe(traceId);
    expect(fixture?.tool_spans).toHaveLength(1);
    expect(fixture?.related_events.length).toBeGreaterThanOrEqual(1);
    expect(fixture?.expected.status).toBe('failed');
    expect(fixture?.expected.failure_category).toBe('tool_protocol');
  });

  it('replays fixture with default mocks and matches expected outcome', async () => {
    const fixture = exportFailureReplayFixture(traceId, 'default');
    expect(fixture).not.toBeNull();

    const result = await runFailureReplay(fixture!);
    expect(result.passed).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.observed.status).toBe('failed');
    expect(result.observed.failure_category).toBe('tool_protocol');
  });

  it('detects mismatches with custom provider mock', async () => {
    const fixture = exportFailureReplayFixture(traceId, 'default');
    expect(fixture).not.toBeNull();

    const result = await runFailureReplay(fixture!, {
      providerMock: () => ({ status: 'success' }),
    });

    expect(result.passed).toBe(false);
    expect(result.mismatches.some((entry) => entry.includes('status mismatch'))).toBe(true);
  });

  it('generates fixture + regression skeleton artifacts in one call', () => {
    const outDir = createTempDir();
    try {
      const artifacts = generateFailureReplayArtifacts(traceId, {
        tenantId: 'default',
        outputDir: outDir,
      });

      expect(artifacts).not.toBeNull();
      expect(existsSync(artifacts!.fixturePath)).toBe(true);
      expect(existsSync(artifacts!.testPath)).toBe(true);

      const skeleton = readFileSync(artifacts!.testPath, 'utf-8');
      expect(skeleton).toContain(`failure replay ${traceId}`);
      expect(skeleton).toContain('runFailureReplay');
    } finally {
      removeTempDir(outDir);
    }
  });
});
