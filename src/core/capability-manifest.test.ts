import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { MoziConfigSchema } from '../config/index.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getProvider } from './providers.js';
import { saveUserRoutingPreference } from '../memory/user-profile.js';
import { buildModelCapabilitySnapshot } from './model-capability-map.js';
import { getTaskHintsForRole } from './model-router.js';
import { resolveRouting } from './routing-policy.js';
import {
  buildRuntimeCapabilityManifest,
  type BuiltInCapability,
  buildRoutingExplainability,
  formatCapabilityPromptSection,
  formatCapabilitySummarySection,
  formatCapabilityCommandOutput,
  formatRoutingExplainability,
  formatSkillsCommandOutput,
} from './capability-manifest.js';

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};
const keysToManage = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'MINIMAX_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'GROQ_API_KEY',
  'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY',
  'QIANFAN_API_KEY', 'NVIDIA_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY',
  'XIAOMI_API_KEY', 'SYNTHETIC_API_KEY', 'VENICE_API_KEY', 'OLLAMA_API_KEY',
  'VLLM_API_KEY', 'BEDROCK_API_KEY',
];

function createTestConfig() {
  const base = MoziConfigSchema.parse({});
  return {
    ...base,
    system: {
      ...base.system,
      max_parallel_agents: 9,
    },
    model_router: {
      roles: {},
      brain_provider: 'minimax',
      fallback_brain_provider: 'anthropic',
    },
  };
}

function capability(manifest: ReturnType<typeof buildRuntimeCapabilityManifest>, id: string): BuiltInCapability {
  const found = manifest.built_in.find(c => c.id === id);
  expect(found, `missing capability ${id}`).toBeDefined();
  return found!;
}

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  for (const key of keysToManage) {
    savedEnv[key] = process.env[key];
  }
});

