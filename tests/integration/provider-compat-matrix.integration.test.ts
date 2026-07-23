import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create, type ChatMessage, type ChatResponse, type ToolDefinition } from '../../src/core/llm.js';
import { createFailoverManager, type FallbackChain } from '../../src/core/provider-failover.js';
import { getAllProviders, getProvider, resolveApiKey } from '../../src/core/providers.js';

type RunMode = 'smoke' | 'full';
type ProtocolClass = 'openai' | 'anthropic' | 'openai-compatible';
type ScenarioName = 'non_stream_tool_call' | 'stream_tool_call' | 'parallel_multi_tool_call' | 'failover_recovery';
type CaseStatus = 'passed' | 'failed' | 'skipped';

interface ProviderTarget {
  protocol: ProtocolClass;
  provider: string;
  model: string;
  configured: boolean;
  reason?: string;
}

interface CaseResult {
  id: string;
  mode: RunMode;
  scenario: ScenarioName;
  protocol: ProtocolClass | 'mixed';
  provider: string;
  model: string;
  status: CaseStatus;
  elapsed_ms: number;
  tool_call_count?: number;
  stream_chunk_count?: number;
  error?: string;
}

const MODE: RunMode = process.env.PROVIDER_COMPAT_MODE === 'full' ? 'full' : 'smoke';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_ROOT = resolve(
  process.cwd(),
  process.env.PROVIDER_COMPAT_REPORT_DIR || join('reports', 'provider-compat', `${MODE}-${RUN_ID}`),
);
const FAILURE_ROOT = join(REPORT_ROOT, 'failures');

const TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_weather',
      description: 'Get weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_time',
      description: 'Get local time for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
        additionalProperties: false,
      },
    },
  },
];

const CASE_RESULTS: CaseResult[] = [];

const OPENAI_TARGET = resolveFixedTarget(
  'openai',
  'openai',
  process.env.PROVIDER_COMPAT_OPENAI_MODEL || 'gpt-4.1-mini',
);

const ANTHROPIC_TARGET = resolveFixedTarget(
  'anthropic',
  'anthropic',
  process.env.PROVIDER_COMPAT_ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
);

const OPENAI_COMPAT_TARGET = resolveOpenAICompatTarget();

const PROVIDER_TARGETS: ProviderTarget[] = [OPENAI_TARGET, ANTHROPIC_TARGET, OPENAI_COMPAT_TARGET];

mkdirSync(FAILURE_ROOT, { recursive: true });

function resolveFixedTarget(
  provider: string,
  protocol: ProtocolClass,
  requestedModel: string,
): ProviderTarget {
  const def = getProvider(provider);
  if (!def) {
    return {
      protocol,
      provider,
      model: requestedModel,
      configured: false,
      reason: `Provider "${provider}" is not registered`,
    };
  }
  if (!resolveApiKey(provider)) {
    return {
      protocol,
      provider,
      model: requestedModel,
      configured: false,
      reason: `Missing API key for provider "${provider}"`,
    };
  }
  return {
    protocol,
    provider,
    model: requestedModel || def.defaultModel,
    configured: true,
  };
}

function resolveOpenAICompatTarget(): ProviderTarget {
  const explicitProvider = process.env.PROVIDER_COMPAT_OPENAI_COMPAT_PROVIDER?.trim();
  const explicitModel = process.env.PROVIDER_COMPAT_OPENAI_COMPAT_MODEL?.trim();

  if (explicitProvider) {
    const def = getProvider(explicitProvider);
    if (!def) {
      return {
        protocol: 'openai-compatible',
        provider: explicitProvider,
        model: explicitModel || '',
        configured: false,
        reason: `Configured openai-compatible provider "${explicitProvider}" is unknown`,
      };
    }
    if (def.apiMode !== 'openai-compat') {
      return {
        protocol: 'openai-compatible',
        provider: explicitProvider,
        model: explicitModel || def.defaultModel,
        configured: false,
        reason: `Provider "${explicitProvider}" is not openai-compatible (apiMode=${def.apiMode})`,
      };
    }
    if (!resolveApiKey(explicitProvider)) {
      return {
        protocol: 'openai-compatible',
        provider: explicitProvider,
        model: explicitModel || def.defaultModel,
        configured: false,
        reason: `Missing API key for provider "${explicitProvider}"`,
      };
    }
    return {
      protocol: 'openai-compatible',
      provider: explicitProvider,
      model: explicitModel || def.defaultModel,
      configured: true,
    };
  }

  const candidates = getAllProviders()
    .filter((providerDef) => providerDef.apiMode === 'openai-compat')
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const candidate of candidates) {
    if (!resolveApiKey(candidate.id)) continue;
    return {
      protocol: 'openai-compatible',
      provider: candidate.id,
      model: explicitModel || candidate.defaultModel,
      configured: true,
    };
  }

  return {
    protocol: 'openai-compatible',
    provider: explicitProvider || 'openai-compatible',
    model: explicitModel || '',
    configured: false,
    reason: 'No configured openai-compatible provider with an API key',
  };
}

