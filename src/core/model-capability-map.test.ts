import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildModelCapabilitySnapshot,
  formatModelCapabilityOutput,
  type ModelCapabilitySnapshot,
  type ModelCapabilityEntry,
} from './model-capability-map.js';

describe('core/model-capability-map', () => {
  // Save and restore env to avoid cross-test pollution
  const savedEnv: Record<string, string | undefined> = {};
  const keysToManage = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'MINIMAX_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
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

  function withCleanEnv(fn: () => void) {
    for (const key of keysToManage) {
      delete process.env[key];
    }
    fn();
  }

  it('returns a valid snapshot shape', () => {
    const snapshot = buildModelCapabilitySnapshot();

    expect(snapshot).toHaveProperty('generatedAt');
    expect(snapshot).toHaveProperty('all');
    expect(snapshot).toHaveProperty('usable');
    expect(snapshot).toHaveProperty('counts');
    expect(typeof snapshot.generatedAt).toBe('string');
    expect(Array.isArray(snapshot.all)).toBe(true);
    expect(Array.isArray(snapshot.usable)).toBe(true);
    expect(snapshot.counts.totalModels).toBe(snapshot.all.length);
    expect(snapshot.counts.healthyModels).toBe(snapshot.usable.length);
    expect(snapshot.counts.unhealthyModels).toBe(snapshot.all.length - snapshot.usable.length);
  });

  it('marks models as healthy when API key is present', () => {
    withCleanEnv(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

      const snapshot = buildModelCapabilitySnapshot();
      const anthropicEntries = snapshot.all.filter(e => e.provider === 'anthropic');

      expect(anthropicEntries.length).toBeGreaterThan(0);
      for (const entry of anthropicEntries) {
        expect(entry.healthy).toBe(true);
      }
      expect(snapshot.usable).toEqual(expect.arrayContaining(anthropicEntries));
    });
  });

  it('marks models as unhealthy when no API key is present', () => {
    withCleanEnv(() => {
      const snapshot = buildModelCapabilitySnapshot();
      const openaiEntries = snapshot.all.filter(e => e.provider === 'openai');

      // OpenAI should exist in the catalog but be unhealthy
      expect(openaiEntries.length).toBeGreaterThan(0);
      for (const entry of openaiEntries) {
        expect(entry.healthy).toBe(false);
      }
      // Usable set should NOT contain unhealthy entries
      for (const entry of openaiEntries) {
        expect(snapshot.usable).not.toContainEqual(entry);
      }
    });
  });

  it('excludes unhealthy models from the usable set', () => {
    withCleanEnv(() => {
      const snapshot = buildModelCapabilitySnapshot();

      for (const entry of snapshot.usable) {
        expect(entry.healthy).toBe(true);
      }
      for (const entry of snapshot.all.filter(e => !e.healthy)) {
        expect(snapshot.usable).not.toContainEqual(entry);
      }
    });
  });

  it('includes correct capability fields on each entry', () => {
    withCleanEnv(() => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const snapshot = buildModelCapabilitySnapshot();
      const gpt = snapshot.usable.find(e => e.model === 'gpt-4.1');

      expect(gpt).toBeDefined();
      expect(gpt!.provider).toBe('openai');
      expect(gpt!.supportsTools).toBe(true);
      expect(gpt!.supportsVision).toBe(true);
      expect(gpt!.reasoning).toBe(false);
      expect(gpt!.tier).toBe('high');
      expect(gpt!.contextWindow).toBe(1_047_576);
      expect(gpt!.inputCostPer1M).toBe(2.0);
      expect(gpt!.outputCostPer1M).toBe(8.0);
      expect(gpt!.recommendedLanes).toContain('brain');
      expect(gpt!.recommendedLanes).toContain('vision');
    });
  });

  it('infers recommended lanes from model tier and capabilities', () => {
    withCleanEnv(() => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const snapshot = buildModelCapabilitySnapshot();

      // High-tier model should recommend brain, complex_subagent, code
      const highTier = snapshot.usable.find(e => e.tier === 'high' && e.provider === 'openai');
      expect(highTier).toBeDefined();
      expect(highTier!.recommendedLanes).toContain('brain');
      expect(highTier!.recommendedLanes).toContain('complex_subagent');
      expect(highTier!.recommendedLanes).toContain('code');

      // Low-tier model should recommend simple_subagent, summary
      const lowTier = snapshot.usable.find(e => e.tier === 'low' && e.provider === 'openai');
      expect(lowTier).toBeDefined();
      expect(lowTier!.recommendedLanes).toContain('simple_subagent');
      expect(lowTier!.recommendedLanes).toContain('summary');
    });
  });

  it('counts are consistent', () => {
    const snapshot = buildModelCapabilitySnapshot();

    expect(snapshot.counts.totalModels).toBe(snapshot.counts.healthyModels + snapshot.counts.unhealthyModels);
    expect(snapshot.counts.totalProviders).toBeGreaterThan(0);
  });

  it('includes CLI-pipe providers when explicitly requested', () => {
    withCleanEnv(() => {
      // Without explicit request, claude-cli (autoDetect: false) is excluded
      const withoutExplicit = buildModelCapabilitySnapshot();
      const cliEntries = withoutExplicit.all.filter(e => e.provider === 'claude-cli');
      expect(cliEntries.length).toBe(0);

      // With explicit request, claude-cli appears and is healthy
      const withExplicit = buildModelCapabilitySnapshot(['claude-cli']);
      const cliEntriesExplicit = withExplicit.all.filter(e => e.provider === 'claude-cli');
      expect(cliEntriesExplicit.length).toBeGreaterThan(0);
      expect(cliEntriesExplicit[0].healthy).toBe(true);
      expect(withExplicit.usable.some(e => e.provider === 'claude-cli')).toBe(true);
    });
  });

  it('formatModelCapabilityOutput produces readable output', () => {
    withCleanEnv(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

      const snapshot = buildModelCapabilitySnapshot();
      const output = formatModelCapabilityOutput(snapshot);

      expect(output).toContain('Model Capability Snapshot');
      expect(output).toContain('Generated:');
      expect(output).toContain('Healthy Models:');
      expect(output).toContain('anthropic/');
      // Should show unavailable providers
      expect(output).toContain('Unavailable');
    });
  });

  it('formatModelCapabilityOutput handles no healthy models', () => {
    withCleanEnv(() => {
      const snapshot = buildModelCapabilitySnapshot();

      // If no keys are set, all non-CLI models are unhealthy
      if (snapshot.usable.length === 0) {
        const output = formatModelCapabilityOutput(snapshot);
        expect(output).toContain('No healthy models available');
      }
    });
  });
});
