import { generateText, streamText, jsonSchema, tool as aiTool, type ModelMessage } from 'ai';
import pino from 'pino';
import { normalizeProviderError } from './error-surfacing.js';
import { getModel as getRegisteredModel, resolveSystemMessagePolicy, type SystemMessagePolicy } from './providers.js';
import { calculateCatalogCost, resolveModelPricing } from './model-pricing.js';
export { calculateCatalogCost } from './model-pricing.js';
import { extractLegacyToolCallsFromText, hasDsmlToolCallMarkup, stripDsmlToolCallMarkup } from './legacy-tool-parsing.js';
import { resolveMaxOutputTokens, type ModelFactory } from './model-factory.js';
import { recordLlmCall } from '../tenants/billing.js';
import {
  IncompleteStreamError,
  getTextContent,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMClient,
  type ModelThinkSetting,
  type StreamChunk,
  type ToolCall,
  type ToolDefinition,
} from './llm-contracts.js';

const logger = pino({ name: 'mozi:llm' });
const UNPARSABLE_TOOL_CALL_NOTICE = '模型返回了无法解析的工具调用，已忽略。 / The model emitted an unparsable tool call; it was ignored.';

export function toCoreMessages(messages: ChatMessage[]): ModelMessage[] {
  const coreMessages: ModelMessage[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      coreMessages.push({ role: 'system', content: getTextContent(msg) });
      continue;
    }

    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        // Multimodal user message — map ContentPart[] to AI SDK UserContent
        const parts = msg.content.map(part => {
          if (part.type === 'text') return { type: 'text' as const, text: part.text };
          return { type: 'image' as const, image: part.image, mediaType: part.mediaType };
        });
        coreMessages.push({ role: 'user', content: parts });
      } else {
        coreMessages.push({ role: 'user', content: msg.content });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const reasoningContent = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'reasoning'; text: string }
          | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
        > = [];

        if (reasoningContent) {
          content.push({ type: 'reasoning', text: reasoningContent });
        }

        const textContent = getTextContent(msg);
        if (textContent) {
          content.push({ type: 'text', text: textContent });
        }

        for (let j = 0; j < msg.tool_calls.length; j++) {
          const tc = msg.tool_calls[j];
          const toolCallId = typeof tc.id === 'string' && tc.id.trim().length > 0
            ? tc.id
            : `tool_call_${i}_${j}`;
          const toolName = typeof tc.function?.name === 'string' && tc.function.name.trim().length > 0
            ? tc.function.name
            : 'unknown_tool';
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }

          toolNameByCallId.set(toolCallId, toolName);
          content.push({
            type: 'tool-call',
            toolCallId,
            toolName,
            input,
          });
        }

        if (content.length === 0) {
          continue;
        }

        coreMessages.push({ role: 'assistant', content });
        continue;
      }

      if (reasoningContent) {
        const textContent = getTextContent(msg);
        const content: Array<
          | { type: 'reasoning'; text: string }
          | { type: 'text'; text: string }
        > = [
          { type: 'reasoning', text: reasoningContent },
        ];
        if (textContent) {
          content.push({ type: 'text', text: textContent });
        }
        coreMessages.push({ role: 'assistant', content });
      } else {
        coreMessages.push({ role: 'assistant', content: getTextContent(msg) });
      }
      continue;
    }

    // role === 'tool' — AI SDK v6 requires both toolCallId and toolName.
    const toolCallId = typeof msg.tool_call_id === 'string' && msg.tool_call_id.trim().length > 0
      ? msg.tool_call_id
      : '';
    const toolName = (typeof msg.tool_name === 'string' && msg.tool_name.trim().length > 0
      ? msg.tool_name
      : (toolCallId ? toolNameByCallId.get(toolCallId) : undefined)) || '';

    if (!toolCallId || !toolName) {
      // Guardrail: if historical tool messages are malformed, degrade to assistant text
      // so provider adapters never receive an invalid ModelMessage[] shape.
      logger.warn({
        hasToolCallId: toolCallId.length > 0,
        hasToolName: toolName.length > 0,
      }, 'Malformed tool message; downgraded to assistant text');
      coreMessages.push({
        role: 'assistant',
        content: getTextContent(msg),
      });
      continue;
    }

    coreMessages.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text' as const, value: getTextContent(msg) },
      }],
    });
  }

  return coreMessages;
}

/**
 * Normalize system messages according to the provider's declared policy.
 *
 * 'preserve-interleaved' returns the array untouched: turn context stays after
 * history and kernel directives stay at the tail, so every request in a tool
 * loop is a strict prefix-extension of the previous one and provider-side
 * prefix caches keep working.
 *
 * 'interleaved-as-user' keeps every message in place but re-roles mid-array
 * system messages (anything after the leading system block) as user, content
 * untouched. DeepSeek accepts mid-array system over HTTP yet its server-side
 * template handling stops prefix-cache matching at the pre-loop head once one
 * appears in a tool loop; the same content as user role caches fully and is
 * still followed (probed live 2026-07-20).
 *
 * 'consolidate-leading' merges all system messages into one leading block for
 * APIs that reject mid-conversation system messages; this rewrites the request
 * head on every mid-turn directive, which is the price of compatibility, not
 * the default we want.
 */
