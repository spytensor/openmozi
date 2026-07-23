import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  sanitizeVisibleOutput,
  brainExecute,
  isRenderableArtifactEvent,
  type BrainExecutionOptions,
} from './brain-engine.js';
import type { LLMClient, ChatMessage, ChatResponse } from './llm.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { on as onProgress, type ProgressEvent } from '../progress/event-bus.js';
import { loadConfig } from '../config/index.js';
import { getConfigPath } from '../paths.js';
import { getOutputDir } from '../tools/workspace-policy.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { listRequests } from '../security/gates.js';
import { settleApprovalDecision } from '../security/approval-wait.js';
import { __resetSteerStoreForTests, enqueueSteer } from '../gateway/steer-store.js';

vi.mock('../tools/tool-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/tool-utils.js')>();
  return {
    ...actual,
    createFileCheckpointHandle: () => null,
    finalizeFileCheckpoint: () => {},
    rollbackFileCheckpoint: () => {},
  };
});

const dagBridgeHoisted = vi.hoisted(() => ({
  executeDecomposeTaskMock: vi.fn(),
}));
const planGroundingHoisted = vi.hoisted(() => ({
  buildActivePlanContextMock: vi.fn(() => null as string | null),
}));

vi.mock('./dag-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dag-bridge.js')>();
  return {
    ...actual,
    executeDecomposeTask: dagBridgeHoisted.executeDecomposeTaskMock,
  };
});

vi.mock('./plan-grounding.js', () => ({
  buildActivePlanContext: planGroundingHoisted.buildActivePlanContextMock,
}));

// ---------------------------------------------------------------------------
// sanitizeVisibleOutput tests
// ---------------------------------------------------------------------------

describe('sanitizeVisibleOutput', () => {
  it('strips <think> blocks', () => {
    expect(sanitizeVisibleOutput('Hello <think>internal reasoning</think> World'))
      .toBe('Hello World');
  });

  it('strips incomplete <think> blocks (streaming)', () => {
    expect(sanitizeVisibleOutput('Hello <think>partial reasoning'))
      .toBe('Hello');
  });

  it('strips legacy MiniMax tool call XML', () => {
    const input = 'Before <minimax:tool_call><invoke name="test"><parameter name="x">1</parameter></invoke></minimax:tool_call> After';
    expect(sanitizeVisibleOutput(input)).toBe('Before After');
  });

  it('strips [TOOL_CALL] protocol', () => {
    const input = 'Before [TOOL_CALL]{"name":"test"}[/TOOL_CALL] After';
    expect(sanitizeVisibleOutput(input)).toBe('Before After');
  });

  it('passes through clean text', () => {
    expect(sanitizeVisibleOutput('Hello, World!')).toBe('Hello, World!');
  });

  it('strips DSML prefixed-XML tool-call markup leaked as text', () => {
    const input =
      'Here you go: <|DSML|tool_calls><|DSML|invoke name="web_fetch">' +
      '<|DSML|parameter name="url" string="true">https://example.com</|DSML|parameter>' +
      '<|DSML|parameter name="max_chars" string="false">15000</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls>';
    expect(sanitizeVisibleOutput(input)).toBe('Here you go:');
  });

  it('strips a truncated DSML block (stream cut mid-markup)', () => {
    const input = 'Reading the page <|DSML|invoke name="web_fetch"><|DSML|parameter name="url" string="true">https://exam';
    expect(sanitizeVisibleOutput(input)).toBe('Reading the page');
  });
});

// ---------------------------------------------------------------------------
// brainExecute tests with mock LLM client
// ---------------------------------------------------------------------------

function createMockClient(responses: ChatResponse[]): LLMClient {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return resp;
    }),
    chatStream: vi.fn(function* () {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      yield { type: 'text' as const, text: resp.content };
      yield { type: 'done' as const, response: resp };
    }),
  } as unknown as LLMClient;
}

