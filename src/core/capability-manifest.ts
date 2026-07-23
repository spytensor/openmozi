import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MoziConfig } from '../config/index.js';
import { getMCPBridge } from '../mcp/index.js';
import { parseSkillFile } from '../skills/loader.js';
import { getWorkspaceDir } from '../tools/tool-utils.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { listToolHooks } from '../tools/plugin-registry.js';
import { getLiveCapabilities } from '../agents/process-manager.js';
import { buildModelCapabilitySnapshot, formatModelCapabilityOutput, type ModelCapabilitySnapshot } from './model-capability-map.js';
import { resolveRouting, type RoutingPreferences, type RoutingReason, type RoleOverride } from './routing-policy.js';
import { getProvider } from './providers.js';
import { isSubAgentAvailable } from './subagent-dispatch.js';
import { getTaskHintsForRole, type RoutingContext, type TaskRole } from './model-router.js';
import { getUserRoutingPreferences, mergeRoutingPreferences } from '../memory/user-profile.js';
import { BUILT_IN_PLUGINS } from '../channels/plugins/index.js';
import type { ChannelCapabilities } from '../channels/registry.js';

export { buildModelCapabilitySnapshot, formatModelCapabilityOutput, type ModelCapabilitySnapshot };

export type CapabilityStatus = 'enabled' | 'disabled';

export interface BuiltInCapability {
  id: string;
  status: CapabilityStatus;
  summary: string;
  value?: string;
}

export interface SkillExtensionCapability {
  id: string;
  skill_id: string;
  name: string;
  version: string;
  status: 'enabled';
  summary: string;
}

export interface RuntimeCapabilityManifest {
  built_in: BuiltInCapability[];
  skill_extensions: SkillExtensionCapability[];
  metadata: {
    primary_brain_provider: string;
    primary_brain_model: string;
    fallback_brain_provider: string;
    fallback_brain_model: string;
    max_parallel_agents: number;
    registered_tools: string[];
    channels: Array<{ id: string; label: string; capabilities: ChannelCapabilities }>;
    model_snapshot: ModelCapabilitySnapshot;
  };
}

interface PromptFormatOptions {
  max_skill_extensions?: number;
}

