import { getCachedModelMetadata } from './model-registry-enrichment.js';
import { getAllProviders, getModel as getRegisteredModel } from './providers.js';

const BUILTIN_CATALOG_VERSION = 'mozi-catalog:2026-07-14';

export interface ModelPricingSnapshot {
  provider: string | undefined;
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  source: 'litellm_live' | 'builtin_catalog' | 'unknown';
  version?: string;
}

export function calculateCatalogCost(
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
  pricing: { inputCost: number; outputCost: number; cacheReadCost?: number; cacheWriteCost?: number },
): number | null {
  if (usage.cache_read_tokens && usage.cache_read_tokens > 0 && pricing.cacheReadCost === undefined) return null;
  if (usage.cache_write_tokens && usage.cache_write_tokens > 0 && pricing.cacheWriteCost === undefined) return null;
  const cacheReadTokens = Math.max(0, Math.min(usage.input_tokens, usage.cache_read_tokens ?? 0));
  const cacheWriteTokens = Math.max(0, Math.min(usage.input_tokens - cacheReadTokens, usage.cache_write_tokens ?? 0));
  const uncachedInputTokens = usage.input_tokens - cacheReadTokens - cacheWriteTokens;
  return (uncachedInputTokens / 1_000_000) * pricing.inputCost
    + (cacheReadTokens / 1_000_000) * (pricing.cacheReadCost ?? pricing.inputCost)
    + (cacheWriteTokens / 1_000_000) * (pricing.cacheWriteCost ?? pricing.inputCost)
    + (usage.output_tokens / 1_000_000) * pricing.outputCost;
}

export function resolveModelPricing(providerName: string | undefined, modelId: string): ModelPricingSnapshot {
  // Azure ids are user-chosen deployment names, not a catalog fingerprint, so
  // they cannot identify a provider the way a real model id can — a deployment
  // called "gpt-4o" says nothing about where an unlabelled historical row ran.
  // Excluded for the same reason cli-pipe is.
  const INFERENCE_BLIND_MODES = new Set(['cli-pipe', 'azure-openai']);
  const builtinMatches = providerName
    ? [providerName]
    : getAllProviders().filter(provider => !INFERENCE_BLIND_MODES.has(provider.apiMode) && getRegisteredModel(provider.id, modelId)).map(provider => provider.id);
  const inferredProvider = providerName ?? (builtinMatches.length === 1 ? builtinMatches[0] : undefined);
  const live = getCachedModelMetadata(inferredProvider, modelId) ?? getCachedModelMetadata(undefined, modelId);
  const resolvedProvider = inferredProvider ?? live?.provider;
  const builtin = resolvedProvider ? getRegisteredModel(resolvedProvider, modelId) : undefined;
  const model = live ?? builtin;
  const hasBasePricing = model?.inputCostPer1M !== undefined && model.outputCostPer1M !== undefined;
  return {
    provider: resolvedProvider,
    inputCost: model?.inputCostPer1M ?? 0,
    outputCost: model?.outputCostPer1M ?? 0,
    cacheReadCost: model?.cacheReadCostPer1M,
    cacheWriteCost: model?.cacheWriteCostPer1M,
    source: !hasBasePricing ? 'unknown' : live ? 'litellm_live' : 'builtin_catalog',
    version: !hasBasePricing ? undefined : live ? 'litellm-live' : BUILTIN_CATALOG_VERSION,
  };
}
