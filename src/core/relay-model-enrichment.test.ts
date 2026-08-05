/**
 * A relay (LiteLLM, OpenRouter, a corporate gateway) fronts real models under
 * custom ids. resolveRuntimeModel must lift their real capabilities from the
 * shipped LiteLLM price/context registry instead of the conservative fallback,
 * which would cap context to 32k and disable vision. This runs without the DB.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRuntimeModel } from './providers.js';
import { clearModelRegistryEnrichmentCache } from './model-registry-enrichment.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.MOZI_HOME;
  home = join(tmpdir(), `mozi-relay-enrich-${process.pid}-${Math.floor(performance.now())}`);
  process.env.MOZI_HOME = home;
  const cacheDir = join(home, 'data', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  // Minimal LiteLLM-shaped registry entry for a relay-fronted model id.
  writeFileSync(
    join(cacheDir, 'litellm-registry.json'),
    JSON.stringify({
      'relay-big-model': {
        max_input_tokens: 200_000,
        max_output_tokens: 64_000,
        supports_function_calling: true,
        supports_vision: true,
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    }),
  );
  clearModelRegistryEnrichmentCache();
});

afterEach(() => {
  clearModelRegistryEnrichmentCache();
  if (prevHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = prevHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('core/relay-model-enrichment', () => {
  it('lifts real capabilities for a relay-fronted model from the registry', () => {
    const model = resolveRuntimeModel('deepseek', 'relay-big-model', { allowUnknown: true });
    expect(model).toBeDefined();
    expect(model!.contextWindow).toBe(200_000);
    expect(model!.maxOutputTokens).toBe(64_000);
    expect(model!.supportsTools).toBe(true);
    expect(model!.supportsVision).toBe(true);
    expect(model!.inputCostPer1M).toBeCloseTo(3, 6);
    expect(model!.outputCostPer1M).toBeCloseTo(15, 6);
  });

  it('falls back to the conservative profile for an unknown id absent from the registry', () => {
    const model = resolveRuntimeModel('deepseek', 'totally-private-model', { allowUnknown: true });
    expect(model).toBeDefined();
    expect(model!.contextWindow).toBe(32_768);
    expect(model!.maxOutputTokens).toBe(4_096);
    expect(model!.supportsTools).toBe(false);
    expect(model!.supportsVision).toBe(false);
  });

  it('still returns undefined for unknown ids when allowUnknown is not set', () => {
    expect(resolveRuntimeModel('deepseek', 'relay-big-model')).toBeUndefined();
  });
});