function caseId(scenario: ScenarioName, target: ProviderTarget): string {
  return `${scenario}:${target.protocol}:${target.provider}`;
}

function pushResult(result: CaseResult): void {
  CASE_RESULTS.push(result);
}

function archiveFailure(result: CaseResult, sample: Record<string, unknown>): void {
  const filename = `${sanitize(`${result.id}-${Date.now()}`)}.json`;
  const path = join(FAILURE_ROOT, filename);
  writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`, 'utf-8');
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function makePrompt(singleTool = true): string {
  if (singleTool) {
    return [
      'Use tool calling.',
      'Call lookup_weather with city "San Francisco".',
      'Return tool calls only.',
    ].join(' ');
  }
  return [
    'Use tool calling.',
    'Call lookup_weather with city "San Francisco" and lookup_time with city "Tokyo".',
    'Issue both calls in the same response.',
    'Return tool calls only.',
  ].join(' ');
}

async function runNonStreamCase(target: ProviderTarget, multiTool: boolean): Promise<{ response: ChatResponse; elapsedMs: number }> {
  const client = create(target.provider, { model: target.model });
  const messages: ChatMessage[] = [{ role: 'user', content: makePrompt(!multiTool) }];
  const start = Date.now();
  const response = await client.chat(messages, {
    model: target.model,
    max_tokens: 256,
    temperature: 0,
    timeout_ms: 30_000,
    tools: TOOL_DEFS,
  });
  return { response, elapsedMs: Date.now() - start };
}

async function runStreamCase(target: ProviderTarget, multiTool: boolean): Promise<{ response: ChatResponse; elapsedMs: number; chunkCount: number }> {
  const client = create(target.provider, { model: target.model });
  const messages: ChatMessage[] = [{ role: 'user', content: makePrompt(!multiTool) }];
  const start = Date.now();
  let chunkCount = 0;
  let finalResponse: ChatResponse | null = null;

  for await (const chunk of client.chatStream(messages, {
    model: target.model,
    max_tokens: 256,
    temperature: 0,
    timeout_ms: 30_000,
    tools: TOOL_DEFS,
  })) {
    if (chunk.type === 'text' && chunk.text) chunkCount += 1;
    if (chunk.type === 'done' && chunk.response) finalResponse = chunk.response;
  }

  if (!finalResponse) {
    throw new Error('Stream finished without final response payload');
  }

  return {
    response: finalResponse,
    elapsedMs: Date.now() - start,
    chunkCount,
  };
}

function assertToolCalls(response: ChatResponse, minimum: number): number {
  const count = response.tool_calls?.length ?? 0;
  expect(count).toBeGreaterThanOrEqual(minimum);
  return count;
}

describe.sequential(`provider tool-call compatibility matrix (${MODE})`, () => {
  for (const target of PROVIDER_TARGETS) {
    it(
      `${target.protocol} non-stream tool_call`,
      async (ctx) => {
        const id = caseId('non_stream_tool_call', target);
        if (!target.configured) {
          pushResult({
            id,
            mode: MODE,
            scenario: 'non_stream_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'skipped',
            elapsed_ms: 0,
            error: target.reason,
          });
          ctx.skip();
          return;
        }

        try {
          const { response, elapsedMs } = await runNonStreamCase(target, false);
          const toolCallCount = assertToolCalls(response, 1);
          pushResult({
            id,
            mode: MODE,
            scenario: 'non_stream_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'passed',
            elapsed_ms: elapsedMs,
            tool_call_count: toolCallCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failed: CaseResult = {
            id,
            mode: MODE,
            scenario: 'non_stream_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'failed',
            elapsed_ms: 0,
            error: message,
          };
          pushResult(failed);
          archiveFailure(failed, { error: message });
          throw error;
        }
      },
      90_000,
    );

    it(
      `${target.protocol} stream tool_call`,
      async (ctx) => {
        const id = caseId('stream_tool_call', target);
        if (!target.configured) {
          pushResult({
            id,
            mode: MODE,
            scenario: 'stream_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'skipped',
            elapsed_ms: 0,
            error: target.reason,
          });
          ctx.skip();
          return;
        }

        try {
          const { response, elapsedMs, chunkCount } = await runStreamCase(target, false);
          const toolCallCount = assertToolCalls(response, 1);
          pushResult({
            id,
            mode: MODE,
            scenario: 'stream_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'passed',
            elapsed_ms: elapsedMs,
            tool_call_count: toolCallCount,
            stream_chunk_count: chunkCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failed: CaseResult = {
            id,
            mode: MODE,
            scenario: 'stream_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'failed',
            elapsed_ms: 0,
            error: message,
          };
          pushResult(failed);
          archiveFailure(failed, { error: message });
          throw error;
        }
      },
      90_000,
    );
  }

  const multiTargets = MODE === 'full'
    ? PROVIDER_TARGETS
    : [OPENAI_TARGET.configured ? OPENAI_TARGET : OPENAI_COMPAT_TARGET];

  for (const target of multiTargets) {
    it(
      `${target.protocol} parallel multi tool_call`,
      async (ctx) => {
        const id = caseId('parallel_multi_tool_call', target);
        if (!target.configured) {
          pushResult({
            id,
            mode: MODE,
            scenario: 'parallel_multi_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'skipped',
            elapsed_ms: 0,
            error: target.reason,
          });
          ctx.skip();
          return;
        }

        try {
          const { response, elapsedMs } = await runNonStreamCase(target, true);
          const toolCallCount = assertToolCalls(response, 2);
          pushResult({
            id,
            mode: MODE,
            scenario: 'parallel_multi_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'passed',
            elapsed_ms: elapsedMs,
            tool_call_count: toolCallCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failed: CaseResult = {
            id,
            mode: MODE,
            scenario: 'parallel_multi_tool_call',
            protocol: target.protocol,
            provider: target.provider,
            model: target.model,
            status: 'failed',
            elapsed_ms: 0,
            error: message,
          };
          pushResult(failed);
          archiveFailure(failed, { error: message });
          throw error;
        }
      },
      90_000,
    );
  }

  it(
    'failover recovery from primary failure to fallback success',
    async (ctx) => {
      const configuredTargets = PROVIDER_TARGETS.filter((target) => target.configured);
      const primary = configuredTargets[0];
      const fallback = configuredTargets[1];
      const id = 'failover_recovery:mixed';

      if (!primary || !fallback) {
        pushResult({
          id,
          mode: MODE,
          scenario: 'failover_recovery',
          protocol: 'mixed',
          provider: primary?.provider || 'unavailable',
          model: primary?.model || 'unavailable',
          status: 'skipped',
          elapsed_ms: 0,
          error: 'Need at least 2 configured providers for failover recovery scenario',
        });
        ctx.skip();
        return;
      }

      const chain: FallbackChain = {
        primary: {
          provider: primary.provider,
          model: `nonexistent-model-for-failover-${Date.now()}`,
        },
        fallbacks: [{
          provider: fallback.provider,
          model: fallback.model,
        }],
      };
      const manager = createFailoverManager(chain);

      try {
        const start = Date.now();
        const response = await manager.chat(
          [{ role: 'user', content: 'Reply with exactly: failover-ok' }],
          // Reasoning-capable fallbacks may consume a small output allowance
          // before emitting visible text. Keep this smoke assertion strict,
          // but give the fallback enough room to produce its final answer.
          { max_tokens: 256, timeout_ms: 30_000 },
        );
        expect(response.content.trim().length).toBeGreaterThan(0);
        expect(['fallback', 'normal']).toContain(manager.getState().mode);
        pushResult({
          id,
          mode: MODE,
          scenario: 'failover_recovery',
          protocol: 'mixed',
          provider: `${primary.provider}->${fallback.provider}`,
          model: `${chain.primary.model}->${fallback.model}`,
          status: 'passed',
          elapsed_ms: Date.now() - start,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: CaseResult = {
          id,
          mode: MODE,
          scenario: 'failover_recovery',
          protocol: 'mixed',
          provider: `${primary.provider}->${fallback.provider}`,
          model: `${chain.primary.model}->${fallback.model}`,
          status: 'failed',
          elapsed_ms: 0,
          error: message,
        };
        pushResult(failed);
        archiveFailure(failed, { error: message, chain });
        throw error;
      } finally {
        manager.destroy();
      }
    },
    120_000,
  );
});

afterAll(() => {
  const totals = {
    passed: CASE_RESULTS.filter((result) => result.status === 'passed').length,
    failed: CASE_RESULTS.filter((result) => result.status === 'failed').length,
    skipped: CASE_RESULTS.filter((result) => result.status === 'skipped').length,
  };

  const summary = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    mode: MODE,
    totals,
    results: CASE_RESULTS,
  };

  mkdirSync(REPORT_ROOT, { recursive: true });
  writeFileSync(
    join(REPORT_ROOT, 'compatibility-report.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8',
  );

  const md = [
    '# Provider Tool-Calling Compatibility Report',
    '',
    `- Run ID: ${RUN_ID}`,
    `- Mode: ${MODE}`,
    `- Generated At: ${summary.generated_at}`,
    `- Passed: ${totals.passed}`,
    `- Failed: ${totals.failed}`,
    `- Skipped: ${totals.skipped}`,
    '',
    '## Results',
    '',
    '| Scenario | Protocol | Provider | Model | Status | Tool Calls | Stream Chunks | Elapsed(ms) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...CASE_RESULTS.map((result) => [
      result.scenario,
      result.protocol,
      result.provider,
      result.model,
      result.status,
      result.tool_call_count ?? '-',
      result.stream_chunk_count ?? '-',
      result.elapsed_ms,
    ].join(' | ').replace(/^/, '| ').concat(' |')),
    '',
    `Failure samples: \`${join(REPORT_ROOT, 'failures')}\``,
    '',
  ].join('\n');

  writeFileSync(join(REPORT_ROOT, 'compatibility-report.md'), md, 'utf-8');
});