beforeEach(() => {
  for (const key of keysToManage) {
    delete process.env[key];
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
  teardownTestDb(tmpDir);
});

describe('core/capability-manifest', () => {
  it('builds built-in capabilities and file-based skill extensions', () => {
    const manifest = buildRuntimeCapabilityManifest(
      createTestConfig(),
      ['shell_exec', 'read_file', 'shell_exec'],
      'default',
    );

    expect(capability(manifest, 'direct_brain_execution').status).toBe('disabled');
    expect(capability(manifest, 'subagent_execution').status).toBe('disabled');
    expect(manifest.built_in.some(c => c.id === 'tool_calling' && c.status === 'enabled')).toBe(true);
    expect(capability(manifest, 'blackboard_context').status).toBe('disabled');
    expect(capability(manifest, 'task_decomposition').status).toBe('disabled');
    const dagCapability = manifest.built_in.find(c => c.id === 'task_decomposition');
    expect(dagCapability?.value).toBe('path=decompose_task->dag-bridge->executeDag');
    expect(capability(manifest, 'peer_collaboration').status).toBe('disabled');
    expect(capability(manifest, 'runtime_skill_injection').status).toBe('disabled');
    expect(capability(manifest, 'provider_failover').status).toBe('disabled');
    expect(capability(manifest, 'long_term_memory').status).toBe('disabled');
    expect(capability(manifest, 'tool_learning').status).toBe('disabled');
    expect(capability(manifest, 'adaptive_reflection').status).toBe('disabled');
    expect(capability(manifest, 'persistent_goals').status).toBe('disabled');
    expect(manifest.metadata.registered_tools).toEqual(['read_file', 'shell_exec']);
    expect(manifest.metadata.channels.find(channel => channel.id === 'googlechat')?.capabilities.direction).toBe('outgoing_only');
    expect(manifest.metadata.channels.find(channel => channel.id === 'wechat')?.capabilities.proactive).toBe(false);
    // skill_extensions are now file-based (discovered from SKILL.md files)
    expect(Array.isArray(manifest.skill_extensions)).toBe(true);
  });

  it('does not enable capabilities whose runtime surfaces are absent', () => {
    const manifest = buildRuntimeCapabilityManifest(createTestConfig(), [], 'tenant-no-runtime-surfaces');

    for (const id of [
      'direct_brain_execution',
      'tool_plugin_hooks',
      'brain_proposed_skills',
      'streaming_responses',
      'artifact_plugins',
      'deliverable_lookup',
      'long_term_memory',
      'episodic_memory',
      'tool_learning',
      'adaptive_reflection',
      'persistent_goals',
      'provider_failover',
      'runtime_skill_injection',
      'session_queue',
      'blackboard_context',
      'task_decomposition',
      'peer_collaboration',
      'acp_channel',
      'cli_providers',
    ]) {
      expect(capability(manifest, id).status).toBe('disabled');
    }
    expect(capability(manifest, 'mid_turn_steering')).toMatchObject({
      status: 'enabled',
      summary: expect.stringContaining('next Brain boundary'),
    });
  });

  it('enables tool-backed capabilities only when their tools are registered', () => {
    const tools = [
      'remember',
      'recall',
      'recall_episodes',
      'learn_lesson',
      'create_task',
      'list_tasks',
      'update_task',
      'run_task',
      'decompose_task',
      'read_context',
      'write_context',
      'propose_skill',
      'create_artifact',
      'find_deliverable',
      'use_skill',
      'list_runtime_skills',
    ];
    const manifest = buildRuntimeCapabilityManifest(createTestConfig(), tools, 'default');

    expect(capability(manifest, 'long_term_memory').status).toBe('enabled');
    expect(capability(manifest, 'episodic_memory').status).toBe('enabled');
    expect(capability(manifest, 'tool_learning').status).toBe('enabled');
    expect(capability(manifest, 'persistent_goals').status).toBe('enabled');
    expect(capability(manifest, 'task_decomposition').status).toBe('enabled');
    expect(capability(manifest, 'blackboard_context').status).toBe('enabled');
    expect(capability(manifest, 'brain_proposed_skills').status).toBe('enabled');
    expect(capability(manifest, 'artifact_plugins').status).toBe('enabled');
    expect(capability(manifest, 'deliverable_lookup').status).toBe('enabled');
    expect(capability(manifest, 'runtime_skill_injection').status).toBe(
      manifest.skill_extensions.length > 0 ? 'enabled' : 'disabled',
    );
  });

  it('enables provider-backed capabilities only for healthy configured providers', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = createTestConfig();
    config.model_router = {
      roles: {},
      brain_provider: 'openai',
      fallback_brain_provider: 'anthropic',
    };

    const manifest = buildRuntimeCapabilityManifest(config, [], 'default');

    expect(capability(manifest, 'direct_brain_execution').status).toBe('enabled');
    expect(capability(manifest, 'provider_failover').status).toBe('enabled');
    // Adaptive reflection has no engine yet — always reported as not-implemented.
    expect(capability(manifest, 'adaptive_reflection').status).toBe('disabled');
  });

  it('marks tool_calling as disabled when no tools are registered', () => {
    const manifest = buildRuntimeCapabilityManifest(createTestConfig(), [], 'tenant-no-tools');
    const toolCalling = manifest.built_in.find(c => c.id === 'tool_calling');

    expect(toolCalling).toBeDefined();
    expect(toolCalling?.status).toBe('disabled');
  });

  it('does not mark subagent_execution ready when rollout has no active agent', () => {
    const config = createTestConfig();
    config.tools.subagents.enabled = false;
    config.tools.subagents.enabled_tenants = ['tenant-rollout'];

    const manifest = buildRuntimeCapabilityManifest(config, ['decompose_task'], 'tenant-rollout');
    const subagentCapability = manifest.built_in.find(c => c.id === 'subagent_execution');

    expect(subagentCapability).toBeDefined();
    expect(subagentCapability?.status).toBe('disabled');
    expect(subagentCapability?.value).toBe('mode=targeted');
  });

  it('formats prompt/commands with built-in vs extension sections', () => {
    const manifest = buildRuntimeCapabilityManifest(createTestConfig(), ['shell_exec'], 'default');
    const prompt = formatCapabilityPromptSection(manifest);
    const capabilitiesCommand = formatCapabilityCommandOutput(manifest);

    expect(prompt).toContain('## Runtime Capability Contract (Authoritative)');
    expect(prompt).toContain('### Runtime Built-ins');
    expect(prompt).toContain('### Extensions (Skills / Upgrades)');
    expect(prompt).toContain('### Runtime Self-Report Template');
    expect(prompt).toContain('Do not describe DAG as "fully dormant"');

    expect(capabilitiesCommand).toContain('Runtime Built-ins:');
    expect(capabilitiesCommand).toContain('Extensions (Skills / Upgrades):');
  });

  it('formats a compact per-turn capability summary', () => {
    const manifest = buildRuntimeCapabilityManifest(createTestConfig(), ['shell_exec'], 'default');
    const summary = formatCapabilitySummarySection(manifest);

    expect(summary).toContain('## Runtime Capability Contract (Authoritative)');
    expect(summary).toContain('- brain: ');
    expect(summary).toMatch(/- built_in_capabilities: \d+\/\d+ enabled/);
    expect(summary).toContain('- execution_paths: direct_brain_execution=');
    expect(summary).toContain('subagent_execution=');
    expect(summary).toContain('call the get_capabilities tool');

    // Compact: no per-capability listing, and far smaller than the full contract.
    expect(summary).not.toContain('### Runtime Built-ins');
    const full = formatCapabilityPromptSection(manifest);
    expect(summary.length).toBeLessThan(full.length / 2);
  });

  it('buildRoutingExplainability returns usable models, defaults, and sample decisions', () => {
    const config = createTestConfig();
    const explain = buildRoutingExplainability(config);

    // Structure checks
    expect(explain).toHaveProperty('usableModels');
    expect(explain).toHaveProperty('effectiveDefaults');
    expect(explain).toHaveProperty('sampleDecisions');
    expect(Array.isArray(explain.usableModels)).toBe(true);
    expect(Array.isArray(explain.sampleDecisions)).toBe(true);

    // Effective defaults from config
    expect(explain.effectiveDefaults.brainProvider).toBe('minimax');
    expect(explain.effectiveDefaults.brainModel).toBe(getProvider('minimax')?.defaultModel ?? '');
    expect(explain.effectiveDefaults.fallbackProvider).toBe('anthropic');

    // Sample decisions cover all standard roles
    const roles = explain.sampleDecisions.map(d => d.role);
    expect(roles).toContain('brain');
    expect(roles).toContain('code');
    expect(roles).toContain('vision');
    expect(roles).toContain('simple_subagent');
    expect(roles).toContain('summary');

    // Each decision has a reason
    for (const d of explain.sampleDecisions) {
      expect(d.reason).toHaveProperty('stage');
      expect(d.reason).toHaveProperty('explanation');
      expect(d.reason.explanation.length).toBeGreaterThan(0);
    }
  });

  it('buildRoutingExplainability uses the same role hints as the live router', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const base = MoziConfigSchema.parse({});
    const config = {
      ...base,
      model_router: {
        roles: {},
        brain_provider: 'codex-cli',
      },
    };

    const explain = buildRoutingExplainability(config);
    const codeDecision = explain.sampleDecisions.find((decision) => decision.role === 'code');
    const snapshot = buildModelCapabilitySnapshot(['codex-cli']);
    const expected = resolveRouting({
      role: 'code',
      hints: getTaskHintsForRole('code'),
      configRoles: {},
      brainProvider: 'codex-cli',
      snapshot,
    });

    expect(codeDecision).toBeDefined();
    expect(codeDecision?.provider).not.toBe('codex-cli');
    expect(codeDecision?.provider).toBe(expected.provider);
    expect(codeDecision?.model).toBe(expected.model);
    expect(codeDecision?.reason.rule).toBe(expected.reason.rule);
  });

  it('buildRoutingExplainability merges user-scoped preferences when context is provided', () => {
    const config = {
      ...createTestConfig(),
      model_router: {
        ...createTestConfig().model_router,
        routing_preferences: {
          preferred_summary: { provider: 'minimax', model: 'MiniMax-M2.5' },
        },
      },
    };
    saveUserRoutingPreference('preferred_summary_provider', 'openai', 'cap-user', 'cap-tenant');
    saveUserRoutingPreference('preferred_summary_model', 'gpt-4.1-mini', 'cap-user', 'cap-tenant');

    const explain = buildRoutingExplainability(config, { tenantId: 'cap-tenant', userId: 'cap-user' });

    expect(explain.activePreferences?.preferred_summary).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });
  });

  it('formatRoutingExplainability produces readable output without secrets', () => {
    const config = createTestConfig();
    const explain = buildRoutingExplainability(config);
    const output = formatRoutingExplainability(explain);

    expect(output).toContain('Routing Explainability');
    expect(output).toContain('Effective Defaults:');
    expect(output).toContain('Brain provider: minimax');
    expect(output).toContain('Fallback provider: anthropic');
    expect(output).toContain('Sample Routing Decisions:');
    expect(output).toContain('brain:');
    expect(output).toContain('Stage:');

    // Must not contain API keys
    expect(output).not.toContain('API_KEY');
    expect(output).not.toContain('sk-');
  });

  it('formatCapabilityCommandOutput includes routing explainability when provided', () => {
    const config = createTestConfig();
    const manifest = buildRuntimeCapabilityManifest(config, ['shell_exec'], 'default');
    const explain = buildRoutingExplainability(config);
    const output = formatCapabilityCommandOutput(manifest, explain);

    expect(output).toContain('Routing Explainability');
    expect(output).toContain('Sample Routing Decisions:');
    // Also still has normal manifest sections
    expect(output).toContain('Runtime Built-ins:');
    expect(output).toContain('Extensions (Skills / Upgrades):');
  });

  it('formatCapabilityCommandOutput works without routing explainability', () => {
    const config = createTestConfig();
    const manifest = buildRuntimeCapabilityManifest(config, ['shell_exec'], 'default');
    const output = formatCapabilityCommandOutput(manifest);

    expect(output).not.toContain('Routing Explainability');
    expect(output).toContain('Runtime Built-ins:');
  });
});
