import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveRouting, type PolicyInput } from './routing-policy.js';
import type { ModelCapabilitySnapshot, ModelCapabilityEntry } from './model-capability-map.js';

// ---------------------------------------------------------------------------
// Helpers — build synthetic snapshots for deterministic testing
// ---------------------------------------------------------------------------

function entry(overrides: Partial<ModelCapabilityEntry>): ModelCapabilityEntry {
  return {
    provider: 'test-provider',
    providerName: 'Test Provider',
    model: 'test-model',
    modelName: 'Test Model',
    apiMode: 'openai-compat',
    tier: 'mid',
    healthy: true,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    reasoning: false,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 1.0,
    outputCostPer1M: 4.0,
    recommendedLanes: ['simple_subagent'],
    ...overrides,
  };
}

function snapshot(usable: ModelCapabilityEntry[]): ModelCapabilitySnapshot {
  return {
    generatedAt: new Date().toISOString(),
    all: usable,
    usable,
    counts: {
      totalProviders: new Set(usable.map(e => e.provider)).size,
      totalModels: usable.length,
      healthyModels: usable.length,
      unhealthyModels: 0,
    },
  };
}

const strongModel = entry({
  provider: 'anthropic', model: 'claude-sonnet-4', modelName: 'Claude Sonnet 4',
  tier: 'high', supportsTools: true, supportsVision: true, reasoning: false,
  inputCostPer1M: 3.0, outputCostPer1M: 15.0,
  recommendedLanes: ['brain', 'complex_subagent', 'code', 'vision'],
});

const cheapModel = entry({
  provider: 'openai', model: 'gpt-4.1-mini', modelName: 'GPT-4.1 Mini',
  tier: 'low', supportsTools: true, supportsVision: true,
  inputCostPer1M: 0.4, outputCostPer1M: 1.6,
  recommendedLanes: ['simple_subagent', 'summary'],
});

const reasoningModel = entry({
  provider: 'openai', model: 'gpt-5', modelName: 'GPT-5',
  tier: 'high', supportsTools: true, supportsVision: true, reasoning: true,
  inputCostPer1M: 10.0, outputCostPer1M: 40.0,
  recommendedLanes: ['brain', 'complex_subagent', 'code', 'vision'],
});

const visionOnlyModel = entry({
  provider: 'google', model: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash',
  tier: 'mid', supportsVision: true,
  inputCostPer1M: 0.15, outputCostPer1M: 0.6,
  recommendedLanes: ['simple_subagent', 'summary', 'vision'],
});

