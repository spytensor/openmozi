import { describe, expect, it } from 'vitest';
import { calculateCatalogCost } from './ai-sdk-adapter.js';
import { resolveModelPricing } from './model-pricing.js';

describe('catalog cost calculation', () => {
  it('prices cached and uncached input tokens separately', () => {
    const cost = calculateCatalogCost(
      { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 800_000 },
      { inputCost: 0.435, outputCost: 0.87, cacheReadCost: 0.003625 },
    );

    expect(cost).toBeCloseTo((200_000 * 0.435 + 800_000 * 0.003625 + 100_000 * 0.87) / 1_000_000, 10);
  });

  it('refuses to invent a complete price when cached-input pricing is unknown', () => {
    expect(calculateCatalogCost(
      { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 500 },
      { inputCost: 1, outputCost: 2 },
    )).toBeNull();
  });

  it('prices provider cache writes separately from reads and uncached input', () => {
    expect(calculateCatalogCost(
      { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 600_000, cache_write_tokens: 200_000 },
      { inputCost: 3, outputCost: 15, cacheReadCost: 0.3, cacheWriteCost: 3.75 },
    )).toBeCloseTo(3.03);
    expect(calculateCatalogCost(
      { input_tokens: 1000, output_tokens: 10, cache_write_tokens: 500 },
      { inputCost: 1, outputCost: 2 },
    )).toBeNull();
  });

  it('infers a unique non-CLI provider for historical model ids', () => {
    expect(resolveModelPricing(undefined, 'kimi-k2.6')).toMatchObject({ provider: 'moonshot', source: 'builtin_catalog' });
    expect(resolveModelPricing(undefined, 'MiniMax-M2.5')).toMatchObject({ provider: 'minimax', source: 'builtin_catalog' });
  });
});
