import type { ProviderDef } from './providers.js';

export type ModelDiscoverySource = 'live' | 'cache' | 'catalog';
export type CapabilityConfidence = 'provider' | 'catalog' | 'conservative';

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  reasoning?: boolean;
}

export interface ModelDiscoveryResult {
  supported: boolean;
  source: ModelDiscoverySource;
  fetchedAt: string | null;
  capabilityConfidence: CapabilityConfidence;
  fallbackReason?: string;
  models: DiscoveredModel[];
}

interface CacheEntry {
  expiresAt: number;
  fetchedAt: string;
  models: DiscoveredModel[];
}

const CACHE_TTL_MS = 5 * 60_000;
const discoveryCache = new Map<string, CacheEntry>();
const OPENAI_LIST_MODES = new Set(['openai-compat', 'openai-responses', 'openai-codex-responses', 'anthropic']);
const NON_CHAT_ID_PARTS = [
  'tts', 'transcribe', 'whisper', 'moderation', 'embedding', 'embed', 'image',
  'dall-e', 'audio', 'realtime', 'search-api', 'babbage', 'davinci', 'sora',
];

export function isSafeCustomModelId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value.trim());
}

function isLikelyChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return isSafeCustomModelId(id) && !NON_CHAT_ID_PARTS.some(part => lower.includes(part));
}

function openAiModelsUrl(provider: ProviderDef, baseUrl: string): string {
  let trimmed = baseUrl.trim().replace(/\/+$/, '');
  // MiniMax serves model discovery on its OpenAI-compatible root even when
  // chat traffic uses the Anthropic-compatible path.
  if (provider.id === 'minimax') trimmed = trimmed.replace(/\/anthropic\/v1$/i, '/v1');
  if (trimmed.endsWith('/v1')) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

function discoveryRequest(provider: ProviderDef, baseUrl: string, apiKey?: string): { url: string; headers: Record<string, string> } | null {
  if (provider.apiMode === 'ollama-native') {
    return { url: `${baseUrl.trim().replace(/\/+$/, '')}/api/tags`, headers: {} };
  }
  if (provider.apiMode === 'google-generative-ai') {
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
    };
  }
  if (OPENAI_LIST_MODES.has(provider.apiMode)) {
    return {
      url: openAiModelsUrl(provider, baseUrl),
      headers: apiKey ? {
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      } : {},
    };
  }
  return null;
}

function parseModels(provider: ProviderDef, body: unknown): DiscoveredModel[] {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const rows = provider.apiMode === 'ollama-native'
    ? record.models
    : provider.apiMode === 'google-generative-ai'
      ? record.models
      : record.data;
  if (!Array.isArray(rows)) throw new Error('Provider returned an invalid model list');

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const rawId = provider.apiMode === 'ollama-native' ? row.model ?? row.name : row.id ?? row.name;
    if (typeof rawId !== 'string') continue;
    const id = rawId.replace(/^models\//, '').trim();
    if (!isLikelyChatModel(id) || seen.has(id)) continue;
    if (provider.apiMode === 'google-generative-ai') {
      const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
      if (methods.length > 0 && !methods.includes('generateContent')) continue;
    }
    seen.add(id);
    models.push({
      id,
      ...(typeof row.displayName === 'string' ? { name: row.displayName } : typeof row.name === 'string' && provider.apiMode !== 'google-generative-ai' ? { name: row.name } : {}),
      ...(typeof row.context_length === 'number' ? { contextWindow: row.context_length } : {}),
      ...(typeof row.inputTokenLimit === 'number' ? { contextWindow: row.inputTokenLimit } : {}),
      ...(typeof row.outputTokenLimit === 'number' ? { maxOutputTokens: row.outputTokenLimit } : {}),
      ...(typeof row.thinking === 'boolean' ? { reasoning: row.thinking } : {}),
      ...(Array.isArray(row.supported_parameters) ? { supportsTools: row.supported_parameters.includes('tools') } : {}),
    });
  }
  return models;
}

export async function discoverProviderModels(input: {
  provider: ProviderDef;
  baseUrl: string;
  apiKey?: string;
  tenantId: string;
  force?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ModelDiscoveryResult> {
  const request = discoveryRequest(input.provider, input.baseUrl, input.apiKey);
  if (!request) {
    return { supported: false, source: 'catalog', fetchedAt: null, capabilityConfidence: 'catalog', fallbackReason: 'provider_does_not_list_models', models: [] };
  }
  if (!input.apiKey && input.provider.apiMode !== 'ollama-native') {
    return { supported: true, source: 'catalog', fetchedAt: null, capabilityConfidence: 'catalog', fallbackReason: 'missing_api_key', models: [] };
  }

  const now = input.now ?? Date.now();
  const cacheKey = `${input.tenantId}:${input.provider.id}:${input.baseUrl}`;
  const cached = discoveryCache.get(cacheKey);
  if (!input.force && cached && cached.expiresAt > now) {
    return { supported: true, source: 'cache', fetchedAt: cached.fetchedAt, capabilityConfidence: 'provider', models: cached.models };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(request.url, {
      headers: request.headers,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    const models = parseModels(input.provider, await response.json());
    const fetchedAt = new Date(now).toISOString();
    discoveryCache.set(cacheKey, { models, fetchedAt, expiresAt: now + CACHE_TTL_MS });
    return { supported: true, source: 'live', fetchedAt, capabilityConfidence: 'provider', models };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? 'provider_models_request_timeout'
      : error instanceof Error ? error.message : String(error);
    if (cached) {
      return { supported: true, source: 'cache', fetchedAt: cached.fetchedAt, capabilityConfidence: 'provider', fallbackReason: reason, models: cached.models };
    }
    return { supported: true, source: 'catalog', fetchedAt: null, capabilityConfidence: 'catalog', fallbackReason: reason, models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export function clearModelDiscoveryCache(): void {
  discoveryCache.clear();
}