export function consolidateSystemMessages(
  messages: ModelMessage[],
  policy: SystemMessagePolicy = 'consolidate-leading',
): ModelMessage[] {
  if (policy === 'preserve-interleaved') return messages;
  if (policy === 'interleaved-as-user') {
    let pastLeadingBlock = false;
    let demoted = false;
    const reRoled = messages.map((msg) => {
      if (msg.role !== 'system') {
        pastLeadingBlock = true;
        return msg;
      }
      if (!pastLeadingBlock) return msg;
      demoted = true;
      // User role accepts the same content shapes; pass through untouched so a
      // non-string system payload can never be silently emptied.
      return { role: 'user' as const, content: msg.content };
    });
    return demoted ? reRoled : messages;
  }
  const systemParts: string[] = [];
  const nonSystem: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ type: string; text?: string }>)
              .filter(p => p.type === 'text' && p.text)
              .map(p => p.text!)
              .join('\n')
          : '';
      if (text.trim()) systemParts.push(text);
    } else {
      nonSystem.push(msg);
    }
  }

  if (systemParts.length <= 1) return messages; // No consolidation needed

  const consolidated: ModelMessage[] = [
    { role: 'system', content: systemParts.join('\n\n---\n\n') },
    ...nonSystem,
  ];
  return consolidated;
}

function applyPromptCacheOptions(
  options: Record<string, unknown>,
  providerName: string,
  chatOptions: ChatOptions | undefined,
): void {
  if (providerName !== 'openai' || !chatOptions?.promptCacheKey) return;
  const providerOptions = options.providerOptions && typeof options.providerOptions === 'object' && !Array.isArray(options.providerOptions)
    ? options.providerOptions as Record<string, unknown>
    : {};
  mergeProviderOption(providerOptions, 'openai', { promptCacheKey: chatOptions.promptCacheKey });
  options.providerOptions = providerOptions;
}

