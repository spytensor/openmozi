import { describe, expect, it } from 'vitest';
import type { FailureReplayFixture } from './failure-replay.js';
import type { PromptSnapshot } from './prompt-snapshot.js';
import {
  formatRegressionSummary,
  runRegressionCase,
  runRegressionSuite,
  type RegressionFixture,
} from './regression-harness.js';

function makeSyntheticFixture(overrides: Partial<FailureReplayFixture['trace']> = {}): FailureReplayFixture {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    trace: {
      trace_id: 'trace-reg-1',
      tenant_id: 'default',
      turn_id: 'turn-reg-1',
      chat_id: 'chat-reg-1',
      model: 'gpt-4.1-mini',
      provider: 'openai',
      status: 'failed',
      failure_category: 'tool_error',
      tool_call_count: 2,
      tool_failure_count: 1,
      llm_input_tokens: 500,
      llm_output_tokens: 100,
      cost_usd: 0.005,
      latency_ms: 800,
      started_at: '2026-03-01T00:00:00Z',
      ended_at: '2026-03-01T00:00:01Z',
      ...overrides,
    },
    tool_spans: [
      {
        id: 1,
        trace_id: 'trace-reg-1',
        tenant_id: 'default',
        turn_id: 'turn-reg-1',
        tool_call_id: 'tc-1',
        tool_name: 'read_file',
        iteration: 1,
        status: 'success',
        duration_ms: 10,
        error_category: null,
        error_message: null,
        started_at: '2026-03-01T00:00:00Z',
        ended_at: '2026-03-01T00:00:00Z',
      },
      {
        id: 2,
        trace_id: 'trace-reg-1',
        tenant_id: 'default',
        turn_id: 'turn-reg-1',
        tool_call_id: 'tc-2',
        tool_name: 'shell_exec',
        iteration: 2,
        status: 'error',
        duration_ms: 300,
        error_category: 'tool_error',
        error_message: 'command not found',
        started_at: '2026-03-01T00:00:00Z',
        ended_at: '2026-03-01T00:00:01Z',
      },
    ],
    related_events: [],
    expected: {
      status: 'failed',
      failure_category: 'tool_error',
      tool_calls: 2,
      tool_failures: 1,
    },
  };
}

function makePathGuessingFixture(): RegressionFixture {
  const fixture = makeSyntheticFixture({
    trace_id: 'trace-path-guess',
    failure_category: 'missing_resource',
  });
  fixture.tool_spans = [
    {
      id: 1,
      trace_id: 'trace-path-guess',
      tenant_id: 'default',
      turn_id: 'turn-reg-1',
      tool_call_id: 'tc-guess-1',
      tool_name: 'read_file',
      iteration: 1,
      status: 'error',
      duration_ms: 5,
      error_category: 'missing_resource',
      error_message: 'File not found: /src/components/Button.tsx (guessed path)',
      started_at: '2026-03-01T00:00:00Z',
      ended_at: '2026-03-01T00:00:00Z',
    },
    {
      id: 2,
      trace_id: 'trace-path-guess',
      tenant_id: 'default',
      turn_id: 'turn-reg-1',
      tool_call_id: 'tc-guess-2',
      tool_name: 'read_file',
      iteration: 2,
      status: 'error',
      duration_ms: 4,
      error_category: 'missing_resource',
      error_message: 'File not found: /src/ui/Button.tsx (guessed path)',
      started_at: '2026-03-01T00:00:00Z',
      ended_at: '2026-03-01T00:00:00Z',
    },
  ];
  fixture.expected = {
    status: 'failed',
    failure_category: 'missing_resource',
    tool_calls: 2,
    tool_failures: 2,
  };

  return {
    id: 'path-guessing-basic',
    category: 'path_guessing',
    description: 'Model guesses file paths instead of listing directory first',
    fixture,
    assertions: [
      {
        field: 'observed.failure_category',
        op: 'eq',
        value: 'missing_resource',
        message: 'Path guessing should be classified as missing_resource',
      },
      {
        field: 'observed.tool_failures',
        op: 'eq',
        value: 2,
        message: 'Both guessed reads should fail',
      },
    ],
  };
}

