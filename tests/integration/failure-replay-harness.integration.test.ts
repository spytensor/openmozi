import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../src/test-helpers.js';
import {
  completeTurnTrace,
  recordToolSpan,
  resetTelemetryTableFlag,
  startTurnTrace,
} from '../../src/observer/telemetry.js';
import {
  exportFailureReplayFixture,
  runFailureReplay,
} from '../../src/observer/failure-replay.js';

let tmpDir: string;

describe('integration/failure-replay-harness', () => {
  beforeEach(() => {
    const result = setupTestDb();
    tmpDir = result.tmpDir;
    resetTelemetryTableFlag();
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('replays a failed turn fixture end-to-end with default mocks', async () => {
    const traceId = 'trace-int-replay-1';

    startTurnTrace({
      trace_id: traceId,
      turn_id: 'turn-int-replay-1',
      tenant_id: 'default',
      chat_id: 'chat-int-replay-1',
      model: 'gpt-4.1-mini',
      provider: 'openai',
    });

    recordToolSpan({
      trace_id: traceId,
      turn_id: 'turn-int-replay-1',
      tenant_id: 'default',
      tool_call_id: 'tool-a',
      tool_name: 'read_file',
      iteration: 1,
      status: 'success',
      duration_ms: 50,
    });

    recordToolSpan({
      trace_id: traceId,
      turn_id: 'turn-int-replay-1',
      tenant_id: 'default',
      tool_call_id: 'tool-b',
      tool_name: 'shell_exec',
      iteration: 2,
      status: 'error',
      duration_ms: 90,
      error_category: 'timeout',
      error_message: 'Command timed out after 30s',
    });

    completeTurnTrace({
      trace_id: traceId,
      tenant_id: 'default',
      status: 'failed',
      failure_category: 'timeout',
      tool_call_count: 2,
      tool_failure_count: 1,
      latency_ms: 600,
      llm_input_tokens: 200,
      llm_output_tokens: 80,
      cost_usd: 0.03,
    });

    const fixture = exportFailureReplayFixture(traceId, 'default');
    expect(fixture).not.toBeNull();

    const result = await runFailureReplay(fixture!);
    expect(result.passed).toBe(true);
    expect(result.observed.status).toBe('failed');
    expect(result.observed.failure_category).toBe('timeout');
    expect(result.observed.tool_calls).toBe(2);
    expect(result.observed.tool_failures).toBe(1);
  });
});
