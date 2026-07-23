/**
 * Provider Catalog — Static provider/model definitions.
 *
 * Pure data + pure functions. No I/O, no side effects.
 * This module is the single source of truth for provider metadata.
 */

import type { ModelDef, ProviderDef, ProviderApiMode, CliBackendConfig, SystemMessagePolicy } from './providers.js';

// ---------------------------------------------------------------------------
// Internal helpers (used only by defineProvider / catalog construction)
// ---------------------------------------------------------------------------

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = (value || '').trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function derivePrefixFromEnvKey(envKey: string): string | undefined {
  const key = envKey.trim().toUpperCase();
  const apiKeyMatch = /^(.*)_API_KEY$/.exec(key);
  if (apiKeyMatch?.[1]) {
    return apiKeyMatch[1];
  }
  const keyMatch = /^(.*)_KEY$/.exec(key);
  if (keyMatch?.[1]) {
    return keyMatch[1];
  }
  return undefined;
}

function defaultPrefixForProvider(providerId: string): string {
  return providerId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

// ---------------------------------------------------------------------------
// Exported helpers (used by providers.ts public API and legacy-migration.ts)
// ---------------------------------------------------------------------------

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseApiKeysList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map(v => v.trim())
    .filter(Boolean);
}

export function resolveNumberedApiKeys(prefix: string, env: NodeJS.ProcessEnv): string[] {
  const regex = new RegExp(`^${escapeRegex(prefix)}_API_KEY_(\\d+)$`);
  return Object.entries(env)
    .map(([key, value]) => {
      const match = regex.exec(key);
      if (!match) return null;
      const index = Number.parseInt(match[1] || '', 10);
      const trimmed = (value || '').trim();
      if (!Number.isFinite(index) || index <= 0 || !trimmed) {
        return null;
      }
      return { index, key, value: trimmed };
    })
    .filter((entry): entry is { index: number; key: string; value: string } => Boolean(entry))
    .sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return a.key.localeCompare(b.key);
    })
    .map(entry => entry.value);
}