function makeTruncationDriftFixture(): RegressionFixture {
  const fixture = makeSyntheticFixture({
    trace_id: 'trace-truncation',
    failure_category: 'context_overflow',
    llm_input_tokens: 120000,
    llm_output_tokens: 50,
  });
  fixture.tool_spans = [
    {
      id: 1,
      trace_id: 'trace-truncation',
      tenant_id: 'default',
      turn_id: 'turn-reg-1',
      tool_call_id: 'tc-trunc-1',
      tool_name: 'read_file',
      iteration: 1,
      status: 'success',
      duration_ms: 15,
      error_category: null,
      error_message: null,
      started_at: '2026-03-01T00:00:00Z',
      ended_at: '2026-03-01T00:00:00Z',
    },
  ];
  fixture.expected = {
    status: 'failed',
    failure_category: 'context_overflow',
    tool_calls: 1,
    tool_failures: 0,
  };

  const snapshot: PromptSnapshot = {
    version: 1,
    trace_id: 'trace-truncation',
    tenant_id: 'default',
    chat_id: 'chat-truncation',
    model: 'gpt-4.1-mini',
    captured_at: '2026-03-01T00:00:00Z',
    context: {
      total_budget: 128000,
      system_slot_budget: 76800,
      history_token_budget: 51200,
      slots: [
        {
          name: 'identity',
          priority: 100,
          tokenCap: 30000,
          rawTokens: 28000,
          usedTokens: 28000,
          included: true,
          itemCount: 1,
          fallbackApplied: 'none',
        },
        {
          name: 'memory_facts',
          priority: 80,
          tokenCap: 16000,
          rawTokens: 45000,
          usedTokens: 16000,
          included: true,
          itemCount: 20,
          fallbackApplied: 'trimmed',
        },
      ],
    },
    tools: [{ name: 'read_file', source: 'builtin' }],
    verifier: {
      verify_status: 'not_required',
      verify_required: false,
      summary: 'No verification needed.',
      missing_actions: [],
      failure_reasons: [],
    },
    runtime_meta: {
      message_count: 50,
      system_message_count: 4,
    },
  };

  return {
    id: 'truncation-drift-basic',
    category: 'truncation_drift',
    description: 'Context overflow causes truncation of memory facts, leading to drift',
    fixture,
    snapshot,
    assertions: [
      {
        field: 'observed.failure_category',
        op: 'eq',
        value: 'context_overflow',
        message: 'Should detect context overflow',
      },
      {
        field: 'snapshot.context.slots.1.fallbackApplied',
        op: 'eq',
        value: 'trimmed',
        message: 'Memory facts should show trimmed fallback',
      },
    ],
  };
}

describe('observer/regression-harness', () => {
  it('runs a single path-guessing regression case and passes', async () => {
    const regressionFixture = makePathGuessingFixture();
    const result = await runRegressionCase(regressionFixture);

    expect(result.passed).toBe(true);
    expect(result.category).toBe('path_guessing');
    expect(result.replay.passed).toBe(true);
    expect(result.assertion_failures).toEqual([]);
  });

  it('runs a truncation-drift regression case with snapshot assertions', async () => {
    const regressionFixture = makeTruncationDriftFixture();
    const result = await runRegressionCase(regressionFixture);

    expect(result.passed).toBe(true);
    expect(result.category).toBe('truncation_drift');
    expect(result.snapshot_present).toBe(true);
    expect(result.assertion_failures).toEqual([]);
  });

  it('detects assertion failure when expected category mismatches', async () => {
    const regressionFixture = makePathGuessingFixture();
    regressionFixture.assertions = [{
      field: 'observed.failure_category',
      op: 'eq',
      value: 'timeout',
      message: 'Should be timeout (intentional mismatch)',
    }];

    const result = await runRegressionCase(regressionFixture);
    expect(result.passed).toBe(false);
    expect(result.assertion_failures).toHaveLength(1);
    expect(result.assertion_failures[0]).toContain('timeout');
  });

  it('runs a full regression suite and produces a summary', async () => {
    const fixtures: RegressionFixture[] = [
      makePathGuessingFixture(),
      makeTruncationDriftFixture(),
    ];

    const summary = await runRegressionSuite(fixtures);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.by_category['path_guessing'].passed).toBe(1);
    expect(summary.by_category['truncation_drift'].passed).toBe(1);
  });

  it('formats a human-readable regression summary', async () => {
    const fixtures: RegressionFixture[] = [
      makePathGuessingFixture(),
      makeTruncationDriftFixture(),
    ];

    const summary = await runRegressionSuite(fixtures);
    const text = formatRegressionSummary(summary);
    expect(text).toContain('2/2 passed');
    expect(text).toContain('path_guessing');
    expect(text).toContain('truncation_drift');
    expect(text).not.toContain('Failures:');
  });

  it('formats failure details in regression summary', async () => {
    const regressionFixture = makePathGuessingFixture();
    regressionFixture.assertions = [{
      field: 'observed.failure_category',
      op: 'eq',
      value: 'timeout',
    }];

    const summary = await runRegressionSuite([regressionFixture]);
    const text = formatRegressionSummary(summary);
    expect(text).toContain('0/1 passed');
    expect(text).toContain('Failures:');
    expect(text).toContain('path-guessing-basic');
  });
});
