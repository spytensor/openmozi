import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getMoziHome } from '../paths.js';
import { getConfig, type MoziConfig } from '../config/index.js';
import { resolveApiKeys, resolveBaseUrl } from '../core/providers.js';
import { resolveRuntimeApiKey } from '../core/runtime-provider-keys.js';
import {
  createEmbeddingProvider,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from './embeddings.js';
import { initVectorStore, setVectorStore, type VectorStore } from './vector-store.js';

const logger = pino({ name: 'mozi:memory:embedding-provider' });

type SupportedEmbeddingProvider = Exclude<EmbeddingConfig['provider'], 'none'>;

export interface MemoryEmbeddingResolution {
  provider: EmbeddingProvider | null;
  reason: string;
}

const cachedProviders = new Map<string, EmbeddingProvider | null>();
const cachedVectorStores = new Map<string, VectorStore | null>();
const vectorStorePromises = new Map<string, Promise<VectorStore | null>>();
let keywordOnlyLogged = false;

function trim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEmbeddingApiKey(
  provider: 'openai' | 'minimax',
  config: MoziConfig,
  env: NodeJS.ProcessEnv,
  tenantId: string,
): string | undefined {
  const configured = trim(config.providers[provider]?.apikey);
  if (configured) return configured;
  const environmentKey = resolveApiKeys(provider, env)[0];
  if (environmentKey) return environmentKey;
  // A custom env object is used by deterministic config/tests. Tenant storage
  // is a runtime-only fallback and must not leak ambient process credentials
  // into an explicitly isolated resolution.
  if (env !== process.env) return undefined;
  return resolveRuntimeApiKey(provider, { configProviders: {}, tenantId });
}

function resolveOllamaBaseUrl(
  config: MoziConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return trim(config.memory.embedding.base_url)
    ?? trim(env.OLLAMA_BASE_URL)
    ?? trim(env.OLLAMA_HOST)
    ?? trim(config.providers.ollama?.baseurl);
}

function createProvider(config: EmbeddingConfig): MemoryEmbeddingResolution {
  try {
    const provider = createEmbeddingProvider(config);
    if (!provider) {
      return { provider: null, reason: 'provider_none' };
    }
    return { provider, reason: `provider_${provider.providerName}` };
  } catch (err) {
    logger.warn({
      provider: config.provider,
      err: err instanceof Error ? err.message : String(err),
    }, 'Memory embedding provider misconfigured');
    return { provider: null, reason: 'provider_misconfigured' };
  }
}

function explicitProviderConfig(
  config: MoziConfig,
  provider: SupportedEmbeddingProvider,
  env: NodeJS.ProcessEnv,
  tenantId: string,
): EmbeddingConfig {
  const embedding = config.memory.embedding;
  const apiKey = trim(embedding.api_key)
    ?? (provider === 'openai'
      ? resolveEmbeddingApiKey('openai', config, env, tenantId)
      : provider === 'minimax'
        ? resolveEmbeddingApiKey('minimax', config, env, tenantId)
        : undefined);

  return {
    provider,
    model: trim(embedding.model),
    apiKey,
    baseUrl: trim(embedding.base_url)
      ?? (provider === 'openai'
        ? resolveBaseUrl('openai', env, config.providers)
        : provider === 'ollama'
          ? resolveOllamaBaseUrl(config, env)
          : undefined),
    dimensions: embedding.dimensions,
  };
}

/**
 * Select a memory embedding provider from explicit config first, then env.
 * This only constructs provider clients; it does not perform network I/O.
 */
export function resolveMemoryEmbeddingProvider(
  config: MoziConfig = getConfig(),
  env: NodeJS.ProcessEnv = process.env,
  tenantId = 'default',
): MemoryEmbeddingResolution {
  const embedding = config.memory.embedding;

  if (embedding.provider === 'none') {
    return { provider: null, reason: 'disabled_by_config' };
  }

  if (embedding.provider !== 'auto') {
    return createProvider(explicitProviderConfig(config, embedding.provider, env, tenantId));
  }

  const explicitModel = trim(embedding.model);
  const explicitDimensions = embedding.dimensions;
  const openAiKey = trim(embedding.api_key)
    ?? resolveEmbeddingApiKey('openai', config, env, tenantId);
  if (openAiKey) {
    return createProvider({
      provider: 'openai',
      model: explicitModel,
      apiKey: openAiKey,
      baseUrl: trim(embedding.base_url) ?? resolveBaseUrl('openai', env, config.providers),
      dimensions: explicitDimensions,
    });
  }

  const ollamaBaseUrl = resolveOllamaBaseUrl(config, env);
  if (ollamaBaseUrl) {
    return createProvider({
      provider: 'ollama',
      model: explicitModel,
      baseUrl: ollamaBaseUrl,
      dimensions: explicitDimensions,
    });
  }

  return { provider: null, reason: 'no_embedding_provider_configured' };
}

function logKeywordOnlyOnce(reason: string): void {
  if (keywordOnlyLogged) return;
  keywordOnlyLogged = true;
  logger.info({ reason }, 'Vector memory unavailable; memory runs in keyword-only mode');
}

export function getMemoryEmbeddingProvider(tenantId = 'default'): EmbeddingProvider | null {
  if (cachedProviders.has(tenantId)) {
    const cached = cachedProviders.get(tenantId) ?? null;
    if (!cached) logKeywordOnlyOnce('cached_null');
    return cached;
  }

  const resolution = resolveMemoryEmbeddingProvider(getConfig(), process.env, tenantId);
  cachedProviders.set(tenantId, resolution.provider);
  if (!resolution.provider) {
    logKeywordOnlyOnce(resolution.reason);
  }
  return resolution.provider;
}

export function getMemoryVectorStorePath(tenantId = 'default'): string {
  if (tenantId === 'default') return join(getMoziHome(), 'data', 'memory-vectors.lance');
  const tenantHash = createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
  return join(getMoziHome(), 'data', 'memory-vectors', `${tenantHash}.lance`);
}

/**
 * Lazily initialize the LanceDB vector store on first memory use.
 */
export async function getMemoryVectorStore(tenantId = 'default'): Promise<VectorStore | null> {
  if (cachedVectorStores.has(tenantId)) {
    return cachedVectorStores.get(tenantId) ?? null;
  }
  const pending = vectorStorePromises.get(tenantId);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const provider = getMemoryEmbeddingProvider(tenantId);
    if (!provider) {
      setVectorStore(null);
      cachedVectorStores.set(tenantId, null);
      return null;
    }

    const dbPath = getMemoryVectorStorePath(tenantId);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    const store = await initVectorStore(dbPath, provider, 'memory_fact_vectors');
    cachedVectorStores.set(tenantId, store);
    return store;
  })().finally(() => {
    vectorStorePromises.delete(tenantId);
  });
  vectorStorePromises.set(tenantId, promise);

  return promise;
}

export function resetMemoryEmbeddingProviderForTests(): void {
  resetMemoryEmbeddingProviderCache();
}

export function resetMemoryEmbeddingProviderCache(): void {
  cachedProviders.clear();
  cachedVectorStores.clear();
  vectorStorePromises.clear();
  keywordOnlyLogged = false;
  setVectorStore(null);
}

export function setMemoryEmbeddingProviderForTests(provider: EmbeddingProvider | null, tenantId = 'default'): void {
  cachedProviders.set(tenantId, provider);
  cachedVectorStores.delete(tenantId);
  vectorStorePromises.delete(tenantId);
  setVectorStore(null);
}