function buildTestOptions(
  client: LLMClient,
  overrides?: Partial<BrainExecutionOptions>,
): BrainExecutionOptions {
  const defaultToolContext: BrainExecutionOptions['toolContext'] = {
    chatId: 'test-chat',
    tenantId: 'tenant-brain-test',
    agentId: 'session:brain-test',
    permissionLevel: 'L3_FULL_ACCESS',
  };
  const mergedOverrides = {
    ...overrides,
    toolContext: {
      ...defaultToolContext,
      ...(overrides?.toolContext ?? {}),
    },
  };
  return {
    client,
    tenantId: overrides?.tenantId ?? mergedOverrides.toolContext.tenantId ?? 'tenant-brain-test',
    contextMessages: [
      { role: 'system', content: 'You are MOZI.' },
      { role: 'user', content: 'Hello' },
    ],
    maxTokens: 4096,
    temperature: 0.7,
    toolContext: defaultToolContext,
    progress: {
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onProcessingStart: vi.fn(),
    },
    chatId: 'test-chat',
    turnId: 'test-turn',
    taskId: 'test-task',
    maxIterations: 10,
    llmCallTimeoutMs: 30000,
    maxLoopElapsedMs: 60000,
    repeatedBatchThreshold: 2,
    maxFailedToolBatches: 3,
    selfHealRetries: 1,
    selfHealBackoffMs: 0,
    ...mergedOverrides,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitForPermissionElevationRequest(tenantId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const requests = listRequests({ action: 'permission_elevation', tenant_id: tenantId });
    if (requests.length > 0) return requests[0];
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for permission elevation request in ${tenantId}`);
}

describe('brainExecute', () => {
  beforeEach(() => {
    dagBridgeHoisted.executeDecomposeTaskMock.mockReset();
    planGroundingHoisted.buildActivePlanContextMock.mockReset();
    planGroundingHoisted.buildActivePlanContextMock.mockReturnValue(null);
  });

  it('rejects a mismatched request and tool-context tenant before calling the model', async () => {
    const client = createMockClient([
      { content: 'must not run', usage: { input_tokens: 1, output_tokens: 1 }, model: 'test', stop_reason: 'end_turn' },
    ]);

    await expect(brainExecute(buildTestOptions(client, {
      tenantId: 'tenant-alpha',
      toolContext: { tenantId: 'tenant-beta' },
    }))).rejects.toThrow('Brain tenant mismatch');
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('returns direct text response (no tool calls)', async () => {
    const client = createMockClient([
      { content: 'Hello! I am MOZI.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client));

    expect(result.responseText).toBe('Hello! I am MOZI.');
    expect(result.model).toBe('test-model');
    expect(result.recovered).toBe(false);
    expect(result.toolIterations).toBe(0);
  });

  it('lets an external CLI agent own the turn without exposing MOZI tools or durable-plan admission', async () => {
    const client = createMockClient([
      { content: 'CLI agent completed the requested work.', usage: { input_tokens: 0, output_tokens: 0 }, model: 'gpt-5.3-codex', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: 'Research several sources, edit the project, and verify the result.' },
      ],
      modelProvider: 'codex-cli',
      modelId: 'gpt-5.3-codex',
    }));

    expect(result.responseText).toBe('CLI agent completed the requested work.');
    expect(result.durablePlanRequired).toBe(false);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect((client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.tools).toBeUndefined();
  });

  it('forces the production macro report request through durable DAG admission', async () => {
    dagBridgeHoisted.executeDecomposeTaskMock.mockResolvedValueOnce({
      detached: true,
      rootTaskId: 'macro-root',
      content: 'Plan accepted and running.',
      userMessage: 'The macro report plan is running in the background.',
    });
    const client = createMockClient([
      // The model tries to bypass DAG admission with a direct answer. Runtime
      // must discard it and make another constrained planning call.
      { content: 'I will research and generate the report directly.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'deepseek-v4-pro', stop_reason: 'end_turn' },
      {
        content: '',
        usage: { input_tokens: 20, output_tokens: 10 },
        model: 'deepseek-v4-pro',
        stop_reason: 'tool_use',
        tool_calls: [{
          id: 'macro-plan',
          type: 'function',
          function: {
            name: 'decompose_task',
            arguments: JSON.stringify({
              goal: 'Produce a verified U.S. macro and bond-market PDF report.',
              subtasks: [
                { title: 'Collect macro data', objective: 'Collect and validate the requested series.', done_criteria: 'Every requested series is dated and sourced', depends_on: [] },
                { title: 'Analyze the yield curve', objective: 'Run quantitative and scenario analysis.', done_criteria: 'Requested scenarios and maturities are quantified', depends_on: [0] },
                { title: 'Generate and verify PDF', objective: 'Create charts, assemble the PDF, and verify it.', done_criteria: 'PDF exists and passes content and render checks', depends_on: [1] },
              ],
            }),
          },
        }],
      },
    ]);
    const prompt = 'Collect the latest U.S. macroeconomic data, including CPI, PCE, unemployment, nonfarm payrolls, retail sales, GDP growth, Fed funds expectations, and Treasury yields. Quantitatively assess how these indicators may affect the U.S. bond market across the yield curve. Generate a detailed PDF report with visualizations, scenario analysis, and implications for short-, medium-, and long-duration bonds. The report must have standard content for this kind of report.';

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.\n\n## Available Tools\n\nweb_search, write_file, decompose_task\n\nUse these tools when the user asks.' },
        { role: 'user', content: prompt },
      ],
      modelProvider: 'deepseek',
      modelId: 'deepseek-v4-pro',
    }));

    expect(result.responseText).toBe('The macro report plan is running in the background.');
    expect(result.durablePlanRequired).toBe(true);
    expect(result.durablePlanAdmissionBlocked).toBeUndefined();
    expect(dagBridgeHoisted.executeDecomposeTaskMock).toHaveBeenCalledTimes(1);
    expect(client.chat).toHaveBeenCalledTimes(2);
    for (const call of (client.chat as ReturnType<typeof vi.fn>).mock.calls) {
      const exposed = call[1]?.tools?.map((tool: { function: { name: string } }) => tool.function.name);
      expect(new Set(exposed)).toEqual(new Set(['use_skill', 'decompose_task']));
    }
    const retryMessages = (client.chat as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as ChatMessage[];
    expect(retryMessages.some(message => String(message.content).includes('Runtime admission rejected'))).toBe(true);
    expect(retryMessages.every(message => !String(message.content).includes('Most recent decompose_task validation error'))).toBe(true);
  });

  it('puts the latest decompose_task validation error into the rejection directive', async () => {
    const validationError = 'Error: Subtask 1 ("Report") depends_on index 1, which must be less than its own index 1 (only earlier subtasks allowed). Corrective hint: depends_on indices are 0-based; a subtask cannot depend on itself; "the previous subtask" is index N-1. Re-call decompose_task with corrected depends_on.';
    dagBridgeHoisted.executeDecomposeTaskMock
      .mockRejectedValueOnce(new Error(validationError.slice('Error: '.length)))
      .mockResolvedValueOnce({
        detached: true,
        rootTaskId: 'corrected-root',
        content: 'Plan accepted and running.',
        userMessage: 'Corrected plan started.',
      });
    const invalidPlan = {
      goal: 'Produce a verified market report.',
      subtasks: [
        { title: 'Research', objective: 'Collect evidence.', done_criteria: 'Evidence is persisted', depends_on: [] },
        { title: 'Report', objective: 'Write report.', done_criteria: 'Report is verified', depends_on: [1] },
      ],
    };
    const correctedPlan = {
      ...invalidPlan,
      subtasks: [invalidPlan.subtasks[0], { ...invalidPlan.subtasks[1], depends_on: [0] }],
    };
    const client = createMockClient([
      { content: '', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'tool_use', tool_calls: [{ id: 'invalid', type: 'function', function: { name: 'decompose_task', arguments: JSON.stringify(invalidPlan) } }] },
      { content: 'I cannot create the plan.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'end_turn' },
      { content: '', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'tool_use', tool_calls: [{ id: 'corrected', type: 'function', function: { name: 'decompose_task', arguments: JSON.stringify(correctedPlan) } }] },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: 'Research current market data, analyze it, and generate a detailed verified PDF report with charts.' },
      ],
    }));

    expect(result.durablePlanAdmissionBlocked).toBe(true);
    const correctionMessages = (client.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[0] as ChatMessage[];
    expect(correctionMessages.some(message => String(message.content).includes(validationError))).toBe(true);
  });

  it.each([
    ['an unrelated running plan', '[Active plan state] Plan "Old task" — status: running'],
    ['a recently completed plan', '[Active plan state] Plan "Old task" — status: completed'],
  ])('does not let %s exempt a new complex request from admission', async (_label, planContext) => {
    planGroundingHoisted.buildActivePlanContextMock.mockReturnValue(planContext);
    dagBridgeHoisted.executeDecomposeTaskMock.mockResolvedValueOnce({
      detached: true,
      rootTaskId: 'new-root',
      content: 'Plan accepted and running.',
      userMessage: 'New plan started.',
    });
    const client = createMockClient([{
      content: '',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'test-model',
      stop_reason: 'tool_use',
      tool_calls: [{
        id: 'new-plan',
        type: 'function',
        function: {
          name: 'decompose_task',
          arguments: JSON.stringify({
            goal: 'Build a separate production system.',
            subtasks: [
              { title: 'Build', objective: 'Implement the system.', done_criteria: 'System requirements are implemented', depends_on: [] },
              { title: 'Verify', objective: 'Test and package it.', done_criteria: 'Tests pass and package is produced', depends_on: [0] },
            ],
          }),
        },
      }],
    }]);

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: 'Build a production-ready SaaS app with authentication, billing, organization roles, audit logs, automated tests, Docker packaging, deployment configuration, and operator documentation.' },
      ],
    }));

    expect(result.durablePlanRequired).toBe(true);
    expect(result.responseText).toBe('New plan started.');
    expect(dagBridgeHoisted.executeDecomposeTaskMock).toHaveBeenCalledTimes(1);
  });

  it('does not stream a model response that runtime DAG admission rejects', async () => {
    dagBridgeHoisted.executeDecomposeTaskMock.mockResolvedValueOnce({
      detached: true,
      rootTaskId: 'stream-root',
      content: 'Plan accepted and running.',
      userMessage: 'Durable plan started.',
    });
    const responses: ChatResponse[] = [
      { content: 'Unverified direct answer.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
      {
        content: '',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test-model',
        stop_reason: 'tool_use',
        tool_calls: [{
          id: 'stream-plan',
          type: 'function',
          function: {
            name: 'decompose_task',
            arguments: JSON.stringify({
              goal: 'Research and produce a verified report.',
              subtasks: [
                { title: 'Research', objective: 'Collect evidence.', done_criteria: 'Sources and observations are persisted', depends_on: [] },
                { title: 'Report', objective: 'Analyze evidence and create the report.', done_criteria: 'Report requirements are evidenced', depends_on: [0] },
              ],
            }),
          },
        }],
      },
    ];
    let responseIndex = 0;
    const client = {
      provider: 'test',
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        const response = responses[responseIndex++] ?? responses.at(-1)!;
        if (response.content) yield { type: 'text' as const, text: response.content };
        yield { type: 'done' as const, response };
      }),
    } as LLMClient;
    const onStreamChunk = vi.fn();

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: 'Research current inflation data, perform scenario analysis, and generate a PDF report with charts.' },
      ],
      progress: {
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
        onStreamChunk,
        onStreamEnd: vi.fn(),
      },
    }));

    expect(result.responseText).toBe('Durable plan started.');
    expect(onStreamChunk).not.toHaveBeenCalled();
    expect(client.chatStream).toHaveBeenCalledTimes(2);
  });

  it('rejects a hallucinated hidden tool before any admission side effect', async () => {
    dagBridgeHoisted.executeDecomposeTaskMock.mockResolvedValueOnce({
      detached: true,
      rootTaskId: 'guard-root',
      content: 'Plan accepted and running.',
      userMessage: 'Guarded plan started.',
    });
    const client = createMockClient([
      {
        content: '',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test-model',
        stop_reason: 'tool_use',
        // web_search is intentionally not in the admission tool surface. The
        // provider may still hallucinate it; runtime must not execute it.
        tool_calls: [{ id: 'hidden-web', type: 'function', function: { name: 'web_search', arguments: '{"query":"must not run"}' } }],
      },
      {
        content: '',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test-model',
        stop_reason: 'tool_use',
        tool_calls: [{
          id: 'guard-plan',
          type: 'function',
          function: {
            name: 'decompose_task',
            arguments: JSON.stringify({
              goal: 'Research and produce a verified report.',
              subtasks: [
                { title: 'Research', objective: 'Collect evidence.', done_criteria: 'Evidence is persisted', depends_on: [] },
                { title: 'Report', objective: 'Analyze and produce the report.', done_criteria: 'Report is persisted and verified', depends_on: [0] },
              ],
            }),
          },
        }],
      },
    ]);
    const onToolStart = vi.fn();

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: 'Research current inflation data, perform scenario analysis, and generate a PDF report with charts.' },
      ],
      progress: {
        onToolStart,
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
      },
    }));

    expect(result.responseText).toBe('Guarded plan started.');
    expect(onToolStart).not.toHaveBeenCalledWith('web_search');
    expect(onToolStart).toHaveBeenCalledWith('decompose_task');
    const retryMessages = (client.chat as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as ChatMessage[];
    expect(retryMessages.some(message => String(message.content).includes('no rejected tool call was executed'))).toBe(true);
    expect(retryMessages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function.name === 'web_search'))).toBe(false);
  });

  it('suppresses streaming hidden artifact tools before UI or artifact side effects', async () => {
    dagBridgeHoisted.executeDecomposeTaskMock.mockResolvedValueOnce({
      detached: true,
      rootTaskId: 'stream-guard-root',
      content: 'Plan accepted and running.',
      userMessage: 'Stream-guarded plan started.',
    });
    let callIndex = 0;
    const client = {
      provider: 'test',
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        callIndex += 1;
        if (callIndex === 1) {
          yield { type: 'tool_input_start' as const, toolCallId: 'hidden-artifact', toolName: 'create_artifact' };
          yield { type: 'tool_input_delta' as const, toolCallId: 'hidden-artifact', delta: '{"title":"Phantom","content_type":"html","code":"<h1>Unverified</h1>"}' };
          yield { type: 'tool_input_end' as const, toolCallId: 'hidden-artifact' };
          yield { type: 'tool_input_start' as const, toolCallId: 'hidden-write', toolName: 'write_file' };
          yield { type: 'tool_input_delta' as const, toolCallId: 'hidden-write', delta: '{"path":"phantom.html","content":"<h1>Unverified</h1>"}' };
          yield { type: 'tool_input_end' as const, toolCallId: 'hidden-write' };
          yield {
            type: 'done' as const,
            response: {
              content: '',
              usage: { input_tokens: 10, output_tokens: 10 },
              model: 'test',
              stop_reason: 'tool_use',
              tool_calls: [
                { id: 'hidden-artifact', type: 'function' as const, function: { name: 'create_artifact', arguments: '{"title":"Phantom","content_type":"html","code":"<h1>Unverified</h1>"}' } },
                { id: 'hidden-write', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"phantom.html","content":"<h1>Unverified</h1>"}' } },
              ],
            },
          };
          return;
        }
        yield {
          type: 'done' as const,
          response: {
            content: '',
            usage: { input_tokens: 10, output_tokens: 10 },
            model: 'test',
            stop_reason: 'tool_use',
            tool_calls: [{
              id: 'stream-guard-plan',
              type: 'function' as const,
              function: {
                name: 'decompose_task',
                arguments: JSON.stringify({
                  goal: 'Research and produce a verified report.',
                  subtasks: [
                    { title: 'Research', objective: 'Collect evidence.', done_criteria: 'Evidence is persisted', depends_on: [] },
                    { title: 'Report', objective: 'Analyze and produce the report.', done_criteria: 'Report is persisted and verified', depends_on: [0] },
                  ],
                }),
              },
            }],
          },
        };
      }),
    } as unknown as LLMClient;
    const progressEvents: ProgressEvent[] = [];
    const unsubscribe = onProgress(event => progressEvents.push(event));
    const artifactEvents: ArtifactEvent[] = [];

    try {
      const result = await brainExecute(buildTestOptions(client, {
        contextMessages: [
          { role: 'system', content: 'You are MOZI.' },
          { role: 'user', content: 'Research current inflation data, perform scenario analysis, and generate a PDF report with charts.' },
        ],
        toolContext: {
          chatId: 'test-chat',
          sessionId: 'stream-guard-session',
          onArtifact: event => artifactEvents.push(event),
        },
        progress: {
          onToolStart: vi.fn(),
          onToolEnd: vi.fn(),
          onProcessingStart: vi.fn(),
          onStreamChunk: vi.fn(),
          onStreamEnd: vi.fn(),
        },
      }));

      expect(result.responseText).toBe('Stream-guarded plan started.');
      expect(artifactEvents).toHaveLength(0);
      expect(progressEvents.some(event => (
        event.type === 'tool_composing' &&
        (event.toolCallId === 'hidden-artifact' || event.toolCallId === 'hidden-write')
      ))).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('fails closed when a model repeatedly refuses required DAG admission', async () => {
    const client = createMockClient([
      { content: 'Direct result one.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
      { content: 'Direct result two.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
      { content: 'Direct result three.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: 'Research current inflation data, perform scenario analysis, and generate a PDF report with charts.' },
      ],
    }));

    expect(result.durablePlanRequired).toBe(true);
    expect(result.durablePlanAdmissionBlocked).toBe(true);
    expect(result.responseText).toContain('runtime blocked inline execution');
    expect(result.responseText).not.toContain('Direct result');
    expect(client.chat).toHaveBeenCalledTimes(3);
    expect(dagBridgeHoisted.executeDecomposeTaskMock).not.toHaveBeenCalled();
  });

  it('creates a complex recurring workload through MOZI scheduler admission without running it now', async () => {
    const db = setupTestDb();
    try {
      const prompt = '我需要构建一个定时任务，每天中国 A 股收盘后 15 分钟，搜索最新行情并生成 dashboard。';
      const client = createMockClient([{
        content: '',
        usage: { input_tokens: 20, output_tokens: 10 },
        model: 'test-model',
        stop_reason: 'tool_use',
        tool_calls: [{
          id: 'create-market-schedule',
          type: 'function',
          function: {
            name: 'set_cron_task',
            arguments: JSON.stringify({
              schedule_kind: 'cron',
              schedule_value: '15 15 * * 1-5',
              timezone: 'Asia/Shanghai',
              handler_type: 'managed_brain',
              handler_params: { prompt: '验证当日交易已收盘，搜索真实行情并生成 dashboard。' },
              description: 'A 股收盘复盘',
            }),
          },
        }],
      }]);
      const result = await brainExecute(buildTestOptions(client, {
        contextMessages: [
          { role: 'system', content: 'You are MOZI.' },
          { role: 'user', content: prompt },
        ],
        toolContext: {
          chatId: 'local-user:sess-scheduler-admission',
          userId: 'local-user',
          sessionId: 'sess-scheduler-admission',
          channelType: 'websocket',
          tenantId: 'tenant-brain-test',
          permissionLevel: 'L3_FULL_ACCESS',
          userPrompt: prompt,
        },
      }));

      expect(result.responseText).toContain('MOZI 定时任务已创建');
      expect(result.responseText).toMatch(/ID：cron_/);
      expect(client.chat).toHaveBeenCalledTimes(1);
      expect(dagBridgeHoisted.executeDecomposeTaskMock).not.toHaveBeenCalled();
      const row = getDb().prepare('SELECT handler_type, schedule_value, timezone FROM cron_tasks').get() as Record<string, string>;
      expect(row).toMatchObject({ handler_type: 'managed_brain', schedule_value: '15 15 * * 1-5', timezone: 'Asia/Shanghai' });
    } finally {
      teardownTestDb(db.tmpDir);
    }
  });

  it('fails closed instead of executing a scheduled workload when the model refuses the scheduler tool', async () => {
    const prompt = '我需要构建一个定时任务，每天收盘后搜索行情并生成 dashboard。';
    const client = createMockClient([
      { content: '我现在开始搜索行情。', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
      { content: '正在生成 dashboard。', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
      { content: '任务已经完成。', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model', stop_reason: 'end_turn' },
    ]);
    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: prompt },
      ],
    }));

    expect(result.runtimeAdmissionBlocked).toBe(true);
    expect(result.responseText).toContain('没有创建、修改或取消任何定时任务');
    expect(result.responseText).not.toContain('任务已经完成');
    expect(client.chat).toHaveBeenCalledTimes(3);
    expect(dagBridgeHoisted.executeDecomposeTaskMock).not.toHaveBeenCalled();
  });

  // Runtime-enforced detached handoff: when decompose_task starts a background
  // plan, the tool result carries ends_turn and the loop MUST finalize with the
  // user-facing handoff — no further LLM calls this turn. Production evidence
  // for why: a weak model ignored the ack text and re-executed the entire plan
  // in the foreground, doubling cost and racing the background delivery.
  it('ends the turn when a tool result carries ends_turn (detached plan handoff)', async () => {
    dagBridgeHoisted.executeDecomposeTaskMock.mockResolvedValueOnce({
      detached: true,
      rootTaskId: 'root-123',
      content: 'Plan accepted and RUNNING IN BACKGROUND (plan id: root-123).',
      userMessage: '已将任务分解为 2 步计划并开始后台执行。',
    });
    const client = createMockClient([
      {
        content: '',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test-model',
        stop_reason: 'tool_use',
        tool_calls: [
          {
            id: 'tc-1',
            type: 'function',
            function: {
              name: 'decompose_task',
              arguments: JSON.stringify({
                goal: 'g',
                subtasks: [
                  { title: 'Collect', objective: 'Collect evidence', done_criteria: 'Evidence is persisted', depends_on: [] },
                  { title: 'Synthesize', objective: 'Synthesize the result', done_criteria: 'Result is persisted and verified', depends_on: [0] },
                ],
              }),
            },
          },
        ],
      },
      // If the loop wrongly continued, this would become the response.
      { content: 'SHOULD NOT RUN', usage: { input_tokens: 1, output_tokens: 1 }, model: 'test-model', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client));

    expect(result.responseText).toBe('已将任务分解为 2 步计划并开始后台执行。');
    expect(result.recovered).toBe(false);
    expect(dagBridgeHoisted.executeDecomposeTaskMock).toHaveBeenCalledTimes(1);
    expect((client.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('strips think blocks from response', async () => {
    const client = createMockClient([
      { content: '<think>reasoning here</think>The answer is 42.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client));
    expect(result.responseText).toBe('The answer is 42.');
  });

  it('handles recovery when loop times out', async () => {
    // First call returns tool calls, but max_elapsed_ms = 0 means immediate timeout
    const client = createMockClient([
      { content: 'Recovered response.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'recovery-model', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      maxIterations: 1,
      maxLoopElapsedMs: 1, // immediate timeout
    }));

    // Should trigger recovery path
    expect(result.responseText.length).toBeGreaterThan(0);
  });

  it('limits tool iterations', async () => {
    // Create client that always returns tool calls
    let callCount = 0;
    const client = {
      chat: vi.fn(async (): Promise<ChatResponse> => {
        callCount++;
        if (callCount <= 3) {
          return {
            content: '',
            tool_calls: [{ id: `tc_${callCount}`, type: 'function', function: { name: 'shell_exec', arguments: '{"command":"echo hi"}' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'test',
            stop_reason: null,
          };
        }
        // Recovery response
        return {
          content: 'Done after recovery.',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: 'end_turn',
        };
      }),
      chatStream: vi.fn(),
    } as unknown as LLMClient;

    const result = await brainExecute(buildTestOptions(client, {
      maxIterations: 3,
      maxLoopElapsedMs: 60000,
    }));

    expect(result.responseText.length).toBeGreaterThan(0);
    // Should have hit max iterations (3 tool calls) then recovered
  });

  it('preserves reasoning_content when continuing after tool calls', async () => {
    const client = createMockClient([
      {
        content: '',
        reasoning_content: 'I need to call a tool before answering.',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test',
        stop_reason: null,
      },
      {
        content: 'Done.',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test',
        stop_reason: 'end_turn',
      },
    ]);

    const result = await brainExecute(buildTestOptions(client));
    const secondCallMessages = vi.mocked(client.chat).mock.calls[1]?.[0] as ChatMessage[];
    const assistantToolTurn = secondCallMessages.find(msg => msg.role === 'assistant' && msg.tool_calls);

    expect(result.responseText).toBe('Done.');
    expect(assistantToolTurn?.reasoning_content).toBe('I need to call a tool before answering.');
  });

  it('drains a turn-bound steer exactly once before the next model boundary', async () => {
    __resetSteerStoreForTests();
    let callCount = 0;
    const seen: ChatMessage[][] = [];
    const client = {
      chat: vi.fn(async (messages: ChatMessage[]): Promise<ChatResponse> => {
        seen.push(messages.map((message) => ({ ...message })));
        callCount += 1;
        if (callCount === 1) {
          expect(enqueueSteer('tenant-brain-test', 'test-chat', 'test-turn', 'focus on the error path').accepted).toBe(true);
          return {
            content: '',
            tool_calls: [{ id: 'tc-steer', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }],
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'test',
            stop_reason: 'tool_use',
          };
        }
        return {
          content: 'Done.',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'test',
          stop_reason: 'end_turn',
        };
      }),
      chatStream: vi.fn(),
    } as unknown as LLMClient;

    const result = await brainExecute(buildTestOptions(client));

    const steers = seen[1]?.filter((message) => message.content.includes('[USER STEER')) ?? [];
    expect(result.responseText).toBe('Done.');
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ role: 'user' });
    expect(steers[0]?.content).toContain('focus on the error path');
  });

  it('accumulates token usage across tool-loop LLM calls', async () => {
    const client = createMockClient([
      {
        content: '',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'unknown_tool', arguments: '{"step":1}' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'test',
        stop_reason: 'tool-calls',
      },
      {
        content: '',
        tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'unknown_tool', arguments: '{"step":2}' } }],
        usage: { input_tokens: 20, output_tokens: 7 },
        model: 'test',
        stop_reason: 'tool-calls',
      },
      {
        content: 'Done after tools.',
        usage: { input_tokens: 30, output_tokens: 9 },
        model: 'test',
        stop_reason: 'end_turn',
      },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      maxFailedToolBatches: 10,
      selfHealRetries: 0,
    }));

    expect(result.responseText).toBe('Done after tools.');
    expect(result.recovered).toBe(false);
    expect(result.totalTokens).toBe(81);
    expect(client.chat).toHaveBeenCalledTimes(3);
  });

  it('allows repeated read-only polling batches without repeated_tool_loop recovery', async () => {
    const pollCall = {
      id: 'poll_1',
      type: 'function' as const,
      function: { name: 'process_status', arguments: '{"process_id":"proc-missing"}' },
    };
    const client = createMockClient([
      {
        content: '',
        tool_calls: [pollCall],
        usage: { input_tokens: 5, output_tokens: 1 },
        model: 'test',
        stop_reason: 'tool-calls',
      },
      {
        content: '',
        tool_calls: [{ ...pollCall, id: 'poll_2' }],
        usage: { input_tokens: 6, output_tokens: 1 },
        model: 'test',
        stop_reason: 'tool-calls',
      },
      {
        content: 'Polling complete.',
        usage: { input_tokens: 7, output_tokens: 2 },
        model: 'test',
        stop_reason: 'end_turn',
      },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      maxFailedToolBatches: 10,
      selfHealRetries: 0,
    }));

    expect(result.responseText).toBe('Polling complete.');
    expect(result.recovered).toBe(false);
    expect(client.chat).toHaveBeenCalledTimes(3);
  });

  it('passes think setting through to the LLM client', async () => {
    const client = createMockClient([
      { content: 'Done.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'end_turn' },
    ]);

    await brainExecute(buildTestOptions(client, { think: 'high' }));

    expect(vi.mocked(client.chat).mock.calls[0]?.[1]?.think).toBe('high');
  });

  it('combines the caller abort_signal with the gateway deadline for the LLM client', async () => {
    const client = createMockClient([
      { content: 'Done.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'end_turn' },
    ]);
    const controller = new AbortController();

    await brainExecute(buildTestOptions(client, { abortSignal: controller.signal }));

    const providerSignal = vi.mocked(client.chat).mock.calls[0]?.[1]?.abort_signal;
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(providerSignal).not.toBe(controller.signal);
    expect(providerSignal?.aborted).toBe(false);

    controller.abort('cancelled by caller');
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBe('cancelled by caller');
  });

  it('continues the same turn after an interactive permission approval resolves', async () => {
    const { tmpDir: dbTmpDir } = setupTestDb();
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-brain-approval-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());
    try {
      const approvedPath = join(getOutputDir(), 'brain-approval.txt');
      const tenantId = 'tenant-brain-approval';
      const client = createMockClient([
        {
          content: '',
          tool_calls: [{
            id: 'tc_brain_approval',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: approvedPath, content: 'continued' }),
            },
          }],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: null,
        },
        {
          content: '',
          tool_calls: [{
            id: 'tc_brain_readback',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: approvedPath }),
            },
          }],
          usage: { input_tokens: 12, output_tokens: 5 },
          model: 'test',
          stop_reason: 'tool_use',
        },
        {
          content: 'Done after approval.',
          usage: { input_tokens: 12, output_tokens: 5 },
          model: 'test',
          stop_reason: 'end_turn',
        },
      ]);
      const execution = brainExecute(buildTestOptions(client, {
        toolContext: {
          chatId: 'brain-approval-chat',
          userId: 'brain-approval-user',
          sessionId: 'brain-approval-session',
          agentId: 'session:brain-approval-session',
          permissionLevel: 'L0_READ_ONLY',
          tenantId,
        },
      }));

      const request = await waitForPermissionElevationRequest(tenantId);
      expect(request.context).toMatchObject({
        sessionId: 'brain-approval-session',
        required_level: 'L1_READ_WRITE',
        tool: 'write_file',
      });
      expect(settleApprovalDecision(request.id, 'approved')).toBe(true);

      const result = await execution;
      expect(result.responseText).toBe('Done after approval.');
      expect(readFileSync(approvedPath, 'utf-8')).toBe('continued');
      expect(client.chat).toHaveBeenCalledTimes(3);
    } finally {
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
      loadConfig('/nonexistent/mozi.json');
      teardownTestDb(dbTmpDir);
      rmSync(moziHome, { recursive: true, force: true });
    }
  });

  it('does not call the model when the turn is already cancelled', async () => {
    const client = createMockClient([
      { content: 'Done.', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'end_turn' },
    ]);
    const controller = new AbortController();
    controller.abort(new Error('User requested cancellation'));

    await expect(brainExecute(buildTestOptions(client, { abortSignal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError', message: 'User requested cancellation' });
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('never forces a continuation from user-intent keywords — the reply stands as-is (H批 root cause)', async () => {
    // Root-cause contract (operator decision 2026-07-18): the deleted
    // keyword-regex artifact contract used to re-invoke the model when the
    // user message matched terms like "SVG"/"html" and the reply had no
    // artifact — it misfired on a mere file path containing ".html" and
    // produced visible self-narration ("我回了文字，没出 artifact。现在补上").
    // Intent judgment belongs to the Brain: one call, the reply ships verbatim.
    const client = createMockClient([
      { content: '我来创建一个SVG图表，直观展示这几个酒店的选择对比。', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test', stop_reason: 'end_turn' },
    ]);

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: '给我一个 SVG 图表来快速比较这些酒店。' },
      ],
      toolContext: { chatId: 'test-chat', onArtifact: vi.fn() },
    }));

    expect(result.responseText).toBe('我来创建一个SVG图表，直观展示这几个酒店的选择对比。');
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('streams create_artifact tool input into one live artifact surface before completion', async () => {
    let streamCallCount = 0;
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        streamCallCount++;
        if (streamCallCount === 1) {
          yield { type: 'tool_input_start' as const, toolCallId: 'artifact-call-1', toolName: 'create_artifact' };
          yield {
            type: 'tool_input_delta' as const,
            toolCallId: 'artifact-call-1',
            delta: '{"title":"Live Report","content_type":"markdown","code":"# Live',
          };
          yield {
            type: 'tool_input_delta' as const,
            toolCallId: 'artifact-call-1',
            delta: ' Report\\n\\nDraft body"}',
          };
          yield { type: 'tool_input_end' as const, toolCallId: 'artifact-call-1' };
          yield {
            type: 'done' as const,
            response: {
              content: '',
              tool_calls: [{
                id: 'artifact-call-1',
                type: 'function' as const,
                function: {
                  name: 'create_artifact',
                  arguments: JSON.stringify({
                    title: 'Live Report',
                    content_type: 'markdown',
                    code: '# Live Report\n\nDraft body',
                    fallback_text: 'Live report ready',
                  }),
                },
              }],
              usage: { input_tokens: 10, output_tokens: 20 },
              model: 'test',
              stop_reason: 'tool-calls',
            },
          };
          return;
        }

        yield { type: 'text' as const, text: 'Report is ready.' };
        yield {
          type: 'done' as const,
          response: {
            content: 'Report is ready.',
            usage: { input_tokens: 12, output_tokens: 5 },
            model: 'test',
            stop_reason: 'end_turn',
          },
        };
      }),
    } as unknown as LLMClient;
    const artifactEvents: unknown[] = [];

    const result = await brainExecute(buildTestOptions(client, {
      contextMessages: [
        { role: 'system', content: 'You are MOZI.' },
        { role: 'user', content: '写一份报告' },
      ],
      toolContext: {
        chatId: 'test-chat',
        sessionId: 'session-1',
        onArtifact: (event) => artifactEvents.push(event),
      },
      progress: {
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
        onStreamChunk: vi.fn(),
        onStreamEnd: vi.fn(),
      },
    }));

    const open = artifactEvents.find((event) => (event as { type?: string }).type === 'open') as any;
    const patches = artifactEvents.filter((event) => (event as { type?: string }).type === 'patch') as any[];
    const runningPatch = patches.find((event) => event.patch?.status === 'running' && event.patch?.data?.markdown?.includes('Draft body'));
    const completedPatch = patches.find((event) => event.patch?.status === 'completed');
    const opens = artifactEvents.filter((event) => (event as { type?: string }).type === 'open');

    expect(result.responseText).toBe('Report is ready.');
    expect(opens).toHaveLength(1);
    expect(open?.artifact.plugin_id).toBe('live_work_v1');
    expect(open?.artifact.status).toBe('running');
    expect(runningPatch?.artifactId).toBe(open.artifact.id);
    expect(completedPatch?.artifactId).toBe(open.artifact.id);
    expect(completedPatch?.patch.data.markdown).toBe('# Live Report\n\nDraft body');
  });

  it('emits terminal tool_result and failed artifact patch when a tool turn is cancelled after tool_call', async () => {
    const controller = new AbortController();
    const progressEvents: ProgressEvent[] = [];
    const unsubscribe = onProgress((event) => progressEvents.push(event));
    const artifactEvents: unknown[] = [];
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield {
          type: 'done' as const,
          response: {
            content: '',
            tool_calls: [{
              id: 'artifact-call-cancelled',
              type: 'function' as const,
              function: {
                name: 'create_artifact',
                arguments: JSON.stringify({
                  title: 'Cancelled Preview',
                  content_type: 'html',
                  code: '<!doctype html><html><body>Cancelled</body></html>',
                }),
              },
            }],
            usage: { input_tokens: 10, output_tokens: 20 },
            model: 'test',
            stop_reason: 'tool-calls',
          },
        };
      }),
    } as unknown as LLMClient;

    await expect(brainExecute(buildTestOptions(client, {
      abortSignal: controller.signal,
      toolContext: {
        chatId: 'test-chat',
        sessionId: 'session-1',
        onArtifact: (event) => artifactEvents.push(event),
      },
      progress: {
        onToolStart: vi.fn(() => controller.abort(new Error('User cancelled'))),
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
        onStreamChunk: vi.fn(),
        onStreamEnd: vi.fn(),
      },
    }))).rejects.toMatchObject({ name: 'AbortError', message: 'User cancelled' });
    unsubscribe();

    const terminalToolResults = progressEvents.filter((event) => (
      event.type === 'tool_result' &&
      event.toolCallId === 'artifact-call-cancelled'
    ));
    const failedPatch = artifactEvents.find((event) => (
      (event as { type?: string; patch?: { status?: string } }).type === 'patch' &&
      (event as { patch?: { status?: string } }).patch?.status === 'failed'
    ));

    expect(terminalToolResults).toHaveLength(1);
    expect(terminalToolResults[0].error).toContain('User cancelled');
    expect(failedPatch).toBeDefined();
  });

  it('does not open live artifacts for streaming write_file inputs with non-renderable paths', async () => {
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield { type: 'tool_input_start' as const, toolCallId: 'write-py', toolName: 'write_file' };
        yield {
          type: 'tool_input_delta' as const,
          toolCallId: 'write-py',
          delta: '{"path":"script.py","content":"print(1)"}',
        };
        yield { type: 'tool_input_end' as const, toolCallId: 'write-py' };
        yield {
          type: 'done' as const,
          response: {
            content: 'Wrote script.',
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'test',
            stop_reason: 'end_turn',
          },
        };
      }),
    } as unknown as LLMClient;
    const artifactEvents: unknown[] = [];

    const result = await brainExecute(buildTestOptions(client, {
      toolContext: {
        chatId: 'test-chat',
        onArtifact: (event) => artifactEvents.push(event),
      },
      progress: {
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
        onStreamChunk: vi.fn(),
        onStreamEnd: vi.fn(),
      },
    }));

    expect(result.responseText).toBe('Wrote script.');
    expect(artifactEvents).toHaveLength(0);
  });

  it('opens live artifacts for streaming write_file inputs once the path is renderable', async () => {
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield { type: 'tool_input_start' as const, toolCallId: 'write-html', toolName: 'write_file' };
        yield {
          type: 'tool_input_delta' as const,
          toolCallId: 'write-html',
          delta: '{"content":"<!doctype html><html><body>Hi</body></html>",',
        };
        yield {
          type: 'tool_input_delta' as const,
          toolCallId: 'write-html',
          delta: '"path":"preview.html"}',
        };
        yield { type: 'tool_input_end' as const, toolCallId: 'write-html' };
        yield {
          type: 'done' as const,
          response: {
            content: 'Wrote preview.',
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'test',
            stop_reason: 'end_turn',
          },
        };
      }),
    } as unknown as LLMClient;
    const artifactEvents: unknown[] = [];

    const result = await brainExecute(buildTestOptions(client, {
      toolContext: {
        chatId: 'test-chat',
        onArtifact: (event) => artifactEvents.push(event),
      },
      progress: {
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
        onStreamChunk: vi.fn(),
        onStreamEnd: vi.fn(),
      },
    }));

    const open = artifactEvents.find((event) => (event as { type?: string }).type === 'open') as any;
    const patch = artifactEvents.find((event) => (
      (event as { type?: string; patch?: { data?: { code?: string } } }).type === 'patch' &&
      (event as { patch?: { data?: { code?: string } } }).patch?.data?.code?.includes('<!doctype html>')
    ));

    expect(result.responseText).toBe('Wrote preview.');
    expect(open?.artifact.title).toBe('preview.html');
    expect(open?.artifact.data.content_type).toBe('html');
    expect(patch).toBeDefined();
  });

  it('converges streaming write_file live preview and final file artifact with the same toolCallId', async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-write-file-convergence-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());

    try {
      const outputDir = getOutputDir();
      const htmlPath = join(outputDir, 'workbuddy-intro.html');
      const html = '<!doctype html><html><body><main><h1>WorkBuddy</h1><p>Intro deck body</p></main></body></html>';
      let streamCallCount = 0;
      const client = {
        chat: vi.fn(),
        chatStream: vi.fn(async function* () {
          streamCallCount++;
          if (streamCallCount === 1) {
            yield { type: 'tool_input_start' as const, toolCallId: 'stream-write-html', toolName: 'write_file' };
            const args = JSON.stringify({ path: htmlPath, content: html });
            yield { type: 'tool_input_delta' as const, toolCallId: 'stream-write-html', delta: args.slice(0, 55) };
            yield { type: 'tool_input_delta' as const, toolCallId: 'stream-write-html', delta: args.slice(55) };
            yield { type: 'tool_input_end' as const, toolCallId: 'stream-write-html' };
            yield {
              type: 'done' as const,
              response: {
                content: '',
                tool_calls: [{
                  id: 'stream-write-html',
                  type: 'function' as const,
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: htmlPath, content: html }),
                  },
                }],
                usage: { input_tokens: 10, output_tokens: 20 },
                model: 'test',
                stop_reason: 'tool-calls',
              },
            };
            return;
          }

          yield { type: 'text' as const, text: 'Deck is ready.' };
          yield {
            type: 'done' as const,
            response: {
              content: 'Deck is ready.',
              usage: { input_tokens: 12, output_tokens: 5 },
              model: 'test',
              stop_reason: 'end_turn',
            },
          };
        }),
      } as unknown as LLMClient;
      const artifactEvents: ArtifactEvent[] = [];

      const result = await brainExecute(buildTestOptions(client, {
        toolContext: {
          chatId: 'test-chat',
          sessionId: 'session-write-convergence',
          onArtifact: (event) => artifactEvents.push(event),
        },
        progress: {
          onToolStart: vi.fn(),
          onToolEnd: vi.fn(),
          onProcessingStart: vi.fn(),
          onStreamChunk: vi.fn(),
          onStreamEnd: vi.fn(),
        },
      }));

      const opens = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
      const completedPatch = artifactEvents.find((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
        event.type === 'patch' && event.patch.status === 'completed'
      ));
      const fileArtifacts = artifactEvents.filter((event) => (
        (event.type === 'open' && event.artifact.plugin_id === 'file_v1')
        || (event.type === 'patch' && event.patch.plugin_id === 'file_v1')
      ));
      const renderableArtifactIds = new Set(
        artifactEvents.flatMap((event) => {
          if (event.type === 'open' && ['live_work_v1', 'sandpack_v1', 'document_v1'].includes(event.artifact.plugin_id)) {
            return [event.artifact.id];
          }
          if (event.type === 'patch' && ['sandpack_v1', 'document_v1'].includes(String(event.patch.plugin_id))) {
            return [event.artifactId];
          }
          return [];
        }),
      );

      expect(result.responseText).toBe('Deck is ready.');
      expect(opens).toHaveLength(1);
      expect(opens[0].artifact.plugin_id).toBe('live_work_v1');
      expect(opens[0].artifact.title).toBe('workbuddy-intro.html');
      expect(completedPatch?.artifactId).toBe(opens[0].artifact.id);
      expect(completedPatch?.patch.plugin_id).toBe('sandpack_v1');
      expect(fileArtifacts).toHaveLength(0);
      expect(renderableArtifactIds.size).toBe(1);
    } finally {
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('keeps create_artifact and write_file outputs with different toolCallIds as two cards', async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-two-artifacts-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());

    try {
      const outputDir = getOutputDir();
      const htmlPath = join(outputDir, 'deck-preview.html');
      const html = '<!doctype html><html><body><main><h1>Deck Preview</h1></main></body></html>';
      const client = createMockClient([
        {
          content: '',
          tool_calls: [
            {
              id: 'create-deck-notes',
              type: 'function',
              function: {
                name: 'create_artifact',
                arguments: JSON.stringify({
                  title: 'Deck Notes',
                  content_type: 'markdown',
                  code: '# Deck Notes\n\nSpeaker notes',
                }),
              },
            },
            {
              id: 'write-deck-preview',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: htmlPath, content: html }),
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'test',
          stop_reason: 'tool-calls',
        },
        {
          content: 'Deck assets are ready.',
          usage: { input_tokens: 12, output_tokens: 5 },
          model: 'test',
          stop_reason: 'end_turn',
        },
      ]);
      const artifactEvents: ArtifactEvent[] = [];

      const result = await brainExecute(buildTestOptions(client, {
        toolContext: {
          chatId: 'test-chat',
          sessionId: 'session-two-artifacts',
          onArtifact: (event) => artifactEvents.push(event),
        },
      }));

      const opens = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
      const completedIds = new Set(artifactEvents.flatMap((event) => (
        event.type === 'patch' && event.patch.status === 'completed' ? [event.artifactId] : []
      )));

      expect(result.responseText).toBe('Deck assets are ready.');
      expect(opens).toHaveLength(2);
      expect(new Set(opens.map((event) => event.artifact.id)).size).toBe(2);
      expect(completedIds.size).toBe(2);
      expect(opens.map((event) => event.artifact.title).sort()).toEqual(['Deck Notes', 'deck-preview.html']);
    } finally {
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('fails a live write_file artifact from the abort event when the stream hangs', async () => {
    const controller = new AbortController();
    let releaseStream!: () => void;
    const streamBlocker = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let resolveFailedPatch!: (event: any) => void;
    const failedPatchPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for failed artifact patch')), 500);
      resolveFailedPatch = (event) => {
        clearTimeout(timeout);
        resolve(event);
      };
    });
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield { type: 'tool_input_start' as const, toolCallId: 'write-hanging-html', toolName: 'write_file' };
        yield {
          type: 'tool_input_delta' as const,
          toolCallId: 'write-hanging-html',
          delta: '{"path":"cancelled.html","content":"<!doctype html><html><body>Partial',
        };
        await streamBlocker;
      }),
    } as unknown as LLMClient;
    const artifactEvents: unknown[] = [];
    let didAbort = false;

    const execution = brainExecute(buildTestOptions(client, {
      abortSignal: controller.signal,
      toolContext: {
        chatId: 'test-chat',
        onArtifact: (event) => {
          artifactEvents.push(event);
          if ((event as { type?: string }).type === 'open' && !didAbort) {
            didAbort = true;
            controller.abort(new Error('User requested cancellation'));
          }
          if (
            (event as { type?: string; patch?: { status?: string } }).type === 'patch' &&
            (event as { patch?: { status?: string } }).patch?.status === 'failed'
          ) {
            resolveFailedPatch(event);
          }
        },
      },
      progress: {
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onProcessingStart: vi.fn(),
        onStreamChunk: vi.fn(),
        onStreamEnd: vi.fn(),
      },
    })).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    const failedPatch = await failedPatchPromise;
    expect(failedPatch.patch.fallback_text).toBe('User requested cancellation');

    releaseStream();
    const settled = await execution;
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.error).toMatchObject({ name: 'AbortError', message: 'User requested cancellation' });
    }

    const failedPatches = artifactEvents.filter((event) => (
      (event as { type?: string; patch?: { status?: string } }).type === 'patch' &&
      (event as { patch?: { status?: string } }).patch?.status === 'failed'
    ));
    expect(failedPatches).toHaveLength(1);
  });

  // Runs `use_skill('pptx')`, whose `install:` manifest declares `markitdown[pptx]`,
  // and `use_skill` awaits provisioning. MOZI_HOME is a fresh temp dir per test, so
  // that is a real cold pip install over the network. It previously fit the default
  // timeout only because provisioning failed fast (a `cryptography` source build);
  // now that installs are restricted to binary wheels they actually succeed, and
  // succeeding takes longer than failing.
  it('emits one file_v1 artifact for a generated deck and patches overwrites without surfacing the build script', { timeout: 120_000 }, async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-file-artifacts-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());

    try {
      const outputDir = getOutputDir();
      const deckPath = join(outputDir, 'quarterly-review.pptx');
      const scriptPath = join(outputDir, 'build_deck.py');
      const firstDeckContent = 'first deck bytes';
      const secondDeckContent = 'second deck bytes are newer';
      const firstCommand = [
        `mkdir -p ${shellQuote(outputDir)}`,
        `printf %s ${shellQuote(firstDeckContent)} > ${shellQuote(deckPath)}`,
        `printf %s ${shellQuote('print(1)')} > ${shellQuote(scriptPath)}`,
      ].join(' && ');
      const secondCommand = `printf %s ${shellQuote(secondDeckContent)} > ${shellQuote(deckPath)}`;
      const client = createMockClient([
        {
          content: '',
          tool_calls: [
            {
              id: 'skill-pptx',
              type: 'function',
              function: { name: 'use_skill', arguments: JSON.stringify({ name: 'pptx' }) },
            },
            {
              id: 'write-deck-first',
              type: 'function',
              function: { name: 'shell_exec', arguments: JSON.stringify({ command: firstCommand }) },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: null,
        },
        {
          content: '',
          tool_calls: [{
            id: 'write-deck-second',
            type: 'function',
            function: { name: 'shell_exec', arguments: JSON.stringify({ command: secondCommand }) },
          }],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: null,
        },
        {
          content: 'Deck is ready.',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: 'end_turn',
        },
      ]);
      const artifactEvents: ArtifactEvent[] = [];

      const result = await brainExecute(buildTestOptions(client, {
        toolContext: {
          chatId: 'test-chat',
          sessionId: 'session-file-artifacts',
          onArtifact: (event) => artifactEvents.push(event),
        },
      }));

      const fileOpens = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => (
        event.type === 'open' && event.artifact.plugin_id === 'file_v1'
      ));
      const filePatches = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
        event.type === 'patch' && event.patch.plugin_id === 'file_v1'
      ));
      const latestData = filePatches.at(-1)?.patch.data ?? fileOpens[0]?.artifact.data;

      expect(result.responseText).toBe('Deck is ready.');
      expect(fileOpens).toHaveLength(1);
      expect(fileOpens[0].artifact).toMatchObject({
        plugin_id: 'file_v1',
        title: 'quarterly-review.pptx',
        status: 'completed',
      });
      expect(fileOpens[0].artifact.data).toMatchObject({
        path: realpathSync(deckPath),
        filename: 'quarterly-review.pptx',
        ext: 'pptx',
        size: Buffer.byteLength(firstDeckContent),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        kind: 'deck',
        skillName: 'pptx',
      });
      expect(latestData).toMatchObject({
        path: realpathSync(deckPath),
        filename: 'quarterly-review.pptx',
        ext: 'pptx',
        size: Buffer.byteLength(secondDeckContent),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        kind: 'deck',
        skillName: 'pptx',
      });
      expect(artifactEvents.some((event) => (
        event.type === 'open' &&
        event.artifact.plugin_id === 'file_v1' &&
        event.artifact.title === 'build_deck.py'
      ))).toBe(false);
    } finally {
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('converges write_file pptx artifact with the output scan into one file_v1 card', async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-write-file-pptx-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());

    try {
      const outputDir = getOutputDir();
      const deckPath = join(outputDir, 'tool-written-deck.pptx');
      const deckContent = 'pptx bytes from write_file';
      const client = createMockClient([
        {
          content: '',
          tool_calls: [{
            id: 'write-pptx',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: deckPath, content: deckContent }) },
          }],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: 'tool-calls',
        },
        {
          content: 'Deck is ready.',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test',
          stop_reason: 'end_turn',
        },
      ]);
      const artifactEvents: ArtifactEvent[] = [];

      const result = await brainExecute(buildTestOptions(client, {
        toolContext: {
          chatId: 'test-chat',
          sessionId: 'session-write-pptx',
          onArtifact: (event) => artifactEvents.push(event),
        },
      }));

      const fileOpens = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => (
        event.type === 'open' && event.artifact.plugin_id === 'file_v1'
      ));
      const filePatches = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
        event.type === 'patch' && event.artifactId === fileOpens[0]?.artifact.id
      ));

      expect(result.responseText).toBe('Deck is ready.');
      expect(fileOpens).toHaveLength(1);
      expect(fileOpens[0].artifact.title).toBe('tool-written-deck.pptx');
      expect(filePatches.some((event) => event.patch.status === 'completed')).toBe(true);
      expect(filePatches.at(-1)?.patch.data).toMatchObject({
        path: realpathSync(deckPath),
        filename: 'tool-written-deck.pptx',
        ext: 'pptx',
        size: Buffer.byteLength(deckContent),
        kind: 'deck',
      });
    } finally {
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
      loadConfig('/nonexistent/mozi.json');
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact contract helpers
// ---------------------------------------------------------------------------

describe('isRenderableArtifactEvent', () => {
  it('does NOT count a bare pre-opened live placeholder (no code/markdown)', () => {
    const event: ArtifactEvent = {
      type: 'open',
      artifact: {
        id: 'a1',
        plugin_id: 'live_work_v1',
        title: 'Generating preview',
        status: 'running',
        collapsed_by_default: false,
        fallback_text: 'Preparing live preview...',
        data: { content_type: 'html', live_preview: true, phase: 'preparing' },
        updated_at: new Date().toISOString(),
      },
    };
    expect(isRenderableArtifactEvent(event)).toBe(false);
  });

  it('does NOT count a running placeholder patch that carries no real content', () => {
    const event: ArtifactEvent = {
      type: 'patch',
      artifactId: 'a1',
      patch: {
        status: 'running',
        data: { content_type: 'html', live_preview: true, code: '   ' },
        updated_at: new Date().toISOString(),
      },
    };
    expect(isRenderableArtifactEvent(event)).toBe(false);
  });

  it('counts a patch that delivers real code content', () => {
    const event: ArtifactEvent = {
      type: 'patch',
      artifactId: 'a1',
      patch: {
        status: 'running',
        data: { content_type: 'html', live_preview: true, code: '<h1>hi</h1>' },
        updated_at: new Date().toISOString(),
      },
    };
    expect(isRenderableArtifactEvent(event)).toBe(true);
  });

  it('counts a terminal completed patch', () => {
    const event: ArtifactEvent = {
      type: 'patch',
      artifactId: 'a1',
      patch: { status: 'completed', updated_at: new Date().toISOString() },
    };
    expect(isRenderableArtifactEvent(event)).toBe(true);
  });

  it('counts a completed open carrying markdown content', () => {
    const event: ArtifactEvent = {
      type: 'open',
      artifact: {
        id: 'a1',
        plugin_id: 'document_v1',
        title: 'Report',
        status: 'completed',
        collapsed_by_default: false,
        fallback_text: 'Report',
        data: { content_type: 'markdown', markdown: '# Report' },
        updated_at: new Date().toISOString(),
      },
    };
    expect(isRenderableArtifactEvent(event)).toBe(true);
  });

  it('does not count a close event', () => {
    expect(isRenderableArtifactEvent({ type: 'close', artifactId: 'a1' })).toBe(false);
  });
});