function summarize(text: string, maxLen = 72): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'No description.';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function normalizeTools(registeredTools: string[]): string[] {
  return [...new Set(registeredTools.map((tool) => tool.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function safeRuntimeCheck(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function isProviderModelReady(snapshot: ModelCapabilitySnapshot, provider: string, model?: string): boolean {
  if (!provider || provider === 'none') return false;
  const usable = snapshot.usable.filter((entry) => entry.provider === provider);
  if (usable.length === 0) return false;
  const requestedModel = model?.trim();
  if (!requestedModel) return true;
  return usable.some((entry) => entry.model === requestedModel);
}

function isPrimaryModelStreamingReady(snapshot: ModelCapabilitySnapshot, provider: string, model?: string): boolean {
  if (!provider || provider === 'none') return false;
  const requestedModel = model?.trim();
  return snapshot.usable.some((entry) =>
    entry.provider === provider
    && entry.supportsStreaming
    && (!requestedModel || entry.model === requestedModel),
  );
}

function scanSkillDirSync(baseDir: string): Array<{ name: string; description: string }> {
  const results: Array<{ name: string; description: string }> = [];
  if (!existsSync(baseDir)) return results;

  try {
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      const skillPath = join(baseDir, entry, 'SKILL.md');
      const disabledMarkerPath = join(baseDir, entry, '.disabled');
      try {
        if (existsSync(disabledMarkerPath)) {
          continue;
        }
        const content = readFileSync(skillPath, 'utf-8');
        const { frontmatter } = parseSkillFile(content);
        results.push({ name: frontmatter.name, description: frontmatter.description });
      } catch {
        // No SKILL.md or parse error — skip
      }
    }
  } catch {
    // Directory read error — skip
  }

  return results;
}

function readActiveSkillExtensions(_tenantId = 'default'): SkillExtensionCapability[] {
  try {
    const bundledDir = join(getRuntimeProjectRoot(), 'skills');
    const workspaceSkillsDir = join(getWorkspaceDir(), 'skills');

    const byName = new Map<string, SkillExtensionCapability>();

    // Process bundled first, then workspace — workspace overrides bundled on name conflict
    for (const dir of [bundledDir, workspaceSkillsDir]) {
      for (const skill of scanSkillDirSync(dir)) {
        byName.set(skill.name, {
          id: `skill:${skill.name}`,
          skill_id: skill.name,
          name: skill.name,
          version: '1.0.0',
          status: 'enabled',
          summary: summarize(skill.description),
        });
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function buildRuntimeCapabilityManifest(
  config: MoziConfig,
  registeredTools: string[],
  tenantId = 'default',
): RuntimeCapabilityManifest {
  const tools = normalizeTools(registeredTools);
  const primaryProvider = config.model_router?.brain_provider ?? '';
  const fallbackProvider = config.model_router?.fallback_brain_provider ?? 'none';
  const explicitProviders = [primaryProvider, fallbackProvider].filter((provider) => provider && provider !== 'none');
  const modelSnapshot = buildModelCapabilitySnapshot(explicitProviders.length > 0 ? explicitProviders : undefined);
  const hasConfiguredFallback = fallbackProvider !== 'none';
  const subagentConfig = config.tools.subagents;
  const subagentExecutionEnabled = subagentConfig.enabled
    || subagentConfig.enabled_tenants.includes(tenantId)
    || subagentConfig.enabled_sessions.length > 0;
  const skillExtensions = readActiveSkillExtensions(tenantId);
  const toolSet = new Set(tools);
  const hasAnyTool = (...names: string[]) => names.some((name) => toolSet.has(name));
  const hasAllTools = (...names: string[]) => names.every((name) => toolSet.has(name));
  const primaryBrainReady = isProviderModelReady(modelSnapshot, primaryProvider, config.brain.model || undefined);
  const fallbackBrainReady = hasConfiguredFallback
    && isProviderModelReady(modelSnapshot, fallbackProvider, config.brain.fallback_model || undefined);
  const toolHooksRegistered = safeRuntimeCheck(() => listToolHooks().length > 0);
  const subagentRuntimeReady = subagentExecutionEnabled && safeRuntimeCheck(() => isSubAgentAvailable(tenantId));
  const peerCapabilitiesReady = safeRuntimeCheck(() => {
    for (const capabilities of getLiveCapabilities().values()) {
      if (capabilities.length > 0) return true;
    }
    return false;
  });
  const streamingReady = primaryBrainReady
    && isPrimaryModelStreamingReady(modelSnapshot, primaryProvider, config.brain.model || undefined)
    && config.telegram.stream_mode !== 'off';
  const subagentRolloutMode = subagentConfig.enabled
    ? 'global'
    : subagentConfig.enabled_tenants.length > 0 || subagentConfig.enabled_sessions.length > 0
    ? 'targeted'
    : 'disabled';
  const runtimeTruth = {
    directBrainExecution: primaryBrainReady,
    subagentExecution: subagentRuntimeReady,
    toolPluginHooks: toolHooksRegistered,
    midTurnSteering: true,
    brainProposedSkills: hasAnyTool('propose_skill'),
    streamingResponses: streamingReady,
    artifactPlugins: hasAnyTool('create_artifact'),
    deliverableLookup: hasAnyTool('find_deliverable'),
    longTermMemory: hasAllTools('remember', 'recall'),
    episodicMemory: hasAnyTool('recall_episodes'),
    toolLearning: hasAnyTool('learn_lesson'),
    // No reflection engine is wired yet — config.reflection only carries a
    // checkpoint interval nothing reads. Report it honestly as not-implemented
    // rather than advertising a capability MOZI does not actually have.
    adaptiveReflection: false,
    persistentGoals: hasAllTools('create_task', 'list_tasks', 'update_task', 'run_task'),
    providerFailover: primaryBrainReady && fallbackBrainReady,
    runtimeSkillInjection: hasAllTools('use_skill', 'list_runtime_skills') && skillExtensions.length > 0,
    sessionQueue: false,
    blackboard: hasAllTools('read_context', 'write_context'),
    taskDecomposition: hasAnyTool('decompose_task'),
    peerCollaboration: peerCapabilitiesReady,
    acpChannel: process.env.MOZI_MODE === 'acp',
    cliProviders: modelSnapshot.usable.some((entry) => entry.apiMode === 'cli-pipe'),
  };

  return {
    built_in: [
      {
        id: 'direct_brain_execution',
        status: runtimeTruth.directBrainExecution ? 'enabled' : 'disabled',
        summary: runtimeTruth.directBrainExecution
          ? 'Default path has a configured healthy brain provider/model for direct gateway brain/tool-loop execution.'
          : 'No configured healthy primary brain provider/model is available in the runtime model snapshot.',
      },
      {
        id: 'subagent_execution',
        status: runtimeTruth.subagentExecution ? 'enabled' : 'disabled',
        summary: runtimeTruth.subagentExecution
          ? 'Rollout-gated SubAgent DAG runtime has at least one active SubAgent available for this tenant.'
          : subagentExecutionEnabled
            ? 'Rollout flags are enabled, but no active SubAgent is currently registered for this tenant.'
            : 'Disabled by rollout flags; no active SubAgent runtime is registered for this tenant.',
        value: `mode=${subagentRolloutMode}`,
      },
      {
        id: 'tool_calling',
        status: tools.length > 0 ? 'enabled' : 'disabled',
        summary: 'LLM can call registered runtime tools. Hot-path permission gate enforces L0–L3 levels on every tool (fs/shell/web/browser/desktop/git/memory).',
        value: `registered_tools=${tools.length}`,
      },
      {
        id: 'tool_plugin_hooks',
        status: runtimeTruth.toolPluginHooks ? 'enabled' : 'disabled',
        summary: runtimeTruth.toolPluginHooks
          ? 'At least one tool plugin hook is registered; hooks can veto or transform tool calls through the fail-closed registry.'
          : 'No tool plugin hooks are currently registered in the runtime hook registry.',
      },
      {
        id: 'mid_turn_steering',
        status: runtimeTruth.midTurnSteering ? 'enabled' : 'disabled',
        summary: runtimeTruth.midTurnSteering
          ? 'The /steer command can queue bounded user input only for an active same-tenant chat turn; it is consumed at the next Brain boundary or discarded when that turn ends.'
          : 'Mid-turn steering is unavailable.',
      },
      {
        id: 'brain_proposed_skills',
        status: runtimeTruth.brainProposedSkills ? 'enabled' : 'disabled',
        summary: runtimeTruth.brainProposedSkills
          ? 'The propose_skill tool is registered for persisting autogen SKILL.md drafts.'
          : 'The propose_skill tool is not registered in this runtime.',
      },
      {
        id: 'computer_control',
        status: tools.some((tool) => tool.startsWith('desktop_')) ? 'enabled' : 'disabled',
        summary: tools.some((tool) => tool.startsWith('desktop_'))
          ? 'Desktop control tools are registered for screenshots, windows, keyboard, mouse, and app launch.'
          : 'Desktop control tools are not registered in this runtime.',
        value: `desktop_tools=${tools.filter((tool) => tool.startsWith('desktop_')).length}`,
      },
      {
        id: 'streaming_responses',
        status: runtimeTruth.streamingResponses ? 'enabled' : 'disabled',
        summary: runtimeTruth.streamingResponses
          ? 'Primary brain model supports streaming and Telegram streaming mode is enabled.'
          : 'Streaming is not ready in this snapshot because the primary model is unavailable, lacks streaming support, or channel streaming is off.',
      },
      {
        id: 'artifact_plugins',
        status: runtimeTruth.artifactPlugins ? 'enabled' : 'disabled',
        summary: runtimeTruth.artifactPlugins
          ? 'The create_artifact tool is registered, so rich artifact cards can be emitted by capable channels.'
          : 'The create_artifact tool is not registered in this runtime.',
      },
      {
        id: 'deliverable_lookup',
        status: runtimeTruth.deliverableLookup ? 'enabled' : 'disabled',
        summary: runtimeTruth.deliverableLookup
          ? 'The find_deliverable tool is registered for tenant-scoped registry lookup.'
          : 'The find_deliverable registry lookup tool is not registered in this runtime.',
      },
      {
        id: 'long_term_memory',
        status: runtimeTruth.longTermMemory ? 'enabled' : 'disabled',
        summary: runtimeTruth.longTermMemory
          ? 'remember and recall tools are registered for long-term fact storage and retrieval.'
          : 'Long-term memory tools are not fully registered; remember and recall are both required.',
      },
      {
        id: 'episodic_memory',
        status: runtimeTruth.episodicMemory ? 'enabled' : 'disabled',
        summary: runtimeTruth.episodicMemory
          ? 'The recall_episodes tool is registered for searching persisted session digests.'
          : 'The recall_episodes tool is not registered in this runtime.',
      },
      {
        id: 'tool_learning',
        status: runtimeTruth.toolLearning ? 'enabled' : 'disabled',
        summary: runtimeTruth.toolLearning
          ? 'The learn_lesson tool is registered for persisting reusable tool-failure lessons.'
          : 'The learn_lesson tool is not registered in this runtime.',
      },
      {
        id: 'adaptive_reflection',
        status: runtimeTruth.adaptiveReflection ? 'enabled' : 'disabled',
        summary: 'Adaptive reflection is not implemented in this runtime.',
      },
      {
        id: 'persistent_goals',
        status: runtimeTruth.persistentGoals ? 'enabled' : 'disabled',
        summary: runtimeTruth.persistentGoals
          ? 'Persistent task/goal tools are registered for create/list/update/run workflows.'
          : 'Persistent goal tools are not fully registered; create_task, list_tasks, update_task, and run_task are required.',
      },
      {
        id: 'provider_failover',
        status: runtimeTruth.providerFailover ? 'enabled' : 'disabled',
        summary: runtimeTruth.providerFailover
          ? 'Brain provider fallback chain reroutes around upstream failures.'
          : 'Configured fallback exists but is not yet wired into live request path.',
        value: hasConfiguredFallback ? `fallback=${fallbackProvider}` : 'fallback=none',
      },
      {
        id: 'runtime_skill_injection',
        status: runtimeTruth.runtimeSkillInjection ? 'enabled' : 'disabled',
        summary: runtimeTruth.runtimeSkillInjection
          ? 'User/system skill packs extend behavior through catalog disclosure plus Active Skills activation.'
          : 'Runtime skill activation tools are missing or no active skill extensions were discovered.',
      },
      {
        id: 'session_queue',
        status: runtimeTruth.sessionQueue ? 'enabled' : 'disabled',
        summary: runtimeTruth.sessionQueue
          ? 'Per-chat request queue is registered and ready.'
          : 'No runtime readiness signal for the per-chat request queue is exposed to this manifest; reported disabled.',
      },
      {
        id: 'blackboard_context',
        status: runtimeTruth.blackboard ? 'enabled' : 'disabled',
        summary: runtimeTruth.blackboard
          ? 'Shared context blackboard is available through registered read_context and write_context tools.'
          : 'Blackboard context tools are not fully registered; read_context and write_context are both required.',
      },
      {
        id: 'task_decomposition',
        status: runtimeTruth.taskDecomposition ? 'enabled' : 'disabled',
        summary: runtimeTruth.taskDecomposition
          ? 'On-demand DAG path is active through the registered decompose_task tool.'
          : 'The decompose_task tool is not registered in this runtime.',
        value: 'path=decompose_task->dag-bridge->executeDag',
      },
      {
        id: 'peer_collaboration',
        status: runtimeTruth.peerCollaboration ? 'enabled' : 'disabled',
        summary: runtimeTruth.peerCollaboration
          ? 'At least one running SubAgent has advertised live peer capabilities.'
          : 'No running SubAgent has advertised peer capabilities in the process manager.',
      },
      {
        id: 'acp_channel',
        status: runtimeTruth.acpChannel ? 'enabled' : 'disabled',
        summary: runtimeTruth.acpChannel
          ? 'ACP mode is active for JSON-RPC 2.0 over stdio integrations.'
          : 'ACP mode is not active in this process.',
      },
      {
        id: 'cli_providers',
        status: runtimeTruth.cliProviders ? 'enabled' : 'disabled',
        summary: runtimeTruth.cliProviders
          ? 'At least one CLI-pipe provider is present in the usable model snapshot.'
          : 'No CLI-pipe provider is currently usable in the model snapshot.',
      },
      {
        id: 'mcp_bridge',
        status: (() => {
          const bridge = getMCPBridge();
          if (!bridge) return 'disabled' as CapabilityStatus;
          const servers = bridge.listServers();
          return servers.some(s => s.connected) ? 'enabled' as CapabilityStatus : 'disabled' as CapabilityStatus;
        })(),
        summary: 'Connect to external MCP servers for filesystem, GitHub, database, browser, and other tools.',
        value: (() => {
          const bridge = getMCPBridge();
          if (!bridge) return 'servers=0';
          const servers = bridge.listServers();
          const connected = servers.filter(s => s.connected).length;
          const tools = Object.keys(bridge.getTools()).length;
          return `servers=${connected},tools=${tools}`;
        })(),
      },
    ],
    skill_extensions: skillExtensions,
    metadata: {
      primary_brain_provider: primaryProvider,
      primary_brain_model: config.brain.model || '(not configured)',
      fallback_brain_provider: fallbackProvider,
      fallback_brain_model: config.brain.fallback_model || 'none',
      max_parallel_agents: config.system.max_parallel_agents,
      registered_tools: tools,
      channels: BUILT_IN_PLUGINS.map(plugin => ({
        id: plugin.id,
        label: plugin.label,
        capabilities: plugin.capabilities,
      })),
      model_snapshot: modelSnapshot,
    },
  };
}

/**
 * Compact capability summary for per-turn system prompt injection.
 *
 * Carries only what the Brain needs on every turn: active brain/fallback
 * models, execution-path states, and counts. The full per-capability
 * contract (formatCapabilityPromptSection) is served on demand through the
 * get_capabilities tool instead of being injected each turn.
 */
export function formatCapabilitySummarySection(
  manifest: RuntimeCapabilityManifest,
): string {
  const find = (id: string) => manifest.built_in.find(capability => capability.id === id);
  const stateOf = (id: string): string => {
    const capability = find(id);
    if (!capability) return 'unknown';
    return capability.value ? `${capability.status} [${capability.value}]` : capability.status;
  };
  const enabledCount = manifest.built_in.filter(capability => capability.status === 'enabled').length;

  return [
    '## Runtime Capability Contract (Authoritative)',
    `- brain: ${manifest.metadata.primary_brain_provider}/${manifest.metadata.primary_brain_model} (fallback: ${manifest.metadata.fallback_brain_provider}/${manifest.metadata.fallback_brain_model})`,
    `- built_in_capabilities: ${enabledCount}/${manifest.built_in.length} enabled`,
    `- execution_paths: direct_brain_execution=${stateOf('direct_brain_execution')}; task_decomposition=${stateOf('task_decomposition')}; subagent_execution=${stateOf('subagent_execution')} (in-process fallback remains available)`,
    `- skill_extensions: ${manifest.skill_extensions.length} active`,
    `- max_parallel_agents: ${manifest.metadata.max_parallel_agents}`,
    '- This summary is the runtime source of truth. Never claim disabled capabilities as available, and do not describe DAG as "fully dormant" when task_decomposition is enabled.',
    '- For the full contract (per-capability status, skill extensions, model snapshot), call the get_capabilities tool.',
  ].join('\n');
}

export function formatCapabilityPromptSection(
  manifest: RuntimeCapabilityManifest,
  options: PromptFormatOptions = {},
): string {
  const maxSkillExtensions = options.max_skill_extensions ?? 8;
  const lines: string[] = [
    '## Runtime Capability Contract (Authoritative)',
    '### Runtime Built-ins',
  ];

  for (const capability of manifest.built_in) {
    const value = capability.value ? ` [${capability.value}]` : '';
    lines.push(`- ${capability.id}: ${capability.status}${value}`);
  }

  lines.push(`- max_parallel_agents: ${manifest.metadata.max_parallel_agents}`);
  lines.push(`- primary_brain_provider: ${manifest.metadata.primary_brain_provider}`);
  lines.push(`- primary_brain_model: ${manifest.metadata.primary_brain_model}`);
  lines.push(`- fallback_brain_provider: ${manifest.metadata.fallback_brain_provider}`);
  lines.push(`- fallback_brain_model: ${manifest.metadata.fallback_brain_model}`);
  lines.push(`- registered_tools_count: ${manifest.metadata.registered_tools.length}`);
  lines.push(`- registered_tools: ${manifest.metadata.registered_tools.length > 0 ? manifest.metadata.registered_tools.join(', ') : 'none'}`);

  lines.push('');
  lines.push('### Extensions (Skills / Upgrades)');

  if (manifest.skill_extensions.length === 0) {
    lines.push('- none (no active runtime skill extensions)');
  } else {
    const visible = manifest.skill_extensions.slice(0, maxSkillExtensions);
    for (const skill of visible) {
      lines.push(`- skill:${skill.skill_id}@${skill.version} (${skill.name})`);
    }
    if (manifest.skill_extensions.length > maxSkillExtensions) {
      const hidden = manifest.skill_extensions.length - maxSkillExtensions;
      lines.push(`- ... and ${hidden} more active skill extensions`);
    }
  }

  lines.push('');
  lines.push('### Runtime Self-Report Template');
  const directBrain = manifest.built_in.find(capability => capability.id === 'direct_brain_execution');
  const taskDecomposition = manifest.built_in.find(capability => capability.id === 'task_decomposition');
  const subagentExecution = manifest.built_in.find(capability => capability.id === 'subagent_execution');
  lines.push('- When users ask "is DAG active?" answer with this three-state model:');
  lines.push(`- direct_brain_execution: ${directBrain?.status ?? 'unknown'} (default path)`);
  lines.push(`- task_decomposition: ${taskDecomposition?.status ?? 'unknown'} (on-demand DAG path via decompose_task)`);
  lines.push(`- subagent_execution: ${subagentExecution?.status ?? 'unknown'}${subagentExecution?.value ? ` [${subagentExecution.value}]` : ''} (rollout-gated worker path, in-process fallback remains available)`);
  lines.push('- Do not describe DAG as "fully dormant" when task_decomposition is enabled.');

  lines.push('');
  lines.push('### Capability Truth Rules');
  lines.push('- Treat this contract as the source of truth for runtime capabilities.');
  lines.push('- Built-in capabilities may evolve; rely on enabled/disabled status in this snapshot.');
  lines.push('- Skill extensions are runtime add-ons and may vary by tenant or upgrade.');
  lines.push('- Never claim disabled capabilities as available.');
  lines.push('- For demos, execute the real runtime path and avoid hypothetical claims.');

  return lines.join('\n');
}

export function formatCapabilityCommandOutput(
  manifest: RuntimeCapabilityManifest,
  routingExplain?: RoutingExplainability,
): string {
  const lines: string[] = [
    'Runtime Capability Manifest',
    '',
    'Runtime Built-ins:',
  ];

  for (const capability of manifest.built_in) {
    const value = capability.value ? ` [${capability.value}]` : '';
    lines.push(`- ${capability.id}: ${capability.status}${value} — ${capability.summary}`);
  }

  lines.push('');
  lines.push(`Limits: max_parallel_agents=${manifest.metadata.max_parallel_agents}`);
  lines.push(`Providers: primary=${manifest.metadata.primary_brain_provider}, fallback=${manifest.metadata.fallback_brain_provider}`);
  lines.push(`Models: brain=${manifest.metadata.primary_brain_model}, fallback=${manifest.metadata.fallback_brain_model}`);
  lines.push(`Tools (${manifest.metadata.registered_tools.length}): ${manifest.metadata.registered_tools.length > 0 ? manifest.metadata.registered_tools.join(', ') : 'none'}`);
  lines.push('');
  lines.push(formatModelCapabilityOutput(manifest.metadata.model_snapshot));

  if (routingExplain) {
    lines.push('');
    lines.push(formatRoutingExplainability(routingExplain));
  }

  lines.push('');
  lines.push('Extensions (Skills / Upgrades):');

  if (manifest.skill_extensions.length === 0) {
    lines.push('- none');
  } else {
    for (const skill of manifest.skill_extensions) {
      lines.push(`- ${skill.skill_id}@${skill.version} (${skill.name}) — ${skill.summary}`);
    }
  }

  return lines.join('\n');
}

/** Sample routing decision for a given role. */
export interface RoutingExplainEntry {
  role: TaskRole;
  provider: string;
  model: string;
  reason: RoutingReason;
}

/** Full routing explainability output. */
export interface RoutingExplainability {
  usableModels: { provider: string; model: string; tier: string }[];
  effectiveDefaults: {
    brainProvider: string;
    brainModel: string;
    fallbackProvider: string;
  };
  activePreferences: RoutingPreferences | undefined;
  sampleDecisions: RoutingExplainEntry[];
}

/**
 * Build a routing explainability snapshot: usable models, effective defaults,
 * active preferences, and sample routing decisions for each standard role.
 */
export function buildRoutingExplainability(
  config: MoziConfig,
  routingContext?: RoutingContext,
): RoutingExplainability {
  const routerConfig = config.model_router;
  const brainProvider = routerConfig?.brain_provider ?? '';
  const brainModel = config.brain.model || (brainProvider ? getProvider(brainProvider)?.defaultModel ?? '' : '');
  const fallbackProvider = routerConfig?.fallback_brain_provider ?? 'none';
  const explicitProviders = [brainProvider, fallbackProvider].filter((provider) => provider && provider !== 'none');
  const snapshot = buildModelCapabilitySnapshot(explicitProviders.length > 0 ? explicitProviders : undefined);

  const configRoles = routerConfig?.roles as Record<string, RoleOverride> | undefined;
  const globalPreferences = routerConfig?.routing_preferences as RoutingPreferences | undefined;
  let preferences = globalPreferences;
  const userId = routingContext?.userId?.trim();
  if (userId) {
    try {
      const userPrefs = getUserRoutingPreferences(userId, routingContext?.tenantId ?? 'default');
      if (Object.keys(userPrefs).length > 0) {
        preferences = mergeRoutingPreferences(globalPreferences, userPrefs);
      }
    } catch {
      // Ignore unavailable DB state in startup/test contexts.
    }
  }

  const roles: TaskRole[] = ['brain', 'code', 'vision', 'simple_subagent', 'summary'];
  const sampleDecisions: RoutingExplainEntry[] = [];

  for (const role of roles) {
    const result = resolveRouting({
      role,
      hints: getTaskHintsForRole(role),
      configRoles,
      brainProvider: brainProvider || undefined,
      brainModel: brainModel || undefined,
      preferences,
      snapshot,
    });
    sampleDecisions.push({
      role,
      provider: result.provider,
      model: result.model,
      reason: result.reason,
    });
  }

  return {
    usableModels: snapshot.usable.map(e => ({ provider: e.provider, model: e.model, tier: e.tier })),
    effectiveDefaults: {
      brainProvider,
      brainModel,
      fallbackProvider,
    },
    activePreferences: preferences,
    sampleDecisions,
  };
}

/**
 * Format routing explainability as human-readable text for operator/status output.
 * Secrets (API keys) are never included.
 */
export function formatRoutingExplainability(explain: RoutingExplainability): string {
  const lines: string[] = ['Routing Explainability', ''];

  // Effective defaults
  lines.push('Effective Defaults:');
  lines.push(`  Brain provider: ${explain.effectiveDefaults.brainProvider || '(not configured)'}`);
  lines.push(`  Brain model: ${explain.effectiveDefaults.brainModel || '(not configured)'}`);
  lines.push(`  Fallback provider: ${explain.effectiveDefaults.fallbackProvider}`);

  // Active preferences
  if (explain.activePreferences) {
    lines.push('');
    lines.push('Active Routing Preferences:');
    const p = explain.activePreferences;
    if (p.cost_sensitivity) lines.push(`  Cost sensitivity: ${p.cost_sensitivity}`);
    if (p.preferred_code) lines.push(`  Preferred code: ${p.preferred_code.provider ?? '*'}/${p.preferred_code.model ?? '*'}`);
    if (p.preferred_vision) lines.push(`  Preferred vision: ${p.preferred_vision.provider ?? '*'}/${p.preferred_vision.model ?? '*'}`);
    if (p.preferred_cheap) lines.push(`  Preferred cheap: ${p.preferred_cheap.provider ?? '*'}/${p.preferred_cheap.model ?? '*'}`);
    if (p.preferred_summary) lines.push(`  Preferred summary: ${p.preferred_summary.provider ?? '*'}/${p.preferred_summary.model ?? '*'}`);
  } else {
    lines.push('');
    lines.push('Active Routing Preferences: none');
  }

  // Usable models
  lines.push('');
  lines.push(`Usable Models (${explain.usableModels.length}):`);
  if (explain.usableModels.length === 0) {
    lines.push('  No healthy models available');
  } else {
    for (const m of explain.usableModels) {
      lines.push(`  ${m.provider}/${m.model} [${m.tier}]`);
    }
  }

  // Sample routing decisions
  lines.push('');
  lines.push('Sample Routing Decisions:');
  for (const d of explain.sampleDecisions) {
    lines.push(`  ${d.role}: ${d.provider}/${d.model}`);
    lines.push(`    Stage: ${d.reason.stage} — ${d.reason.explanation}`);
  }

  return lines.join('\n');
}

export function formatSkillsCommandOutput(manifest: RuntimeCapabilityManifest): string {
  if (manifest.skill_extensions.length === 0) {
    return 'Skills: none (no active runtime extensions).';
  }

  const skillList = manifest.skill_extensions
    .map((skill) => `${skill.skill_id}@${skill.version}`)
    .join(', ');
  return `Skills (${manifest.skill_extensions.length}): ${skillList}`;
}