const testSnapshot = snapshot([strongModel, cheapModel, reasoningModel, visionOnlyModel]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('core/routing-policy', () => {
  describe('explicit config overrides', () => {
    it('uses explicit role config when model is healthy', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        configRoles: { brain: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        snapshot: testSnapshot,
      });

      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4');
      expect(result.reason.stage).toBe('explicit_config');
      expect(result.reason.preferredAvailable).toBe(true);
    });

    it('falls back when explicit config model is unhealthy', () => {
      // Snapshot without the configured model
      const limited = snapshot([cheapModel, visionOnlyModel]);
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        configRoles: { brain: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        snapshot: limited,
      });

      // Should fall through to policy rules since anthropic has no models
      expect(result.reason.stage).not.toBe('explicit_config');
      expect(result.reason.preferredAvailable).toBe(false);
    });

    it('honors explicit config for a forward-compat model absent from the bundled catalog', () => {
      // Regression: openai/gpt-5.4 resolves via forward-compat pattern in
      // getModel() but is not in def.models, so the snapshot never lists it.
      // With the provider healthy, explicit config must win — previously this
      // silently degraded every step to the catalog fallback (gpt-4.1).
      const result = resolveRouting({
        role: 'step',
        hints: {},
        configRoles: { step: { provider: 'openai', model: 'gpt-5.4' } },
        snapshot: testSnapshot,
      });

      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-5.4');
      expect(result.reason.stage).toBe('explicit_config');
      expect(result.reason.preferredAvailable).toBe(true);
    });

    it('still falls back within provider for a model no pattern can resolve', () => {
      const result = resolveRouting({
        role: 'step',
        hints: {},
        configRoles: { step: { provider: 'openai', model: 'totally-bogus-model' } },
        snapshot: testSnapshot,
      });

      expect(result.provider).toBe('openai');
      expect(result.model).not.toBe('totally-bogus-model');
      expect(result.reason.stage).toBe('healthy_fallback');
    });

    it('honors an implemented cli-pipe provider when explicitly configured', () => {
      const cliModel = entry({
        provider: 'claude-cli',
        providerName: 'Claude CLI',
        model: '_cli-default',
        modelName: 'Claude CLI',
        apiMode: 'cli-pipe',
        tier: 'high',
        supportsTools: false,
        supportsStreaming: false,
        recommendedLanes: ['brain', 'complex_subagent', 'code'],
      });
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        configRoles: { brain: { provider: 'claude-cli', model: '_cli-default' } },
        brainProvider: 'claude-cli',
        brainModel: '_cli-default',
        snapshot: snapshot([cliModel, strongModel]),
      });

      expect(result.provider).toBe('claude-cli');
      expect(result.model).toBe('_cli-default');
      expect(result.reason.stage).toBe('explicit_config');
    });
  });

  describe('policy rule: strong_reasoning', () => {
    it('selects high-tier model for brain role', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('policy_match');
      expect(result.reason.rule).toBe('strong_reasoning');
      expect(['anthropic', 'openai']).toContain(result.provider);
      // Should pick a high-tier model
      const picked = testSnapshot.usable.find(e => e.provider === result.provider && e.model === result.model);
      expect(picked?.tier).toBe('high');
    });

    it('selects high-tier with tools for complex code', () => {
      const result = resolveRouting({
        role: 'code',
        hints: { type: 'code', complexity: 'high' },
        snapshot: testSnapshot,
      });

      expect(result.reason.rule).toBe('strong_reasoning');
      const picked = testSnapshot.usable.find(e => e.provider === result.provider && e.model === result.model);
      expect(picked?.tier).toBe('high');
      expect(picked?.supportsTools).toBe(true);
    });
  });

  describe('policy rule: vision_capable', () => {
    it('selects vision-capable model for vision role', () => {
      const result = resolveRouting({
        role: 'vision',
        hints: {},
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('policy_match');
      expect(result.reason.rule).toBe('vision_capable');
      const picked = testSnapshot.usable.find(e => e.provider === result.provider && e.model === result.model);
      expect(picked?.supportsVision).toBe(true);
    });

    it('prefers cheaper vision model', () => {
      const result = resolveRouting({
        role: 'vision',
        hints: {},
        snapshot: testSnapshot,
      });

      // Gemini 2.5 Flash is cheapest vision model at $0.15
      expect(result.provider).toBe('google');
      expect(result.model).toBe('gemini-2.5-flash');
    });
  });

  describe('policy rule: cheap_executor', () => {
    it('selects cheap model for simple_subagent', () => {
      const result = resolveRouting({
        role: 'simple_subagent',
        hints: { complexity: 'low' },
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('policy_match');
      expect(result.reason.rule).toBe('cheap_executor');
      const picked = testSnapshot.usable.find(e => e.provider === result.provider && e.model === result.model);
      // Should prefer cheaper models
      expect(picked!.inputCostPer1M!).toBeLessThan(5);
    });

    it('selects cheap model for summary role', () => {
      const result = resolveRouting({
        role: 'summary',
        hints: { type: 'summary' },
        snapshot: testSnapshot,
      });

      expect(result.reason.rule).toBe('cheap_executor');
    });
  });

  describe('brain provider preference', () => {
    it('prefers brain provider models within policy rules', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        brainProvider: 'anthropic',
        snapshot: testSnapshot,
      });

      expect(result.provider).toBe('anthropic');
    });
  });

  describe('healthy fallback', () => {
    it('falls back to any healthy model when no policy rule matches', () => {
      // Snapshot with only a model that doesn't match typical rules well
      const oddModel = entry({
        provider: 'odd', model: 'odd-model',
        tier: 'mid', supportsTools: false, supportsVision: false,
      });
      const oddSnapshot = snapshot([oddModel]);

      const result = resolveRouting({
        role: 'vision',
        hints: {},
        snapshot: oddSnapshot,
      });

      // vision_capable rule won't match (no vision), should fallback
      expect(result.reason.stage).toBe('healthy_fallback');
      expect(result.provider).toBe('odd');
    });
  });

  describe('no healthy models', () => {
    it('returns configured defaults with no_healthy_model reason', () => {
      const emptySnapshot = snapshot([]);

      const result = resolveRouting({
        role: 'brain',
        hints: {},
        brainProvider: 'anthropic',
        brainModel: 'claude-sonnet-4',
        snapshot: emptySnapshot,
      });

      expect(result.reason.stage).toBe('no_healthy_model');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4');
    });
  });

  describe('routing preferences', () => {
    it('honors preferred_code when model is healthy', () => {
      const result = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        preferences: { preferred_code: { provider: 'openai', model: 'gpt-5' } },
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('preference_override');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-5');
    });

    it('honors preferred_vision when model is healthy', () => {
      const result = resolveRouting({
        role: 'vision',
        hints: {},
        preferences: { preferred_vision: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('preference_override');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4');
    });

    it('honors preferred_cheap for simple_subagent', () => {
      const result = resolveRouting({
        role: 'simple_subagent',
        hints: {},
        preferences: { preferred_cheap: { provider: 'google', model: 'gemini-2.5-flash' } },
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('preference_override');
      expect(result.provider).toBe('google');
      expect(result.model).toBe('gemini-2.5-flash');
    });

    it('honors preferred_summary for summary role', () => {
      const result = resolveRouting({
        role: 'summary',
        hints: {},
        preferences: { preferred_summary: { provider: 'openai', model: 'gpt-4.1-mini' } },
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('preference_override');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4.1-mini');
    });

    it('falls through to policy when preferred model is unhealthy', () => {
      const result = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        preferences: { preferred_code: { provider: 'unknown', model: 'nonexistent' } },
        snapshot: testSnapshot,
      });

      // Should NOT be preference_override since model isn't in snapshot
      expect(result.reason.stage).not.toBe('preference_override');
    });

    it('preference with only provider matches any model from that provider', () => {
      const result = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        preferences: { preferred_code: { provider: 'openai' } },
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('preference_override');
      expect(result.provider).toBe('openai');
    });

    it('explicit config takes precedence over preferences', () => {
      const result = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        configRoles: { code: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        preferences: { preferred_code: { provider: 'openai', model: 'gpt-5' } },
        snapshot: testSnapshot,
      });

      // Explicit config wins over preference
      expect(result.reason.stage).toBe('explicit_config');
      expect(result.provider).toBe('anthropic');
    });

    it('preferences do not apply to brain role (brain uses brain_provider)', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        brainProvider: 'anthropic',
        brainModel: 'claude-sonnet-4',
        preferences: { preferred_code: { provider: 'openai', model: 'gpt-5' } },
        snapshot: testSnapshot,
      });

      // Brain role should use brain config, not preferences
      expect(result.provider).toBe('anthropic');
    });
  });

  describe('cost sensitivity', () => {
    // Build a snapshot where two models compete for the brain role:
    // - expensiveStrong: high tier, reasoning, $15 input
    // - cheapStrong:     high tier, no reasoning, $2 input
    // With "low" sensitivity, quality (reasoning) wins.
    // With "high" sensitivity, cost dominates and cheap wins.
    const expensiveStrong = entry({
      provider: 'prov-a', model: 'expensive-strong',
      tier: 'high', supportsTools: true, reasoning: true,
      inputCostPer1M: 15.0, outputCostPer1M: 60.0,
    });
    const cheapStrong = entry({
      provider: 'prov-b', model: 'cheap-strong',
      tier: 'high', supportsTools: true, reasoning: false,
      inputCostPer1M: 2.0, outputCostPer1M: 8.0,
    });
    const costTestSnapshot = snapshot([expensiveStrong, cheapStrong]);

    it('low cost sensitivity prefers quality (reasoning) over price', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        preferences: { cost_sensitivity: 'low' },
        snapshot: costTestSnapshot,
      });

      expect(result.reason.stage).toBe('policy_match');
      // Reasoning model should win when cost barely matters
      expect(result.model).toBe('expensive-strong');
    });

    it('high cost sensitivity prefers cheaper model over quality', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        preferences: { cost_sensitivity: 'high' },
        snapshot: costTestSnapshot,
      });

      expect(result.reason.stage).toBe('policy_match');
      // Cheap model should win when cost dominates
      expect(result.model).toBe('cheap-strong');
    });

    it('different sensitivity levels produce different winners', () => {
      const lowResult = resolveRouting({
        role: 'brain', hints: {},
        preferences: { cost_sensitivity: 'low' },
        snapshot: costTestSnapshot,
      });
      const highResult = resolveRouting({
        role: 'brain', hints: {},
        preferences: { cost_sensitivity: 'high' },
        snapshot: costTestSnapshot,
      });

      expect(lowResult.model).not.toBe(highResult.model);
    });
  });

  describe('precedence order', () => {
    it('explicit_config > preference_override > policy_match > healthy_fallback', () => {
      // All layers active — explicit config should win
      const result = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        configRoles: { code: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        preferences: { preferred_code: { provider: 'openai', model: 'gpt-5' } },
        brainProvider: 'google',
        snapshot: testSnapshot,
      });

      expect(result.reason.stage).toBe('explicit_config');

      // Remove explicit config — preference should win
      const result2 = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        preferences: { preferred_code: { provider: 'openai', model: 'gpt-5' } },
        snapshot: testSnapshot,
      });

      expect(result2.reason.stage).toBe('preference_override');

      // Remove preference — policy should win
      const result3 = resolveRouting({
        role: 'code',
        hints: { type: 'code' },
        snapshot: testSnapshot,
      });

      expect(result3.reason.stage).toBe('policy_match');
    });
  });

  describe('routing reason structure', () => {
    it('always includes stage and explanation', () => {
      const result = resolveRouting({
        role: 'brain',
        hints: {},
        snapshot: testSnapshot,
      });

      expect(result.reason).toHaveProperty('stage');
      expect(result.reason).toHaveProperty('explanation');
      expect(typeof result.reason.stage).toBe('string');
      expect(typeof result.reason.explanation).toBe('string');
      expect(result.reason.explanation.length).toBeGreaterThan(0);
    });
  });
});
