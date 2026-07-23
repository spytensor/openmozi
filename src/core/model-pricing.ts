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
  const builtinMatches = providerName
    ? [providerName]
    : getAllProviders().filter(provider => provider.apiMode !== 'cli-pipe' && getRegisteredModel(provider.id, modelId)).map(provider => provider.id);
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