// ---------------------------------------------------------------------------
// Tool conversion: MOZI ToolDefinition[] → AI SDK tools record
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isStrictToolSchemaCompatible(schema: Record<string, unknown>): boolean {
  if (schema.anyOf || schema.allOf || schema.oneOf) return false;
  if (schema.type === 'array') {
    return isPlainObject(schema.items) && isStrictToolSchemaCompatible(schema.items);
  }
  if (schema.type !== 'object') {
    return ['string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type));
  }
  if (schema.additionalProperties !== false) return false;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  if (Object.keys(properties).some((key) => !required.has(key))) return false;
  return Object.values(properties).every((property) =>
    isPlainObject(property) && isStrictToolSchemaCompatible(property));
}

export function shouldUseStrictToolCalling(providerName: string, tool: ToolDefinition): boolean {
  // DeepSeek strict calling requires its beta endpoint. MOZI's normal DeepSeek
  // provider cannot claim that capability from the provider name alone.
  return providerName === 'openai' && isStrictToolSchemaCompatible(tool.function.parameters);
}

function toAITools(tools: ToolDefinition[], providerName: string) {
  const result: Record<string, ReturnType<typeof aiTool>> = {};

  for (const t of tools) {
    result[t.function.name] = aiTool({
      description: t.function.description,
      inputSchema: jsonSchema(t.function.parameters as Parameters<typeof jsonSchema>[0]),
      strict: shouldUseStrictToolCalling(providerName, t),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Result conversion: AI SDK tool calls → MOZI ToolCall[]
// ---------------------------------------------------------------------------

function fromAIToolCalls(
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
): ToolCall[] {
  return toolCalls.map(tc => ({
    id: tc.toolCallId,
    type: 'function' as const,
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  }));
}

export function resolveAbortSignal(timeoutMs: number | undefined, abortSignal: AbortSignal | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (abortSignal) signals.push(abortSignal);
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

type ThinkEffort = 'low' | 'medium' | 'high';

function effortToThinkingBudget(effort: ThinkEffort): number {
  if (effort === 'low') return 1024;
  if (effort === 'high') return 4096;
  return 2048;
}

function normalizeThinkSetting(think: ModelThinkSetting | undefined): { effort: ThinkEffort; budgetTokens?: number } | undefined {
  if (think === undefined || think === false) return undefined;

  if (typeof think === 'number') {
    if (!Number.isFinite(think) || think <= 0) return undefined;
    const budgetTokens = Math.floor(think);
    const effort: ThinkEffort = budgetTokens <= 1024
      ? 'low'
      : budgetTokens <= 4096
        ? 'medium'
        : 'high';
    return { effort, budgetTokens };
  }

  if (think === true) {
    return { effort: 'medium' };
  }

  return { effort: think };
}

function mergeProviderOption(
  target: Record<string, unknown>,
  providerKey: string,
  patch: Record<string, unknown>,
): void {
  const existing = target[providerKey];
  const nextBase = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  target[providerKey] = { ...nextBase, ...patch };
}

function supportsGoogleReasoningEffort(modelId: string | undefined): boolean {
  if (!modelId) return true;
  return /^gemini-2\.5(?:[.-].*)?$/i.test(modelId);
}

function inferReasoningModel(modelId: string | undefined): boolean | undefined {
  if (!modelId) return undefined;
  if (/^gpt-5(?:[.-].*)?(?:-codex)?$/i.test(modelId)) return true;
  if (/^gpt-4(?:[.-].*)?$/i.test(modelId)) return false;
  return undefined;
}

function isReasoningModel(providerName: string, modelId: string | undefined): boolean | undefined {
  const registered = modelId ? getRegisteredModel(providerName, modelId) : undefined;
  if (registered) return registered.reasoning;
  return inferReasoningModel(modelId);
}

export function resolveTemperature(
  providerName: string,
  modelId: string | undefined,
  requested?: number,
): number | undefined {
  if (requested === undefined) return undefined;
  return isReasoningModel(providerName, modelId) === true ? undefined : requested;
}

function applyGoogleThinkingConfig(
  providerOptions: Record<string, unknown>,
  normalized: { effort: ThinkEffort; budgetTokens?: number },
): void {
  const googleOptions = asPlainObject(providerOptions.google) ?? {};
  const extraBody = asPlainObject(googleOptions.extra_body) ?? {};
  const extraBodyGoogle = asPlainObject(extraBody.google) ?? {};
  const thinkingConfig = asPlainObject(extraBodyGoogle.thinking_config) ?? {};

  providerOptions.google = {
    ...googleOptions,
    extra_body: {
      ...extraBody,
      google: {
        ...extraBodyGoogle,
        thinking_config: {
          ...thinkingConfig,
          thinking_budget: normalized.budgetTokens ?? effortToThinkingBudget(normalized.effort),
        },
      },
    },
  };
}


function hasToolOptions(chatOptions: ChatOptions | undefined): boolean {
  return (chatOptions?.tools?.length ?? 0) > 0 || Object.keys(chatOptions?.mcpTools ?? {}).length > 0;
}

function appendToolCallIgnoredNotice(content: string): string {
  const cleaned = content.trim();
  return cleaned ? `${cleaned}\n\n${UNPARSABLE_TOOL_CALL_NOTICE}` : UNPARSABLE_TOOL_CALL_NOTICE;
}

function normalizeTextToolCallProtocol(
  content: string,
  chatOptions: ChatOptions | undefined,
  providerName: string,
  mode: 'stream' | 'non-stream',
): { content: string; toolCalls?: ToolCall[] } {
  if (!content) return { content };

  if (hasToolOptions(chatOptions)) {
    const legacy = extractLegacyToolCallsFromText(content);
    if (legacy) {
      logger.warn(
        { provider: providerName, mode, count: legacy.toolCalls.length },
        `Recovered legacy text tool-call protocol in ${mode} response`,
      );
      return { content: legacy.cleanedContent, toolCalls: legacy.toolCalls };
    }
  }

  if (hasDsmlToolCallMarkup(content)) {
    if (!hasToolOptions(chatOptions)) {
      // Text-only call (recovery, summarization, title generation): the model
      // tried to ACT instead of answering. Delivering a stripped "tool call
      // ignored" notice as the final answer buried a live production turn —
      // the recovery loop saw non-empty content and shipped it to the user
      // while the intended shell command silently never ran. Treat the whole
      // response as EMPTY so the caller's empty-content handling retries
      // (self-heal attempts → hard recovery, which explicitly states tools
      // are disabled) instead of presenting the notice as an answer.
      logger.error(
        { provider: providerName, mode, raw: content.slice(0, 2000) },
        'DSML tool-call markup in a text-only call; treating response as empty so the caller retries',
      );
      return { content: '' };
    }
    logger.error(
      { provider: providerName, mode, raw: content.slice(0, 2000) },
      'Unparsable DSML tool-call protocol emitted as text; stripped from visible response',
    );
    return { content: appendToolCallIgnoredNotice(stripDsmlToolCallMarkup(content)) };
  }

  return { content };
}

interface DsmlStreamState {
  holdback: string;
}

function findDsmlPartialPrefixStart(text: string): number {
  const idx = text.lastIndexOf('<|');
  if (idx === -1 || text.length - idx > 80) return -1;
  const suffix = text.slice(idx);
  return /^<\|[A-Z0-9_]*(?:\|[a-z_]*)?$/i.test(suffix) ? idx : -1;
}

function consumeCompleteDsmlPrefix(text: string): number {
  const toolCallsMatch = text.match(/^<\|([A-Z0-9_]+)\|tool_calls\b[^>]*>[\s\S]*?<\/\|\1\|tool_calls>/i);
  if (toolCallsMatch?.[0]) return toolCallsMatch[0].length;
  const invokeMatch = text.match(/^<\|([A-Z0-9_]+)\|invoke\b[\s\S]*?<\/\|\1\|invoke>/i);
  if (invokeMatch?.[0]) return invokeMatch[0].length;
  return 0;
}

function filterDsmlVisibleStreamDelta(state: DsmlStreamState, delta: string): string {
  state.holdback += delta;
  let visible = '';

  for (;;) {
    const dsmlStart = state.holdback.search(/<\|[A-Z0-9_]+\|(?:tool_calls|invoke|parameter)\b/i);
    if (dsmlStart === -1) {
      const partialStart = findDsmlPartialPrefixStart(state.holdback);
      if (partialStart === -1) {
        visible += state.holdback;
        state.holdback = '';
      } else {
        visible += state.holdback.slice(0, partialStart);
        state.holdback = state.holdback.slice(partialStart);
      }
      return visible;
    }

    visible += state.holdback.slice(0, dsmlStart);
    const candidate = state.holdback.slice(dsmlStart);
    const consumed = consumeCompleteDsmlPrefix(candidate);
    if (consumed === 0) {
      state.holdback = candidate;
      return visible;
    }
    state.holdback = candidate.slice(consumed);
  }
}

function flushDsmlVisibleStreamHoldback(state: DsmlStreamState): string {
  const pending = state.holdback;
  state.holdback = '';
  if (!pending) return '';
  if (pending.includes('<|')) {
    return '';
  }
  return pending;
}

function resolveEffectiveThink(
  providerName: string,
  chatOptions: ChatOptions | undefined,
  modelId?: string,
): ModelThinkSetting | undefined {
  if (chatOptions?.think !== undefined) return chatOptions.think;

  // Live probes confirm current DeepSeek reasoning models support thinking
  // across tool continuation turns. Keep explicit think=false as an operator
  // override, but never disable a capability merely because tools are present.
  if (providerName === 'deepseek' && isReasoningModel(providerName, modelId) === true) {
    return true;
  }

  return undefined;
}

export function applyThinkOption(
  options: Record<string, unknown>,
  providerName: string,
  think: ModelThinkSetting | undefined,
  modelId?: string,
): void {
  if (providerName === 'deepseek' && think === false) {
    const providerOptions = options.providerOptions && typeof options.providerOptions === 'object' && !Array.isArray(options.providerOptions)
      ? options.providerOptions as Record<string, unknown>
      : {};
    mergeProviderOption(providerOptions, 'deepseek', {
      thinking: { type: 'disabled' },
    });
    options.providerOptions = providerOptions;
    return;
  }

  const normalized = normalizeThinkSetting(think);
  if (!normalized) return;

  const providerOptions = options.providerOptions && typeof options.providerOptions === 'object' && !Array.isArray(options.providerOptions)
    ? options.providerOptions as Record<string, unknown>
    : {};

  if (providerName === 'anthropic') {
    mergeProviderOption(providerOptions, 'anthropic', {
      thinking: {
        type: 'enabled',
        budgetTokens: normalized.budgetTokens ?? effortToThinkingBudget(normalized.effort),
      },
    });
    options.providerOptions = providerOptions;
    return;
  }

  if (providerName === 'google') {
    if (supportsGoogleReasoningEffort(modelId)) {
      mergeProviderOption(providerOptions, 'google', { reasoningEffort: normalized.effort });
    } else {
      applyGoogleThinkingConfig(providerOptions, normalized);
    }
    options.providerOptions = providerOptions;
    return;
  }

  if (providerName === 'deepseek') {
    mergeProviderOption(providerOptions, 'deepseek', {
      thinking: { type: 'enabled' },
      reasoningEffort: normalized.budgetTokens && normalized.budgetTokens > 4096 ? 'max' : 'high',
    });
    options.providerOptions = providerOptions;
    return;
  }

  if (isReasoningModel(providerName, modelId) !== true) {
    return;
  }

  // OpenAI and OpenAI-compatible providers commonly support reasoningEffort on reasoning models.
  mergeProviderOption(providerOptions, providerName, { reasoningEffort: normalized.effort });
  if (providerName === 'openai' || providerName === 'openai-codex') {
    mergeProviderOption(providerOptions, 'openai', { reasoningEffort: normalized.effort });
  }
  options.providerOptions = providerOptions;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pricingSnapshot(providerName: string, modelId: string, cacheReadTokens?: number, cacheWriteTokens?: number) {
  const resolved = resolveModelPricing(providerName, modelId);
  const inputCost = resolved.inputCost;
  const outputCost = resolved.outputCost;
  const cacheReadCost = resolved.cacheReadCost;
  const cacheWriteCost = resolved.cacheWriteCost;
  const hasBasePricing = resolved.source !== 'unknown';
  const hasCompletePricing = hasBasePricing
    && (!(cacheReadTokens && cacheReadTokens > 0) || cacheReadCost !== undefined)
    && (!(cacheWriteTokens && cacheWriteTokens > 0) || cacheWriteCost !== undefined);
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    source: hasCompletePricing ? 'catalog_calculated' as const : 'unknown' as const,
    version: hasCompletePricing ? resolved.version : undefined,
  };
}

function recordUsageIfPresent(
  providerName: string,
  modelId: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
  chatOptions: ChatOptions | undefined,
  attempt: { durationMs: number; outcome: 'success' | 'failure' | 'partial'; failureCategory?: string },
): void {
  try {
    chatOptions?.usageCollector?.add(usage);
  } catch {
    // Collector is observability-only; never let it break the call path.
  }

  const billing = chatOptions?.billing;
  if (!billing?.tenantId) return;

  try {
    const pricing = pricingSnapshot(providerName, modelId, usage.cache_read_tokens, usage.cache_write_tokens);
    const estimatedCost = pricing.source === 'catalog_calculated'
      ? calculateCatalogCost(usage, pricing)
      : null;
    recordLlmCall({
      tenant_id: billing.tenantId,
      user_id: billing.userId,
      provider: providerName,
      model: modelId,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      cost_usd: estimatedCost ?? 0,
      input_cost_per_million: pricing.inputCost,
      output_cost_per_million: pricing.outputCost,
      cache_read_cost_per_million: pricing.cacheReadCost,
      cache_write_cost_per_million: pricing.cacheWriteCost,
      pricing_source: pricing.source,
      usage_status: 'provider_reported',
      price_version: pricing.version,
      currency: 'usd',
      outcome: attempt.outcome,
      failure_category: attempt.failureCategory,
      duration_ms: attempt.durationMs,
      task_id: billing.taskId,
      agent_id: billing.agentId,
    });
  } catch (err) {
    logger.warn({
      tenantId: billing.tenantId,
      modelId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to record LLM usage');
  }
}

function recordFailedAttempt(providerName: string, modelId: string, chatOptions: ChatOptions | undefined, startedAt: number, err: unknown): void {
  const billing = chatOptions?.billing;
  if (!billing?.tenantId) return;
  const pricing = pricingSnapshot(providerName, modelId);
  try {
    recordLlmCall({
      tenant_id: billing.tenantId,
      user_id: billing.userId,
      provider: providerName,
      model: modelId,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      input_cost_per_million: pricing.inputCost,
      output_cost_per_million: pricing.outputCost,
      pricing_source: pricing.source,
      usage_status: 'unavailable',
      price_version: pricing.version,
      currency: 'usd',
      outcome: 'failure',
      failure_category: err instanceof Error ? err.name : 'Error',
      duration_ms: Date.now() - startedAt,
      task_id: billing.taskId,
      agent_id: billing.agentId,
    });
  } catch (recordError) {
    logger.warn({ err: recordError instanceof Error ? recordError.message : String(recordError) }, 'Failed to record failed LLM attempt');
  }
}

// ---------------------------------------------------------------------------
// Shared AI SDK adapter — wraps any model factory into LLMClient
// ---------------------------------------------------------------------------

/**
 * Create an LLMClient backed by Vercel AI SDK.
 * Handles all provider differences (streaming, tool calling, message format)
 * through the AI SDK's provider-specific adapters.
 */
export function createAIAdapter(
  providerName: string,
  defaultModelId: string,
  getModelFactory: ModelFactory,
): LLMClient {
  // Resolved once so chat() and stream() can never drift apart on layout.
  const systemMessagePolicy = resolveSystemMessagePolicy(providerName);
  return {
    provider: providerName,

    getAIModel(modelId?: string) {
      return getModelFactory(modelId || defaultModelId);
    },

    async chat(messages: ChatMessage[], chatOptions?: ChatOptions): Promise<ChatResponse> {
      if (!messages || messages.length === 0) {
        throw new Error('chat() called with empty messages array — this is a bug in the caller');
      }
      const modelId = chatOptions?.model || defaultModelId;
      const callStartedAt = Date.now();
      const model = getModelFactory(modelId);
      const coreMessages = consolidateSystemMessages(toCoreMessages(messages), systemMessagePolicy);
      if (coreMessages.length === 0) {
        throw new Error('toCoreMessages() produced empty array from non-empty input — check message format');
      }

      const options: Parameters<typeof generateText>[0] = {
        model,
        messages: coreMessages,
        maxOutputTokens: resolveMaxOutputTokens(providerName, modelId, chatOptions?.max_tokens),
        temperature: resolveTemperature(providerName, modelId, chatOptions?.temperature),
      };
      applyThinkOption(options as Record<string, unknown>, providerName, resolveEffectiveThink(providerName, chatOptions, modelId), modelId);
      applyPromptCacheOptions(options as Record<string, unknown>, providerName, chatOptions);
      const abortSignal = resolveAbortSignal(chatOptions?.timeout_ms, chatOptions?.abort_signal);
      if (abortSignal) {
        (options as Record<string, unknown>).abortSignal = abortSignal;
      }

      if (chatOptions?.tools && chatOptions.tools.length > 0) {
        const moziTools = toAITools(chatOptions.tools, providerName);
        const mcpTools = chatOptions?.mcpTools ?? {};
        (options as Record<string, unknown>).tools = { ...moziTools, ...mcpTools };
      } else if (chatOptions?.mcpTools && Object.keys(chatOptions.mcpTools).length > 0) {
        (options as Record<string, unknown>).tools = chatOptions.mcpTools;
      }

      let result;
      try {
        result = await generateText(options);
      } catch (err) {
        recordFailedAttempt(providerName, modelId, chatOptions, callStartedAt, err);
        throw err;
      }

      const response: ChatResponse = {
        content: result.text || '',
        reasoning_content: result.reasoningText,
        usage: {
          input_tokens: result.usage?.inputTokens ?? 0,
          output_tokens: result.usage?.outputTokens ?? 0,
          cache_read_tokens: result.usage?.inputTokenDetails?.cacheReadTokens ?? result.usage?.cachedInputTokens,
          cache_write_tokens: result.usage?.inputTokenDetails?.cacheWriteTokens,
        },
        model: modelId,
        stop_reason: result.finishReason,
      };

      if (result.toolCalls && result.toolCalls.length > 0) {
        response.tool_calls = fromAIToolCalls(
          result.toolCalls as Array<{ toolCallId: string; toolName: string; input: unknown }>,
        );
        if (hasDsmlToolCallMarkup(response.content)) {
          response.content = stripDsmlToolCallMarkup(response.content);
        }
      } else {
        const normalized = normalizeTextToolCallProtocol(response.content, chatOptions, providerName, 'non-stream');
        response.content = normalized.content;
        if (normalized.toolCalls) response.tool_calls = normalized.toolCalls;
      }

      recordUsageIfPresent(providerName, modelId, response.usage, chatOptions, { durationMs: Date.now() - callStartedAt, outcome: 'success' });
      return response;
    },

    async *chatStream(messages: ChatMessage[], chatOptions?: ChatOptions): AsyncGenerator<StreamChunk> {
      if (!messages || messages.length === 0) {
        throw new Error('chatStream() called with empty messages array — this is a bug in the caller');
      }
      const modelId = chatOptions?.model || defaultModelId;
      const callStartedAt = Date.now();
      const model = getModelFactory(modelId);
      const coreMessages = consolidateSystemMessages(toCoreMessages(messages), systemMessagePolicy);
      if (coreMessages.length === 0) {
        throw new Error('toCoreMessages() produced empty array from non-empty input — check message format');
      }

      const options: Parameters<typeof streamText>[0] = {
        model,
        messages: coreMessages,
        maxOutputTokens: resolveMaxOutputTokens(providerName, modelId, chatOptions?.max_tokens),
        temperature: resolveTemperature(providerName, modelId, chatOptions?.temperature),
      };
      applyThinkOption(options as Record<string, unknown>, providerName, resolveEffectiveThink(providerName, chatOptions, modelId), modelId);
      applyPromptCacheOptions(options as Record<string, unknown>, providerName, chatOptions);
      const abortSignal = resolveAbortSignal(chatOptions?.timeout_ms, chatOptions?.abort_signal);
      if (abortSignal) {
        (options as Record<string, unknown>).abortSignal = abortSignal;
      }

      if (chatOptions?.tools && chatOptions.tools.length > 0) {
        const moziTools = toAITools(chatOptions.tools, providerName);
        const mcpTools = chatOptions?.mcpTools ?? {};
        (options as Record<string, unknown>).tools = { ...moziTools, ...mcpTools };
      } else if (chatOptions?.mcpTools && Object.keys(chatOptions.mcpTools).length > 0) {
        (options as Record<string, unknown>).tools = chatOptions.mcpTools;
      }

      let result;
      try {
        result = streamText(options);
      } catch (err) {
        recordFailedAttempt(providerName, modelId, chatOptions, callStartedAt, err);
        throw err;
      }
      let fullContent = '';
      let fullReasoning = '';
      const dsmlStreamState: DsmlStreamState = { holdback: '' };
      const deltaSnapshots = new Map<string, string>();
      const terminalStreamTypes = new Set(['done', 'response-end', 'response-complete']);
      let streamClosed = false;
      let streamError: unknown;
      let yieldedAnyChunk = false;

      try {
        for await (const part of result.fullStream) {
          const partType = typeof (part as { type?: unknown }).type === 'string'
            ? (part as { type: string }).type
            : '';

          if (terminalStreamTypes.has(partType)) {
            streamClosed = true;
            continue;
          }

          if (partType === 'error') {
            // The AI SDK surfaces provider failures (auth errors, quota, bad
            // endpoint) as an `error` part — the iteration itself completes
            // normally. Capture it so the empty-stream path below fails loudly
            // instead of returning an empty response that looks like success.
            const errPart = (part as { error?: unknown }).error;
            streamError = normalizeProviderError(errPart ?? 'stream error part');
            continue;
          }

          if (partType === 'reasoning-delta') {
            const reasoningDelta = typeof (part as { delta?: unknown }).delta === 'string'
              ? (part as { delta: string }).delta
              : typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '';
            if (reasoningDelta) {
              fullReasoning += reasoningDelta;
            }
            continue;
          }

          if (partType === 'tool-input-start') {
            const toolPart = part as { id?: unknown; toolCallId?: unknown; toolName?: unknown };
            const toolCallId = typeof toolPart.id === 'string'
              ? toolPart.id
              : typeof toolPart.toolCallId === 'string'
                ? toolPart.toolCallId
                : '';
            const toolName = typeof toolPart.toolName === 'string' ? toolPart.toolName : '';
            if (toolCallId && toolName) {
              yieldedAnyChunk = true;
              yield { type: 'tool_input_start', toolCallId, toolName };
            }
            continue;
          }

          if (partType === 'tool-input-delta') {
            const toolPart = part as { id?: unknown; toolCallId?: unknown; delta?: unknown; inputTextDelta?: unknown };
            const toolCallId = typeof toolPart.id === 'string'
              ? toolPart.id
              : typeof toolPart.toolCallId === 'string'
                ? toolPart.toolCallId
                : '';
            const delta = typeof toolPart.delta === 'string'
              ? toolPart.delta
              : typeof toolPart.inputTextDelta === 'string'
                ? toolPart.inputTextDelta
                : '';
            if (toolCallId && delta) {
              yieldedAnyChunk = true;
              yield { type: 'tool_input_delta', toolCallId, delta };
            }
            continue;
          }

          if (partType === 'tool-input-end') {
            const toolPart = part as { id?: unknown; toolCallId?: unknown };
            const toolCallId = typeof toolPart.id === 'string'
              ? toolPart.id
              : typeof toolPart.toolCallId === 'string'
                ? toolPart.toolCallId
                : '';
            if (toolCallId) {
              yieldedAnyChunk = true;
              yield { type: 'tool_input_end', toolCallId };
            }
            continue;
          }

          if (streamClosed || partType !== 'text-delta') {
            continue;
          }

          const deltaId = (() => {
            const candidate = part as { id?: unknown; deltaId?: unknown };
            if (typeof candidate.deltaId === 'string' && candidate.deltaId.length > 0) {
              return candidate.deltaId;
            }
            if (typeof candidate.id === 'string' && candidate.id.length > 0) {
              return candidate.id;
            }
            return undefined;
          })();

          if (partType === 'text-delta') {
            // AI SDK v6 fullStream uses `text`; keep a legacy fallback for `delta`
            // to avoid corrupt output when providers/proxies diverge.
            const textPart = part as { text?: unknown; delta?: unknown };
            const textDelta = typeof textPart.text === 'string'
              ? textPart.text
              : textPart.delta;
            if (typeof textDelta !== 'string' || textDelta.length === 0) {
              continue;
            }
            let appendText = textDelta;

            // Provider compatibility:
            // - duplicate retransmit: same id + same text => skip
            // - cumulative snapshot: same id + growing text => append only suffix
            // - chunk stream with reused id: same id + unrelated text => append chunk as-is
            if (deltaId) {
              const previous = deltaSnapshots.get(deltaId);
              if (previous !== undefined) {
                if (textDelta === previous) {
                  continue;
                }
                if (textDelta.startsWith(previous)) {
                  appendText = textDelta.slice(previous.length);
                  deltaSnapshots.set(deltaId, textDelta);
                  if (appendText.length === 0) {
                    continue;
                  }
                } else if (previous.startsWith(textDelta)) {
                  // Out-of-order shorter snapshot; ignore.
                  continue;
                } else {
                  deltaSnapshots.set(deltaId, textDelta);
                }
              } else {
                deltaSnapshots.set(deltaId, textDelta);
              }
            }

            fullContent += appendText;
            const visibleText = filterDsmlVisibleStreamDelta(dsmlStreamState, appendText);
            if (visibleText) {
              yieldedAnyChunk = true;
              yield { type: 'text', text: visibleText };
            }
          }
        }
      } catch (streamErr) {
        // API error during streaming.
        // Keep accumulated text if any (best-effort partial response), but if nothing
        // was produced we must propagate the upstream failure to avoid misclassifying
        // it as a generic "empty_response" in gateway.
        streamError = streamErr;
        logger.warn({ error: streamErr instanceof Error ? streamErr.message : String(streamErr) }, 'Stream iteration error');
      }

      // AI SDK rejects these promises when no "step" was recorded (e.g. provider SSE format mismatch)
      let resolvedToolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
      let resolvedUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } = { inputTokens: 0, outputTokens: 0 };
      let usageStatus: ChatResponse['usage_status'] = 'unavailable';
      let resolvedFinishReason: string | null = null;
      let resolvedReasoningText: string | undefined;

      const [toolCallsResult, usageResult, finishReasonResult, reasoningTextResult] = await Promise.allSettled([
        result.toolCalls,
        result.usage,
        result.finishReason,
        result.reasoningText,
      ]);

      if (toolCallsResult.status === 'fulfilled') {
        resolvedToolCalls = (toolCallsResult.value ?? []) as typeof resolvedToolCalls;
      }
      if (usageResult.status === 'fulfilled') {
        const u = usageResult.value;
        resolvedUsage = {
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens,
          cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens,
        };
        usageStatus = 'reported';
      }
      if (finishReasonResult.status === 'fulfilled') {
        resolvedFinishReason = finishReasonResult.value;
      }
      if (reasoningTextResult.status === 'fulfilled') {
        resolvedReasoningText = reasoningTextResult.value || (fullReasoning.length > 0 ? fullReasoning : undefined);
      }

      const rejectedStreamPromises = [toolCallsResult, usageResult, finishReasonResult, reasoningTextResult]
        .filter((settled): settled is PromiseRejectedResult => settled.status === 'rejected');
      if (rejectedStreamPromises.length > 0) {
        logger.warn({
          modelId,
          providerName,
          errors: rejectedStreamPromises.map((settled) => ({
            errorName: settled.reason instanceof Error ? settled.reason.name : 'unknown',
            errorMessage: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
            errorCause: settled.reason instanceof Error && settled.reason.cause ? String(settled.reason.cause) : undefined,
          })),
          hasStreamError: !!streamError,
          streamErrorMsg: streamError instanceof Error ? streamError.message : undefined,
          accumulatedContentLen: fullContent.length,
          messagesCount: coreMessages.length,
        }, 'Stream produced no recordable steps, using accumulated content');
      }
      if (!resolvedReasoningText && fullReasoning.length > 0) {
        resolvedReasoningText = fullReasoning;
      }

      // Fallback for providers whose failure never appears as a thrown
      // iteration error OR an `error` part: if every stream promise rejected
      // and the stream produced nothing at all, the call failed — propagate
      // the underlying cause instead of returning an empty "success".
      if (
        !streamError
        && rejectedStreamPromises.length > 0
        && !yieldedAnyChunk
        && fullContent.length === 0
        && resolvedToolCalls.length === 0
        && fullReasoning.length === 0
      ) {
        const reason = rejectedStreamPromises[0].reason;
        const cause = reason instanceof Error && reason.cause instanceof Error ? reason.cause : undefined;
        streamError = cause ?? (reason instanceof Error ? reason : new Error(String(reason)));
      }

      if (streamError) {
        if (!yieldedAnyChunk && fullContent.length === 0 && resolvedToolCalls.length === 0 && fullReasoning.length === 0) {
          if (streamError instanceof Error) {
            throw streamError;
          }
          throw new Error(String(streamError));
        }

        const partialResponse: ChatResponse = {
          content: fullContent,
          reasoning_content: resolvedReasoningText,
          usage: {
            input_tokens: resolvedUsage.inputTokens ?? 0,
            output_tokens: resolvedUsage.outputTokens ?? 0,
            cache_read_tokens: resolvedUsage.cacheReadTokens,
            cache_write_tokens: resolvedUsage.cacheWriteTokens,
          },
          model: modelId,
          stop_reason: resolvedFinishReason,
          incomplete: true,
          truncated: true,
          incomplete_reason: streamError instanceof Error ? streamError.message : String(streamError),
          usage_status: usageStatus,
        };
        if (resolvedToolCalls.length > 0) {
          partialResponse.tool_calls = fromAIToolCalls(resolvedToolCalls);
        }
        recordUsageIfPresent(providerName, modelId, partialResponse.usage, chatOptions, {
          durationMs: Date.now() - callStartedAt,
          outcome: yieldedAnyChunk || fullContent.length > 0 ? 'partial' : 'failure',
          failureCategory: streamError instanceof Error ? streamError.name : 'Error',
        });
        throw new IncompleteStreamError('LLM stream ended before completion', partialResponse, streamError);
      }

      const trailingVisibleText = flushDsmlVisibleStreamHoldback(dsmlStreamState);
      if (trailingVisibleText) {
        yield { type: 'text', text: trailingVisibleText };
      }

      const response: ChatResponse = {
        content: fullContent,
        reasoning_content: resolvedReasoningText,
        usage: {
          input_tokens: resolvedUsage.inputTokens ?? 0,
          output_tokens: resolvedUsage.outputTokens ?? 0,
          cache_read_tokens: resolvedUsage.cacheReadTokens,
          cache_write_tokens: resolvedUsage.cacheWriteTokens,
        },
        model: modelId,
        stop_reason: resolvedFinishReason,
        usage_status: usageStatus,
      };

      if (resolvedToolCalls.length > 0) {
        response.tool_calls = fromAIToolCalls(resolvedToolCalls);
        if (hasDsmlToolCallMarkup(response.content)) {
          response.content = stripDsmlToolCallMarkup(response.content);
        }
      } else {
        const normalized = normalizeTextToolCallProtocol(fullContent, chatOptions, providerName, 'stream');
        response.content = normalized.content;
        if (normalized.toolCalls) response.tool_calls = normalized.toolCalls;
      }

      recordUsageIfPresent(providerName, modelId, response.usage, chatOptions, { durationMs: Date.now() - callStartedAt, outcome: 'success' });
      yield { type: 'done', response };
    },
  };
}
