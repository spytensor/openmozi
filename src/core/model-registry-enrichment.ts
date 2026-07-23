import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import pino from 'pino';
import { getMoziHome } from '../paths.js';
import type { ModelDef } from './providers.js';

const logger = pino({ name: 'mozi:model-registry-enrichment' });

const LITELLM_REGISTRY_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const RegistryEntrySchema = z.object({
  max_input_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  supports_function_calling: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  input_cost_per_token: z.number().optional(),
  output_cost_per_token: z.number().optional(),
  cache_read_input_token_cost: z.number().optional(),
  cache_creation_input_token_cost: z.number().optional(),
  litellm_provider: z.string().optional(),
}).passthrough();

const RegistrySchema = z.record(z.string(), z.unknown());

type Registry = z.infer<typeof RegistrySchema>;

export type EnrichedModelMetadata = Pick<
  ModelDef,
  'contextWindow' | 'maxOutputTokens' | 'supportsTools' | 'supportsVision' | 'inputCostPer1M' | 'outputCostPer1M' | 'cacheReadCostPer1M' | 'cacheWriteCostPer1M'
> & { provider?: string };

let memoryCache: { registry: Registry; expiresAt: number } | null = null;
let inFlightLoad: Promise<Registry | null> | null = null;

function cachePath(): string {
  return join(getMoziHome(), 'data', 'cache', 'litellm-registry.json');
}

function parseRegistry(raw: unknown, source: string): Registry | null {
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ source, error: parsed.error.message }, 'LiteLLM registry validation failed');
    return null;
  }
  return parsed.data;
}

function readDiskCache(): Registry | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parseRegistry(raw, 'disk');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), path }, 'Unable to read LiteLLM registry disk cache');
    return null;
  }
}

function writeDiskCache(registry: Registry): void {
  const path = cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(registry)}\n`, 'utf-8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), path }, 'Unable to write LiteLLM registry disk cache');
  }
}

async function fetchRegistry(): Promise<Registry | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(LITELLM_REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'LiteLLM registry fetch failed');
      return null;
    }
    const raw = await response.json() as unknown;
    const registry = parseRegistry(raw, 'network');
    if (registry) writeDiskCache(registry);
    return registry;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LiteLLM registry fetch failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadRegistry(): Promise<Registry | null> {
  const now = Date.now();
  if (memoryCache && memoryCache.expiresAt > now) {
    return memoryCache.registry;
  }
  if (inFlightLoad) {
    return inFlightLoad;
  }

  inFlightLoad = (async () => {
    const fetched = await fetchRegistry();
    const registry = fetched ?? readDiskCache();
    if (!registry) return null;

    memoryCache = { registry, expiresAt: now + CACHE_TTL_MS };
    return registry;
  })();
  try {
    return await inFlightLoad;
  } finally {
    inFlightLoad = null;
  }
}

function mapEntry(rawEntry: unknown): EnrichedModelMetadata | null {
  const parsed = RegistryEntrySchema.safeParse(rawEntry);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const metadata: Partial<EnrichedModelMetadata> = {};
  if (typeof entry.max_input_tokens === 'number') metadata.contextWindow = entry.max_input_tokens;
  if (typeof entry.max_output_tokens === 'number') metadata.maxOutputTokens = entry.max_output_tokens;
  if (typeof entry.supports_function_calling === 'boolean') metadata.supportsTools = entry.supports_function_calling;
  if (typeof entry.supports_vision === 'boolean') metadata.supportsVision = entry.supports_vision;
  if (typeof entry.input_cost_per_token === 'number') metadata.inputCostPer1M = entry.input_cost_per_token * 1_000_000;
  if (typeof entry.output_cost_per_token === 'number') metadata.outputCostPer1M = entry.output_cost_per_token * 1_000_000;
  if (typeof entry.cache_read_input_token_cost === 'number') metadata.cacheReadCostPer1M = entry.cache_read_input_token_cost * 1_000_000;
  if (typeof entry.cache_creation_input_token_cost === 'number') metadata.cacheWriteCostPer1M = entry.cache_creation_input_token_cost * 1_000_000;
  if (typeof entry.litellm_provider === 'string') metadata.provider = entry.litellm_provider;
  return Object.keys(metadata).length > 0 ? metadata as EnrichedModelMetadata : null;
}

function findEntry(registry: Registry, providerId: string | undefined, modelId: string): unknown {
  if (providerId) {
    return registry[`${providerId}/${modelId}`] ?? registry[modelId];
  }
  return registry[modelId];
}

export async function enrich(providerId: string, modelId: string): Promise<EnrichedModelMetadata | null> {
  const registry = await loadRegistry();
  if (!registry) return null;
  const entry = findEntry(registry, providerId, modelId);
  return entry ? mapEntry(entry) : null;
}

/** Read the last successfully downloaded price map without adding network I/O to an LLM call. */
export function getCachedModelMetadata(providerId: string | undefined, modelId: string): EnrichedModelMetadata | null {
  const registry = memoryCache?.registry ?? readDiskCache();
  if (!registry) return null;
  const entry = findEntry(registry, providerId, modelId);
  return entry ? mapEntry(entry) : null;
}

/** Refresh the live LiteLLM model/price map during startup or an explicit admin sync. */
export async function refreshModelRegistry(): Promise<boolean> {
  memoryCache = null;
  const registry = await loadRegistry();
  return Boolean(registry);
}

export function clearModelRegistryEnrichmentCache(): void {
  memoryCache = null;
  inFlightLoad = null;
}
