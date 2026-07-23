/**
 * Model Factory — creates AI SDK LanguageModel instances for each provider.
 *
 * Routes provider API modes to the correct AI SDK adapter:
 * - anthropic → @ai-sdk/anthropic
 * - openai-responses/codex → @ai-sdk/openai
 * - google/bedrock/ollama/openai-compat → @ai-sdk/openai-compatible
 */

import { generateText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  getModel as getRegisteredModel,
  getProvider,
  type ProviderApiMode,
} from './providers.js';
import { createCliAdapter } from './llm-cli.js';
import type { ChatMessage } from './llm-contracts.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:llm' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelFactory = (modelId: string) => Parameters<typeof generateText>[0]['model'];
type LanguageModelV3 = Extract<LanguageModel, { readonly specificationVersion: 'v3' }>;
type LanguageModelV3Prompt = Parameters<LanguageModelV3['doGenerate']>[0]['prompt'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve max output tokens, capping against registered model limit. */
export function resolveMaxOutputTokens(providerId: string, modelId: string, requested?: number): number {
  const normalizedRequested = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : undefined;
  const modelLimit = getRegisteredModel(providerId, modelId)?.maxOutputTokens;
  if (modelLimit && normalizedRequested) {
    return Math.min(modelLimit, normalizedRequested);
  }
  return normalizedRequested ?? modelLimit ?? 4096;
}

/** Create a ModelFactory for the given provider + API mode. */
export function createModelFactory(params: {
  providerId: string;
  apiMode: ProviderApiMode;
  apiKey: string;
  baseUrl: string;
}): ModelFactory {
  const { providerId, apiMode, apiKey, baseUrl } = params;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  switch (apiMode) {
    case 'anthropic': {
      if (providerId === 'minimax') {
        const isMiniMaxDomain = normalizedBaseUrl.includes('minimax.io')
          || normalizedBaseUrl.includes('minimaxi.com')
          || normalizedBaseUrl.includes('minimax.chat');
        if (isMiniMaxDomain) {
          const anthropicUrl = resolveMiniMaxAnthropicUrl(normalizedBaseUrl);
          logger.info({ baseUrl: normalizedBaseUrl, anthropicUrl }, 'MiniMax: using Anthropic adapter');
          return (modelId) => createAnthropic({ apiKey, baseURL: anthropicUrl })(modelId);
        }
      }
      return (modelId) => createAnthropic({ apiKey, baseURL: normalizedBaseUrl })(modelId);
    }

    case 'openai-responses':
    case 'openai-codex-responses':
      if (providerId === 'openai' || providerId === 'openai-codex') {
        return (modelId) => createOpenAI({ apiKey, baseURL: normalizedBaseUrl })(modelId);
      }
      return createOpenAICompatModelFactory(providerId, apiKey, normalizedBaseUrl);

    case 'google-generative-ai':
      return createOpenAICompatModelFactory(providerId, apiKey, toOpenAICompatBaseUrl(normalizedBaseUrl));

    case 'bedrock-converse-stream':
      return createOpenAICompatModelFactory(providerId, apiKey, normalizedBaseUrl, { stripToolChoice: true });

    case 'ollama-native':
      return createOpenAICompatModelFactory(providerId, apiKey, toOpenAICompatBaseUrl(normalizedBaseUrl), { stripToolChoice: true });

    case 'cli-pipe':
      return createCliPipeModelFactory(providerId);

    case 'openai-compat':
    default:
      return createOpenAICompatModelFactory(providerId, apiKey, normalizedBaseUrl);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function toOpenAICompatBaseUrl(baseUrl: string): string {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (!trimmed) return '';
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function resolveMiniMaxAnthropicUrl(baseUrl: string): string {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (trimmed.includes('/anthropic/')) {
    return trimmed;
  }
  return trimmed.replace(/\/v1$/i, '/anthropic/v1');
}

function cliPromptToChatMessages(prompt: LanguageModelV3Prompt): ChatMessage[] {
  return prompt.map((message): ChatMessage => {
    if (message.role === 'system') {
      return { role: 'system', content: message.content };
    }

    const content: string[] = [];
    for (const part of message.content) {
      if (part.type === 'text' || part.type === 'reasoning') {
        content.push(part.text);
      } else if (part.type === 'tool-call') {
        content.push(`[TOOL_CALL name=${part.toolName} id=${part.toolCallId}]\n${JSON.stringify(part.input)}`);
      } else if (part.type === 'tool-result') {
        content.push(`[TOOL_RESULT name=${part.toolName} id=${part.toolCallId}]\n${JSON.stringify(part.output)}`);
      } else if (part.type === 'tool-approval-response') {
        content.push(`[TOOL_APPROVAL id=${part.approvalId} approved=${part.approved}]${part.reason ? `\n${part.reason}` : ''}`);
      } else if (part.type === 'file') {
        throw new Error('CLI-pipe model bridge does not support file prompt parts');
      }
    }

    return {
      role: message.role,
      content: content.join('\n\n'),
    };
  });
}

function createCliPipeModelFactory(providerId: string): ModelFactory {
  const provider = getProvider(providerId);
  if (!provider?.cliBackend || !['codex-cli', 'claude-cli'].includes(providerId)) {
    throw new Error(`CLI-pipe model bridge is not available for provider "${providerId}"`);
  }

  return (modelId): LanguageModelV3 => {
    const client = createCliAdapter(providerId, modelId, provider.cliBackend!);

    const doGenerate: LanguageModelV3['doGenerate'] = async (options) => {
      const response = await client.chat(cliPromptToChatMessages(options.prompt), {
        model: modelId,
        timeout_ms: provider.cliBackend!.timeoutMs,
        execution_scope: 'background',
        abort_signal: options.abortSignal,
      });
      const usage = {
        inputTokens: {
          total: response.usage.input_tokens,
          noCache: response.usage.input_tokens,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: response.usage.output_tokens,
          text: response.usage.output_tokens,
          reasoning: undefined,
        },
      };

      return {
        content: response.content ? [{ type: 'text' as const, text: response.content }] : [],
        finishReason: { unified: 'stop' as const, raw: response.stop_reason ?? undefined },
        usage,
        warnings: options.tools?.length
          ? [{ type: 'unsupported' as const, feature: 'tools', details: 'The external CLI agent owns its tool loop.' }]
          : [],
        response: { modelId },
      };
    };

    return {
      specificationVersion: 'v3',
      provider: providerId,
      modelId,
      supportedUrls: {},
      doGenerate,
      async doStream(options) {
        const result = await doGenerate(options);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: result.warnings });
              const text = result.content.find(part => part.type === 'text');
              if (text?.type === 'text') {
                controller.enqueue({ type: 'text-start', id: 'cli-output' });
                controller.enqueue({ type: 'text-delta', id: 'cli-output', delta: text.text });
                controller.enqueue({ type: 'text-end', id: 'cli-output' });
              }
              controller.enqueue({
                type: 'finish',
                usage: result.usage,
                finishReason: result.finishReason,
              });
              controller.close();
            },
          }),
        };
      },
    };
  };
}

function createOpenAICompatModelFactory(
  providerId: string,
  apiKey: string,
  baseUrl: string,
  options: { stripToolChoice?: boolean } = {},
): ModelFactory {
  const stripToolChoice = options.stripToolChoice ?? true;
  return (modelId) => createOpenAICompatible({
    name: providerId,
    apiKey,
    baseURL: normalizeBaseUrl(baseUrl),
    transformRequestBody: (body: Record<string, unknown>) => {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        if (stripToolChoice && key === 'tool_choice') continue;
        cleaned[key] = value;
      }
      return cleaned;
    },
  }).chatModel(modelId);
}