export function resolveForwardCompatModel(def: ProviderDef, modelId: string): ModelDef | undefined {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId || !def.forwardCompat || def.forwardCompat.length === 0) {
    return undefined;
  }

  for (const rule of def.forwardCompat) {
    if (!rule.pattern.test(trimmedModelId)) {
      continue;
    }
    const template = def.models.find(m => m.id === rule.templateModel);
    if (!template) {
      continue;
    }
    return {
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Model / Provider factory helpers
// ---------------------------------------------------------------------------

interface ProviderDefInput {
  id: string;
  name: string;
  envKey: string;
  baseUrl: string;
  apiMode: ProviderApiMode;
  defaultModel: string;
  models: ModelDef[];
  systemMessagePolicy?: SystemMessagePolicy;
  hint?: string;
  placeholder?: string;
  regions?: Array<{ id: string; name: string; baseUrl: string }>;
  env?: Partial<{
    primaryKey: string;
    keyAliases: string[];
    keyPrefixes: string[];
    baseUrlKeys: string[];
  }>;
  forwardCompat?: Array<{ pattern: RegExp; templateModel: string }>;
  autoDetect?: boolean;
  cliBackend?: CliBackendConfig;
}

function model(input: {
  id: string;
  name: string;
  tier: 'high' | 'mid' | 'low';
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  reasoning?: boolean;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  cacheReadCostPer1M?: number;
}): ModelDef {
  return {
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    reasoning: false,
    ...input,
  };
}

function defineProvider(input: ProviderDefInput): ProviderDef {
  const canonicalPrefix = derivePrefixFromEnvKey(input.envKey) || defaultPrefixForProvider(input.id);
  const providerIdPrefix = defaultPrefixForProvider(input.id);
  const keyPrefixes = uniqueStrings([
    ...(input.env?.keyPrefixes ?? []),
    canonicalPrefix,
    providerIdPrefix,
  ]);

  const baseUrlKeys = uniqueStrings([
    ...(input.env?.baseUrlKeys ?? []),
    ...keyPrefixes.map(prefix => `${prefix}_BASE_URL`),
  ]);

  return {
    ...input,
    envKey: input.envKey,
    apiType: input.apiMode,
    env: {
      primaryKey: input.env?.primaryKey || input.envKey,
      keyAliases: uniqueStrings(input.env?.keyAliases ?? []),
      keyPrefixes,
      baseUrlKeys,
    },
    autoDetect: input.autoDetect ?? true,
    cliBackend: input.cliBackend,
  };
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

export const PROVIDERS: Record<string, ProviderDef> = {
  openai: defineProvider({
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    apiMode: 'openai-responses',
    // Verified: the Responses/Chat API accepts interleaved system messages;
    // preserving them keeps mid-turn directives at the tail so provider-side
    // prefix caches survive the tool loop (2026-07 cache regression).
    systemMessagePolicy: 'preserve-interleaved',
    defaultModel: 'gpt-4.1',
    placeholder: 'sk-...',
    hint: 'GPT-4.1, GPT-5',
    models: [
      model({
        id: 'gpt-4.1', name: 'GPT-4.1', tier: 'high',
        contextWindow: 1_047_576, maxOutputTokens: 32_768,
        supportsVision: true,
        inputCostPer1M: 2.0, outputCostPer1M: 8.0,
      }),
      model({
        id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tier: 'low',
        contextWindow: 1_047_576, maxOutputTokens: 32_768,
        supportsVision: true,
        inputCostPer1M: 0.4, outputCostPer1M: 1.6,
      }),
      model({
        id: 'gpt-5', name: 'GPT-5', tier: 'high',
        contextWindow: 400_000, maxOutputTokens: 32_768,
        supportsVision: true, reasoning: true,
      }),
    ],
    forwardCompat: [
      { pattern: /^gpt-5(?:[.-].*)?$/i, templateModel: 'gpt-5' },
      { pattern: /^gpt-4(?:[.-].*)?$/i, templateModel: 'gpt-4.1' },
    ],
  }),

  'openai-codex': defineProvider({
    id: 'openai-codex',
    name: 'OpenAI Codex',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    apiMode: 'openai-codex-responses',
    // Verified: the Responses/Chat API accepts interleaved system messages;
    // preserving them keeps mid-turn directives at the tail so provider-side
    // prefix caches survive the tool loop (2026-07 cache regression).
    systemMessagePolicy: 'preserve-interleaved',
    defaultModel: 'gpt-5-codex',
    placeholder: 'sk-...',
    hint: 'GPT-5 Codex',
    models: [
      model({
        id: 'gpt-5-codex', name: 'GPT-5 Codex', tier: 'high',
        contextWindow: 400_000, maxOutputTokens: 32_768,
        supportsVision: false, reasoning: true,
      }),
    ],
    autoDetect: false,
    forwardCompat: [
      { pattern: /^gpt-5(?:[.-].*)?-codex$/i, templateModel: 'gpt-5-codex' },
    ],
  }),

  anthropic: defineProvider({
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    apiMode: 'anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    placeholder: 'sk-ant-...',
    hint: 'Claude Fable 5, Opus 4, Sonnet 4',
    models: [
      model({
        // Claude Fable 5 — Mythos-class, most capable generally-available Claude.
        // Pricing is a best-effort estimate (premium tier); adjust when published.
        id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 64_000,
        supportsVision: true, reasoning: true,
        inputCostPer1M: 15.0, outputCostPer1M: 75.0,
      }),
      model({
        id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 16_000,
        supportsVision: true,
        inputCostPer1M: 3.0, outputCostPer1M: 15.0,
      }),
      model({
        id: 'claude-opus-4-20250514', name: 'Claude Opus 4', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 16_000,
        supportsVision: true,
        inputCostPer1M: 15.0, outputCostPer1M: 75.0,
      }),
    ],
    forwardCompat: [
      { pattern: /^claude-sonnet-4(?:[.-].*)?$/i, templateModel: 'claude-sonnet-4-20250514' },
      { pattern: /^claude-opus-4(?:[.-].*)?$/i, templateModel: 'claude-opus-4-20250514' },
      { pattern: /^claude-fable-5(?:[.-].*)?$/i, templateModel: 'claude-fable-5' },
      { pattern: /^claude-(sonnet|opus|fable|mythos)-5(?:[.-].*)?$/i, templateModel: 'claude-fable-5' },
    ],
  }),

  minimax: defineProvider({
    id: 'minimax',
    name: 'MiniMax',
    envKey: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    apiMode: 'anthropic',
    defaultModel: 'MiniMax-M3',
    placeholder: 'eyJ...',
    hint: 'MiniMax-M3',
    regions: [
      { id: 'global', name: 'Global (api.minimax.io)', baseUrl: 'https://api.minimax.io/anthropic/v1' },
      { id: 'cn', name: 'China (api.minimaxi.com)', baseUrl: 'https://api.minimaxi.com/anthropic/v1' },
      { id: 'proxy', name: 'Proxy / third-party', baseUrl: '' },
    ],
    models: [
      // Official 1M context, but requests above 512K bill at 2x — the practical
      // budget for cost-sensitive callers is the standard-rate 512K tier.
      model({
        id: 'MiniMax-M3', name: 'MiniMax M3', tier: 'high',
        contextWindow: 1_048_576, maxOutputTokens: 16_384,
        supportsVision: true,
        inputCostPer1M: 0.6, outputCostPer1M: 2.4,
      }),
      model({
        id: 'MiniMax-M2.5', name: 'MiniMax M2.5', tier: 'high',
        contextWindow: 1_000_000, maxOutputTokens: 16_384,
        supportsVision: false,
        inputCostPer1M: 1.0, outputCostPer1M: 5.0,
      }),
    ],
    forwardCompat: [
      { pattern: /^minimax-[a-z0-9.-]+$/i, templateModel: 'MiniMax-M2.5' },
      { pattern: /^minimax\/[a-z0-9.-]+$/i, templateModel: 'MiniMax-M2.5' },
    ],
  }),

  deepseek: defineProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    apiMode: 'openai-compat',
    // DeepSeek accepts mid-array system messages over HTTP, but its server
    // template kills prefix-cache reuse past the head once one appears in a
    // tool loop (probed live 2026-07-20: byte-identical requests, cache capped
    // at the pre-loop head; full reuse with the same content as user role).
    // So: keep positions, demote mid-array system to user at the adapter.
    systemMessagePolicy: 'interleaved-as-user',
    defaultModel: 'deepseek-v4-flash',
    placeholder: 'sk-...',
    hint: 'DeepSeek V4 Flash/Pro',
    models: [
      // DeepSeek advertises larger output maxima; this field is also MOZI's default max_tokens,
      // so keep the default cap practical unless callers explicitly request more.
      model({
        id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'mid',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        reasoning: true,
        inputCostPer1M: 0.14, outputCostPer1M: 0.28, cacheReadCostPer1M: 0.0028,
      }),
      model({
        id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'high',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        reasoning: true,
        inputCostPer1M: 0.435, outputCostPer1M: 0.87, cacheReadCostPer1M: 0.003625,
      }),
      model({
        id: 'deepseek-chat', name: 'DeepSeek Chat (deprecated alias)', tier: 'mid',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        inputCostPer1M: 0.14, outputCostPer1M: 0.28, cacheReadCostPer1M: 0.0028,
      }),
      model({
        id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (deprecated alias)', tier: 'mid',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        reasoning: true,
        inputCostPer1M: 0.14, outputCostPer1M: 0.28, cacheReadCostPer1M: 0.0028,
      }),
    ],
    forwardCompat: [
      { pattern: /^deepseek-v4-flash(?:[.-].*)?$/i, templateModel: 'deepseek-v4-flash' },
      { pattern: /^deepseek-v4-pro(?:[.-].*)?$/i, templateModel: 'deepseek-v4-pro' },
      { pattern: /^deepseek-(chat|reasoner)(?:[.-].*)?$/i, templateModel: 'deepseek-v4-flash' },
    ],
  }),

  moonshot: defineProvider({
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiMode: 'openai-compat',
    defaultModel: 'kimi-k2.6',
    placeholder: 'sk-...',
    hint: 'Kimi K2.6',
    models: [
      // Kimi K2 models reject any temperature other than the default
      // ("invalid temperature: only 1 is allowed for this model"), so they are
      // flagged `reasoning: true` — the operational meaning of that flag is
      // "do not send temperature" (see resolveTemperature in llm.ts).
      model({
        id: 'kimi-k2.6', name: 'Kimi K2.6', tier: 'high',
        contextWindow: 256_000, maxOutputTokens: 8_192, reasoning: true,
        inputCostPer1M: 0.95, outputCostPer1M: 4.0,
      }),
      model({
        id: 'kimi-k2.5', name: 'Kimi K2.5', tier: 'high',
        contextWindow: 256_000, maxOutputTokens: 8_192, reasoning: true,
      }),
      model({
        id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', tier: 'high',
        contextWindow: 256_000, maxOutputTokens: 8_192, reasoning: true,
      }),
    ],
    forwardCompat: [
      { pattern: /^kimi-[a-z0-9.-]+$/i, templateModel: 'kimi-k2.6' },
      { pattern: /^moonshot-[a-z0-9.-]+$/i, templateModel: 'kimi-k2.6' },
    ],
  }),

  google: defineProvider({
    id: 'google',
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiMode: 'google-generative-ai',
    defaultModel: 'gemini-2.5-flash',
    placeholder: 'AIza...',
    hint: 'Gemini 2.5 Flash/Pro, 3.1 Flash-Lite',
    env: {
      keyAliases: ['GOOGLE_API_KEY'],
      keyPrefixes: ['GEMINI', 'GOOGLE'],
    },
    models: [
      model({
        id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'mid',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        supportsVision: true,
        inputCostPer1M: 0.15, outputCostPer1M: 0.6,
      }),
      model({
        id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'high',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        supportsVision: true,
        inputCostPer1M: 1.25, outputCostPer1M: 10.0,
      }),
      model({
        id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite', tier: 'low',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        supportsVision: true,
        inputCostPer1M: 0.25, outputCostPer1M: 1.5,
      }),
    ],
    forwardCompat: [
      { pattern: /^gemini-(?:2|3)(?:[.-].*)?$/i, templateModel: 'gemini-2.5-flash' },
    ],
  }),

  groq: defineProvider({
    id: 'groq',
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiMode: 'openai-compat',
    defaultModel: 'llama-3.3-70b-versatile',
    placeholder: 'gsk_...',
    hint: 'Llama 3.3 70B',
    models: [
      model({
        id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tier: 'mid',
        contextWindow: 131_072, maxOutputTokens: 32_768,
        inputCostPer1M: 0.59, outputCostPer1M: 0.79,
      }),
    ],
  }),

  together: defineProvider({
    id: 'together',
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.xyz/v1',
    apiMode: 'openai-compat',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    hint: 'Llama 3.3 70B',
    models: [
      model({
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B', tier: 'mid',
        contextWindow: 131_072, maxOutputTokens: 4_096,
        inputCostPer1M: 0.88, outputCostPer1M: 0.88,
      }),
    ],
  }),

  openrouter: defineProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiMode: 'openai-compat',
    defaultModel: 'openrouter/auto',
    placeholder: 'sk-or-...',
    hint: 'Multi-provider router',
    models: [
      model({
        id: 'openrouter/auto', name: 'OpenRouter Auto', tier: 'mid',
        contextWindow: 128_000, maxOutputTokens: 16_384,
        supportsVision: true,
      }),
    ],
  }),

  xai: defineProvider({
    id: 'xai',
    name: 'xAI',
    envKey: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    apiMode: 'openai-compat',
    defaultModel: 'grok-3-mini',
    placeholder: 'xai-...',
    hint: 'Grok 3',
    models: [
      model({
        id: 'grok-3-mini', name: 'Grok 3 Mini', tier: 'mid',
        contextWindow: 131_072, maxOutputTokens: 8_192,
      }),
    ],
  }),

  mistral: defineProvider({
    id: 'mistral',
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    apiMode: 'openai-compat',
    defaultModel: 'mistral-large-latest',
    placeholder: 'mistral-...',
    hint: 'Mistral Large',
    models: [
      model({
        id: 'mistral-large-latest', name: 'Mistral Large', tier: 'high',
        contextWindow: 131_072, maxOutputTokens: 8_192,
      }),
    ],
  }),

  huggingface: defineProvider({
    id: 'huggingface',
    name: 'Hugging Face Inference',
    envKey: 'HUGGINGFACE_HUB_TOKEN',
    baseUrl: 'https://router.huggingface.co/v1',
    apiMode: 'openai-compat',
    defaultModel: 'deepseek-ai/DeepSeek-R1',
    placeholder: 'hf_...',
    hint: 'HF router',
    env: {
      keyAliases: ['HF_TOKEN'],
      keyPrefixes: ['HUGGINGFACE', 'HF'],
    },
    models: [
      model({
        id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (HF)', tier: 'mid',
        contextWindow: 65_536, maxOutputTokens: 8_192,
      }),
    ],
  }),

  qianfan: defineProvider({
    id: 'qianfan',
    name: 'Baidu Qianfan',
    envKey: 'QIANFAN_API_KEY',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    apiMode: 'openai-compat',
    defaultModel: 'deepseek-v3.2',
    hint: 'Qianfan cloud',
    models: [
      model({
        id: 'deepseek-v3.2', name: 'DeepSeek V3.2 (Qianfan)', tier: 'mid',
        contextWindow: 98_304, maxOutputTokens: 32_768,
      }),
    ],
  }),

  nvidia: defineProvider({
    id: 'nvidia',
    name: 'NVIDIA NIM',
    envKey: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiMode: 'openai-compat',
    defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    hint: 'NVIDIA hosted models',
    models: [
      model({
        id: 'nvidia/llama-3.1-nemotron-70b-instruct',
        name: 'Nemotron 70B Instruct',
        tier: 'mid',
        contextWindow: 131_072,
        maxOutputTokens: 4_096,
      }),
    ],
  }),

  zai: defineProvider({
    id: 'zai',
    name: 'Z.AI / GLM',
    envKey: 'ZAI_API_KEY',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiMode: 'openai-compat',
    defaultModel: 'glm-5',
    placeholder: 'zai-...',
    hint: 'GLM 5',
    env: {
      keyAliases: ['Z_AI_API_KEY'],
      keyPrefixes: ['ZAI', 'Z_AI'],
    },
    models: [
      model({
        id: 'glm-5', name: 'GLM 5', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 128_000,
        inputCostPer1M: 1.00, outputCostPer1M: 3.20,
      }),
      model({
        id: 'glm-5-code', name: 'GLM 5 Code', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 128_000,
        inputCostPer1M: 1.20, outputCostPer1M: 5.00,
      }),
      model({
        id: 'glm-4.7', name: 'GLM 4.7', tier: 'mid',
        contextWindow: 128_000, maxOutputTokens: 8_192,
      }),
    ],
  }),

  xiaomi: defineProvider({
    id: 'xiaomi',
    name: 'Xiaomi',
    envKey: 'XIAOMI_API_KEY',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    apiMode: 'anthropic',
    defaultModel: 'mimo-v2-flash',
    hint: 'MiMo models',
    models: [
      model({
        id: 'mimo-v2-flash', name: 'MiMo V2 Flash', tier: 'mid',
        contextWindow: 262_144, maxOutputTokens: 8_192,
      }),
    ],
  }),

  synthetic: defineProvider({
    id: 'synthetic',
    name: 'Synthetic',
    envKey: 'SYNTHETIC_API_KEY',
    baseUrl: 'https://api.synthetic.new/v1',
    apiMode: 'openai-compat',
    defaultModel: 'hf:MiniMaxAI/MiniMax-M2.1',
    hint: 'Synthetic model hub',
    models: [
      model({
        id: 'hf:MiniMaxAI/MiniMax-M2.1', name: 'MiniMax M2.1 (Synthetic)', tier: 'mid',
        contextWindow: 200_000, maxOutputTokens: 8_192,
      }),
    ],
  }),

  venice: defineProvider({
    id: 'venice',
    name: 'Venice AI',
    envKey: 'VENICE_API_KEY',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiMode: 'openai-compat',
    defaultModel: 'llama-3.3-70b',
    hint: 'Privacy-focused inference',
    models: [
      model({
        id: 'llama-3.3-70b', name: 'Llama 3.3 70B (Venice)', tier: 'mid',
        contextWindow: 131_072, maxOutputTokens: 8_192,
      }),
    ],
  }),

  ollama: defineProvider({
    id: 'ollama',
    name: 'Ollama (local)',
    envKey: 'OLLAMA_API_KEY',
    baseUrl: 'http://localhost:11434',
    apiMode: 'ollama-native',
    defaultModel: 'qwen3:32b',
    hint: 'Local models via Ollama',
    models: [
      model({
        id: 'qwen3:32b', name: 'Qwen3 32B (Ollama)', tier: 'mid',
        contextWindow: 131_072, maxOutputTokens: 8_192,
      }),
    ],
  }),

  vllm: defineProvider({
    id: 'vllm',
    name: 'vLLM (local)',
    envKey: 'VLLM_API_KEY',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiMode: 'openai-compat',
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    hint: 'OpenAI-compatible local endpoint',
    models: [
      model({
        id: 'meta-llama/Llama-3.1-8B-Instruct',
        name: 'Llama 3.1 8B (vLLM)',
        tier: 'low',
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
      }),
    ],
  }),

  bedrock: defineProvider({
    id: 'bedrock',
    name: 'Amazon Bedrock',
    envKey: 'BEDROCK_API_KEY',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    apiMode: 'bedrock-converse-stream',
    defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    hint: 'ConverseStream API',
    env: {
      keyAliases: ['AWS_BEARER_TOKEN_BEDROCK'],
      keyPrefixes: ['BEDROCK', 'AWS_BEARER_TOKEN_BEDROCK'],
    },
    models: [
      model({
        id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        name: 'Claude 3.5 Sonnet (Bedrock)',
        tier: 'high',
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsVision: true,
      }),
    ],
  }),

  // ── CLI-pipe providers ──────────────────────────────────────────────
  // CLI providers expose a small curated model list. `_cli-default` omits
  // --model so the installed CLI retains ownership of its default.

  'claude-cli': defineProvider({
    id: 'claude-cli',
    name: 'Claude CLI',
    envKey: '',
    baseUrl: '',
    apiMode: 'cli-pipe',
    defaultModel: '_cli-default',
    hint: 'Claude Code CLI (local auth)',
    autoDetect: false,
    models: [
      model({
        id: '_cli-default', name: 'Claude CLI default', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 16_000,
        supportsTools: false, supportsStreaming: false, supportsVision: false,
      }),
      model({
        id: 'sonnet', name: 'Claude Sonnet (latest)', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 16_000,
        supportsTools: false, supportsStreaming: false, supportsVision: false,
      }),
      model({
        id: 'opus', name: 'Claude Opus (latest)', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 16_000,
        supportsTools: false, supportsStreaming: false, supportsVision: false,
      }),
      model({
        id: 'fable', name: 'Claude Fable (latest)', tier: 'high',
        contextWindow: 200_000, maxOutputTokens: 16_000,
        supportsTools: false, supportsStreaming: false, supportsVision: false,
      }),
    ],
    forwardCompat: [
      { pattern: /./i, templateModel: '_cli-default' },
    ],
    cliBackend: {
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      input: 'arg',
      maxPromptArgBytes: 65_536,
      output: 'json',
      modelArg: '--model',
      systemPromptArg: '--append-system-prompt',
      mcpConfigArg: '--mcp-config',
      strictMcpConfigFlag: '--strict-mcp-config',
      systemPromptWhen: 'always',
      sessionMode: 'none',
      timeoutMs: 30 * 60_000,
    },
  }),

  'codex-cli': defineProvider({
    id: 'codex-cli',
    name: 'Codex CLI',
    envKey: '',
    baseUrl: '',
    apiMode: 'cli-pipe',
    defaultModel: '_cli-default',
    hint: 'OpenAI Codex CLI (local auth)',
    autoDetect: false,
    models: [
      model({
        id: '_cli-default', name: 'Codex CLI default', tier: 'high',
        contextWindow: 400_000, maxOutputTokens: 16_000,
        supportsTools: false, supportsStreaming: false, supportsVision: false,
      }),
    ],
    forwardCompat: [
      { pattern: /./i, templateModel: '_cli-default' },
    ],
    cliBackend: {
      command: 'codex',
      args: ['exec', '--json', '--color', 'never'],
      input: 'arg',
      maxPromptArgBytes: 65_536,
      stdinPromptArgs: ['-'],
      output: 'jsonl',
      modelArg: '--model',
      systemPromptArg: '-c',
      systemPromptFormat: 'codex-config-instructions',
      systemPromptWhen: 'always',
      sessionMode: 'existing',
      sessionIdFields: ['conversation_id'],
      timeoutMs: 30 * 60_000,
    },
  }),

  'gemini-cli': defineProvider({
    id: 'gemini-cli',
    name: 'Gemini CLI',
    envKey: '',
    baseUrl: '',
    apiMode: 'cli-pipe',
    defaultModel: '_cli-default',
    hint: 'Google Gemini CLI (local auth)',
    autoDetect: false,
    models: [
      model({
        id: '_cli-default', name: 'Gemini CLI (user-configured)', tier: 'high',
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        supportsTools: false, supportsStreaming: false, supportsVision: false,
      }),
    ],
    forwardCompat: [
      { pattern: /./i, templateModel: '_cli-default' },
    ],
    cliBackend: {
      command: 'gemini',
      args: ['--output-format', 'json'],
      input: 'arg',
      maxPromptArgBytes: 65_536,
      stdinPromptArgs: ['-p', ''],
      output: 'json',
      modelArg: '--model',
      inlineSystemPrompt: true,
      systemPromptWhen: 'always',
      promptArg: '-p',
      sessionMode: 'none',
      timeoutMs: 180_000,
    },
  }),
};

/** Providers shown in `mozi onboard` (common first-run choices). */
export const WIZARD_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'minimax',
  'deepseek',
  'moonshot',
  'google',
  'groq',
  'xai',
  'mistral',
  'zai',
  'openrouter',
  // CLI-pipe providers — no API key, use local CLI auth
  'claude-cli',
  'codex-cli',
  'gemini-cli',
];
