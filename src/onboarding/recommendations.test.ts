import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { formatRecommendations, formatRoutingReview, generateRouting, saveRoutingToConfig, type RoutingRecommendation, type BenchmarkResult } from './index.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeBenchmark(overrides: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    modelId: 'test-model',
    provider: 'test-provider',
    reasoning: { passed: true, latencyMs: 200, tokens: 50 },
    instruction: { passed: true, latencyMs: 150, tokens: 40 },
    codeGen: { passed: true, latencyMs: 250, tokens: 60 },
    overall: 100,
    avgLatencyMs: 200,
    totalTokens: 150,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describe('onboarding/recommendations', () => {
  describe('formatRecommendations', () => {
    it('formats multi-provider recommendations', () => {
      const recs: RoutingRecommendation[] = [
        { role: 'brain', provider: 'anthropic', model: 'claude-sonnet-4', reason: 'User-selected primary brain model' },
        { role: 'cheap executor', provider: 'openai', model: 'gpt-4.1-mini', reason: 'Cheapest healthy model with tool support ($0.4/$1.6 per 1M)' },
        { role: 'vision/UI specialist', provider: 'google', model: 'gemini-2.5-flash', reason: 'Vision-capable model (different provider)' },
        { role: 'summary/fast', provider: 'openai', model: 'gpt-4.1-mini', reason: 'Fastest model passing quality bar (320ms avg)' },
      ];

      const output = formatRecommendations(recs);

      expect(output).toContain('Recommended Model Stack:');
      expect(output).toContain('brain: anthropic/claude-sonnet-4');
      expect(output).toContain('cheap executor: openai/gpt-4.1-mini');
      expect(output).toContain('vision/UI specialist: google/gemini-2.5-flash');
      expect(output).toContain('summary/fast: openai/gpt-4.1-mini');
      // Reasons are included
      expect(output).toContain('User-selected primary brain model');
      expect(output).toContain('Cheapest healthy model');
      expect(output).toContain('Vision-capable model');
    });

    it('formats single-provider recommendations (brain only)', () => {
      const recs: RoutingRecommendation[] = [
        { role: 'brain', provider: 'anthropic', model: 'claude-sonnet-4', reason: 'User-selected primary brain model' },
      ];

      const output = formatRecommendations(recs);

      expect(output).toContain('Recommended Model Stack:');
      expect(output).toContain('brain: anthropic/claude-sonnet-4');
      // Only one entry
      expect(output.split('\n').filter(l => l.includes('/')).length).toBe(1);
    });

    it('handles empty recommendations', () => {
      const output = formatRecommendations([]);
      expect(output).toContain('single provider setup');
    });

    it('includes the final saved routing map in review output', () => {
      const output = formatRoutingReview({
        brain: { provider: 'anthropic', model: 'claude-sonnet-4' },
        fallback_brain: { provider: 'openai', model: 'gpt-4.1-mini' },
        roles: {
          complex_subagent: { provider: 'anthropic', model: 'claude-sonnet-4' },
          simple_subagent: { provider: 'openai', model: 'gpt-4.1-mini' },
          summary: { provider: 'openai', model: 'gpt-4.1-mini' },
          code: { provider: 'anthropic', model: 'claude-sonnet-4' },
        },
        recommendations: [
          { role: 'brain', provider: 'anthropic', model: 'claude-sonnet-4', reason: 'User-selected primary brain model' },
          { role: 'summary/fast', provider: 'openai', model: 'gpt-4.1-mini', reason: 'Fastest model passing quality bar (320ms avg)' },
        ],
      });

      expect(output).toContain('Recommended Model Stack:');
      expect(output).toContain('Routing To Save:');
      expect(output).toContain('Fallback: openai/gpt-4.1-mini');
      expect(output).toContain('Simple Agent: openai/gpt-4.1-mini');
      expect(output).toContain('Summary: openai/gpt-4.1-mini');
    });
  });

  describe('generateRouting', () => {
    // Save and restore env to avoid cross-test pollution
    const savedEnv: Record<string, string | undefined> = {};
    const keysToManage = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY', 'GROQ_API_KEY',
    ];

    beforeAll(() => {
      for (const key of keysToManage) {
        savedEnv[key] = process.env[key];
      }
    });

    afterAll(() => {
      for (const key of keysToManage) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it('includes recommendations and routing_preferences in output (multi-provider)', () => {
      // Set up multiple providers so the snapshot has multiple healthy models
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      const benchmarks: BenchmarkResult[] = [
        fakeBenchmark({ modelId: 'claude-sonnet-4', provider: 'anthropic', overall: 95, avgLatencyMs: 300, estimatedCostUsd: 0.005 }),
        fakeBenchmark({ modelId: 'gpt-4.1-mini', provider: 'openai', overall: 80, avgLatencyMs: 150, estimatedCostUsd: 0.001 }),
      ];
      const brain = { provider: 'anthropic', model: 'claude-sonnet-4' };

      const routing = generateRouting(benchmarks, brain);

      // Must have recommendations
      expect(routing.recommendations).toBeDefined();
      expect(routing.recommendations!.length).toBeGreaterThan(0);

      // Brain recommendation always present
      const brainRec = routing.recommendations!.find(r => r.role === 'brain');
      expect(brainRec).toBeDefined();
      expect(brainRec!.provider).toBe('anthropic');
      expect(brainRec!.model).toBe('claude-sonnet-4');

      // Must have routing_preferences
      expect(routing.routing_preferences).toBeDefined();
      expect(routing.routing_preferences!.cost_sensitivity).toBe('medium');
      expect(routing.routing_preferences!.preferred_code).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    });

    it('works with single provider (brain only scenario)', () => {
      // Only one provider available
      for (const key of keysToManage) delete process.env[key];
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      const benchmarks: BenchmarkResult[] = [
        fakeBenchmark({ modelId: 'claude-sonnet-4', provider: 'anthropic', overall: 95, avgLatencyMs: 300 }),
      ];
      const brain = { provider: 'anthropic', model: 'claude-sonnet-4' };

      const routing = generateRouting(benchmarks, brain);

      expect(routing.recommendations).toBeDefined();
      expect(routing.recommendations!.length).toBeGreaterThanOrEqual(1);
      // Brain is always first
      expect(routing.recommendations![0].role).toBe('brain');
      // routing_preferences still populated
      expect(routing.routing_preferences).toBeDefined();
      expect(routing.routing_preferences!.preferred_code).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    });

    it('does not recommend unbenchmarked providers just because they are configured', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.GEMINI_API_KEY = 'gem-test';

      const benchmarks: BenchmarkResult[] = [
        fakeBenchmark({ modelId: 'claude-sonnet-4', provider: 'anthropic', overall: 95, avgLatencyMs: 300, estimatedCostUsd: 0.005 }),
        fakeBenchmark({ modelId: 'gpt-4.1-mini', provider: 'openai', overall: 80, avgLatencyMs: 150, estimatedCostUsd: 0.001 }),
      ];

      const routing = generateRouting(benchmarks, { provider: 'anthropic', model: 'claude-sonnet-4' });
      const recommendedProviders = (routing.recommendations ?? []).map((recommendation) => recommendation.provider);

      expect(recommendedProviders).not.toContain('google');
      expect(routing.routing_preferences?.preferred_vision?.provider).not.toBe('google');
    });
  });

  describe('saveRoutingToConfig', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = join(tmpdir(), `mozi-rec-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists routing_preferences to config file', () => {
      const configPath = join(tmpDir, 'mozi-prefs.json');
      writeFileSync(configPath, JSON.stringify({ brain: { model: 'old-model' } }));

      const routing = {
        brain: { provider: 'anthropic', model: 'claude-sonnet-4' },
        roles: {
          complex_subagent: { provider: 'anthropic', model: 'claude-sonnet-4' },
          simple_subagent: { provider: 'openai', model: 'gpt-4.1-mini' },
          summary: { provider: 'openai', model: 'gpt-4.1-mini' },
          code: { provider: 'anthropic', model: 'claude-sonnet-4' },
        },
        routing_preferences: {
          cost_sensitivity: 'medium' as const,
          preferred_code: { provider: 'anthropic', model: 'claude-sonnet-4' },
          preferred_cheap: { provider: 'openai', model: 'gpt-4.1-mini' },
        },
      };

      saveRoutingToConfig(routing, configPath);

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(saved.model_router).toBeDefined();
      expect(saved.model_router.routing_preferences).toBeDefined();
      expect(saved.model_router.routing_preferences.cost_sensitivity).toBe('medium');
      expect(saved.model_router.routing_preferences.preferred_code).toEqual({
        provider: 'anthropic', model: 'claude-sonnet-4',
      });
      expect(saved.model_router.routing_preferences.preferred_cheap).toEqual({
        provider: 'openai', model: 'gpt-4.1-mini',
      });
    });

    it('omits routing_preferences when not provided', () => {
      const configPath = join(tmpDir, 'mozi-no-prefs.json');
      writeFileSync(configPath, JSON.stringify({ brain: {} }));

      const routing = {
        brain: { provider: 'anthropic', model: 'claude-sonnet-4' },
        roles: {
          complex_subagent: { provider: 'anthropic', model: 'claude-sonnet-4' },
          simple_subagent: { provider: 'anthropic', model: 'claude-sonnet-4' },
          summary: { provider: 'anthropic', model: 'claude-sonnet-4' },
          code: { provider: 'anthropic', model: 'claude-sonnet-4' },
        },
      };

      saveRoutingToConfig(routing, configPath);

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(saved.model_router.routing_preferences).toBeUndefined();
    });
  });
});
