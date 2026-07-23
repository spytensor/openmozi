import { getConfig } from '../config/index.js';
import { create, type LLMClient, type ChatMessage, type ChatOptions, type ChatResponse, type ModelThinkSetting } from './llm.js';
import { getProvider, resolveRuntimeModel, getVisionCapableProviders, isChatRoleEligibleProvider } from './providers.js';
import { resolveRouting, type RoutingReason } from './routing-policy.js';
import { buildModelCapabilitySnapshot, type ModelCapabilityEntry } from './model-capability-map.js';
import { getUserRoutingPreferences, mergeRoutingPreferences, type UserRoutingPreferences } from '../memory/user-profile.js';
import { assertModelAllowed, type AllowedModelsResolution } from '../security/entitlements.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:model-router' });

// ---------------------------------------------------------------------------
// Failover integration
// ---------------------------------------------------------------------------

/** Failover manager interface (subset of createFailoverManager return type) */
type FailoverChatOptions = ChatOptions & { isComplex?: boolean; provider?: string };

interface FailoverChat {
  chat(messages: ChatMessage[], options?: FailoverChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: FailoverChatOptions): ReturnType<LLMClient['chatStream']>;
}

let _failoverManager: FailoverChat | null = null;

/**
 * Inject the failover manager so brain-role LLM calls use automatic provider failover.
 * Call once at startup from index.ts after creating the failover manager.
 */
export function setFailoverManager(fm: FailoverChat | null): void {
  _failoverManager = fm;
  logger.info('Failover manager injected into model-router');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskRole = 'brain' | 'complex_subagent' | 'simple_subagent' | 'summary' | 'code' | 'vision' | 'step' | 'plan_summary';

export interface TaskHints {
  complexity?: 'high' | 'medium' | 'low';
  type?: 'code' | 'research' | 'summary' | 'review' | 'general';
  needs_tool_calling?: boolean;
  estimated_tokens?: number;
  /** Brain-suggested temperature for this turn/task (null = use defaults) */
  suggested_temperature?: number;
  /** Brain-suggested max_tokens for this turn/task (null = use defaults) */
  suggested_max_tokens?: number;
}

export interface RoutingContext {
  tenantId?: string;
  userId?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
  role: TaskRole;
  think?: ModelThinkSetting;
  /** Machine-readable reason for why this model was selected. */
  reason?: RoutingReason;
  tenantId?: string;
  userId?: string;
  allowedModels?: string[] | null;
}

export type { RoutingReason };

// ---------------------------------------------------------------------------
// Role config — loaded from mozi.json (legacy config.yaml is still supported)
// ---------------------------------------------------------------------------

interface RoleConfig {
  provider: string;
  model: string;
  think?: ModelThinkSetting;
}

// ---------------------------------------------------------------------------
// Client cache (reuse LLM clients for the same provider+model)
// ---------------------------------------------------------------------------

const clientCache = new Map<string, LLMClient>();

type RoutingContextInput = RoutingContext | string | undefined;
type RoutingPreferencesShape = UserRoutingPreferences;

function normalizeRoutingContext(routingContext?: RoutingContextInput): RoutingContext {
  if (typeof routingContext === 'string') {
    return { tenantId: routingContext };
  }
  return routingContext ?? {};
}

export function getTaskHintsForRole(role: TaskRole): TaskHints {
  switch (role) {
    case 'complex_subagent':
      return { complexity: 'high' };
    case 'simple_subagent':
      return { complexity: 'low' };
    case 'summary':
    case 'plan_summary':
      return { type: 'summary' };
    case 'code':
      return { type: 'code' };
    case 'step':
      return { complexity: 'high', needs_tool_calling: true };
    case 'brain':
    case 'vision':
    default:
      return {};
  }
}

function resolveEffectivePreferences(
  globalPreferences: RoutingPreferencesShape | undefined,
  routingContext?: RoutingContextInput,
): RoutingPreferencesShape | undefined {
  const normalized = normalizeRoutingContext(routingContext);
  const userId = normalized.userId?.trim();
  if (!userId) {
    return globalPreferences;
  }

  try {
    const userPrefs = getUserRoutingPreferences(userId, normalized.tenantId ?? 'default');
    if (Object.keys(userPrefs).length > 0) {
      return mergeRoutingPreferences(globalPreferences, userPrefs);
    }
  } catch {
    // DB may not be initialized in some contexts (tests, CLI) — silently skip
  }

  return globalPreferences;
}

function sortChatFallbacks(a: ModelCapabilityEntry, b: ModelCapabilityEntry): number {
  const tierOrder = { high: 0, mid: 1, low: 2 };
  const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
  if (tierDiff !== 0) return tierDiff;
  return (a.inputCostPer1M ?? 50) - (b.inputCostPer1M ?? 50);
}

function selectBestAvailableChatRoleConfig(): RoleConfig {
  const snapshot = buildModelCapabilitySnapshot();
  const pick = snapshot.usable
    .filter(entry => isChatRoleEligibleProvider(entry.provider))
    .sort(sortChatFallbacks)[0];

  if (!pick) {
    return { provider: '', model: '' };
  }

  return { provider: pick.provider, model: pick.model };
}

function resolveChatRoleConfig(providerId: string, configuredModel: string): RoleConfig {
  if (!providerId) {
    return { provider: '', model: '' };
  }

  const provider = getProvider(providerId);
  if (!provider || !isChatRoleEligibleProvider(provider)) {
    const fallback = selectBestAvailableChatRoleConfig();
    logger.warn(
      { configuredProvider: providerId, fallbackProvider: fallback.provider || undefined, fallbackModel: fallback.model || undefined },
      'Configured chat role provider is not eligible; falling back to an eligible provider',
    );
    return fallback;
  }

  const registered = getConfig().model_discovery?.models?.[provider.id] ?? [];
  const model = configuredModel && resolveRuntimeModel(provider.id, configuredModel, { allowUnknown: registered.includes(configuredModel) })
    ? configuredModel
    : provider.defaultModel || provider.models[0]?.id || '';
  return { provider: provider.id, model };
}

function sanitizeConfigRoles(
  configRoles: Record<string, { provider: string; model: string }> | undefined,
): Record<string, { provider: string; model: string }> | undefined {
  if (!configRoles) return undefined;
  const sanitized: Record<string, { provider: string; model: string }> = {};
  for (const [role, value] of Object.entries(configRoles)) {
    const resolved = resolveChatRoleConfig(value.provider, value.model);
    if (resolved.provider && resolved.model) {
      sanitized[role] = { provider: resolved.provider, model: resolved.model };
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function resolveSelectionForRole(
  role: TaskRole,
  hints: TaskHints,
  routingContext?: RoutingContextInput,
): ModelSelection {
  const config = getConfig();
  const routerConfig = config.model_router;
  const configuredBrainProvider = routerConfig?.brain_provider ?? '';
  const configuredBrainModel = config.brain.model || (configuredBrainProvider ? getProvider(configuredBrainProvider)?.defaultModel ?? '' : '');
  const brainConfig = resolveChatRoleConfig(configuredBrainProvider, configuredBrainModel);
  const brainProvider = brainConfig.provider;
  const brainModel = brainConfig.model;

  const explicitProviders = brainProvider ? [brainProvider] : undefined;
  const snapshot = buildModelCapabilitySnapshot(explicitProviders);

  if (snapshot.usable.length > 0) {
    const configRoles = { ...(sanitizeConfigRoles(routerConfig?.roles as Record<string, { provider: string; model: string }> | undefined) ?? {}) };
    if (config.models.light.provider && config.models.light.model) {
      const lightRole = resolveChatRoleConfig(config.models.light.provider, config.models.light.model);
      if (lightRole.provider && lightRole.model) {
        configRoles.simple_subagent ??= lightRole;
        configRoles.summary ??= lightRole;
      }
    }
    const globalPreferences = routerConfig?.routing_preferences as RoutingPreferencesShape | undefined;
    const preferences = resolveEffectivePreferences(globalPreferences, routingContext);
    const result = resolveRouting({
      role,
      hints,
      configRoles: Object.keys(configRoles).length > 0 ? configRoles : undefined,
      brainProvider: brainProvider || undefined,
      brainModel: brainModel || undefined,
      preferences,
      snapshot,
    });

    const roleConfig = configRoles?.[role];
    const think = (roleConfig as { think?: ModelThinkSetting } | undefined)?.think ?? config.brain.think;

    logger.debug(
      { role, provider: result.provider, model: result.model, stage: result.reason.stage, rule: result.reason.rule, hints },
      'Model selected (policy engine)',
    );

    return applyEntitlementContext({
      provider: result.provider,
      model: result.model,
      role,
      think,
      reason: result.reason,
    }, routingContext);
  }

  const staticConfig = getRoleConfig(role);

  logger.debug({ role, provider: staticConfig.provider, model: staticConfig.model, hints }, 'Model selected (static fallback)');

  return applyEntitlementContext({
    provider: staticConfig.provider,
    model: staticConfig.model,
    role,
    think: staticConfig.think,
  }, routingContext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select a model based on task hints.
 *
 * Uses the policy-based routing engine when healthy models are available.
 * Falls back to static config lookup when the snapshot has no usable models
 * (preserves backward compatibility for unconfigured environments).
 */
export function selectModel(hints: TaskHints = {}, routingContext?: RoutingContextInput): ModelSelection {
  return resolveSelectionForRole(determineRole(hints), hints, routingContext);
}

/**
 * Get or create an LLM client for a given model selection.
 * Caches clients by provider+model key.
 * When a failover manager is injected, all roles route chat() through failover
 * so that provider failures automatically fall back to healthy alternatives.
 */
export function getClient(selection: ModelSelection): LLMClient {
  const effectiveSelection = selection.tenantId && selection.userId && selection.allowedModels === undefined
    ? applyEntitlementContext(selection, { tenantId: selection.tenantId, userId: selection.userId })
    : selection;
  const key = `${effectiveSelection.provider}:${effectiveSelection.model}`;

  let directClient = clientCache.get(key);
  if (!directClient) {
    const cfg = getConfig();
    directClient = create(effectiveSelection.provider, { model: effectiveSelection.model, configProviders: cfg.providers });
    clientCache.set(key, directClient);
  }

  // Wrap ALL roles with failover when configured, then add per-selection
  // tenant/user metadata without storing it in the provider/model cache.
  const routedClient: LLMClient = _failoverManager
    ? {
      provider: directClient.provider,
      chat: (messages, options) => _failoverManager!.chat(messages, withFailoverContext(options, effectiveSelection)),
      chatStream: (messages, options) => _failoverManager!.chatStream(messages, withFailoverContext(options, effectiveSelection)),
      // Do not expose direct AI SDK model access when failover is active.
      // streamText against the raw provider model would bypass provider-failover
      // and turn deterministic provider failures into misleading gateway errors.
      getAIModel: undefined,
    }
    : directClient;

  if (_failoverManager || (!effectiveSelection.tenantId && !effectiveSelection.userId && effectiveSelection.allowedModels === undefined)) {
    return routedClient;
  }

  return {
    provider: routedClient.provider,
    chat: (messages, options) => routedClient.chat(messages, withSelectionContext(options, effectiveSelection)),
    chatStream: (messages, options) => routedClient.chatStream(messages, withSelectionContext(options, effectiveSelection)),
    getAIModel: routedClient.getAIModel,
  };
}

/**
 * Convenience: select model + create client in one step.
 */
export function getClientForTask(
  hints: TaskHints = {},
  routingContext?: RoutingContextInput,
): { client: LLMClient; selection: ModelSelection } {
  const selection = selectModel(hints, routingContext);
  const client = getClient(selection);
  return { client, selection };
}

/**
 * Get the brain-role LLM client directly.
 * Bypasses task-hint routing — always uses the configured brain provider+model.
 * Failover wrapping is now handled by getClient() for all roles.
 */
export function getBrainClient(routingContext?: RoutingContextInput): { client: LLMClient; selection: ModelSelection } {
  const config = getRoleConfig('brain');
  const selection = applyEntitlementContext({
    provider: config.provider,
    model: config.model,
    role: 'brain',
    think: config.think,
  }, routingContext);
  const client = getClient(selection);
  logger.debug({ provider: config.provider, model: config.model }, 'Brain client selected');

  return { client, selection };
}

/**
 * Get an LLM client for a named role, with fallback chain support.
 * Used by DAG step execution and plan summary to request specific routing roles.
 *
 * Fallback chains (in order of preference when a role is not configured):
 *  - step: step → complex_subagent → brain
 *  - plan_summary: plan_summary → summary → brain
 *
 * If the requested role is not configured, falls back to the next role in the chain.
 * @param role - The routing role to request
 * @param fallbackClient - Caller-provided fallback when role resolution produces no usable model
 * @param routingContext - Optional tenant/user context for entitlement checks
 */
export function getClientForRole(
  role: TaskRole,
  fallbackClient?: LLMClient,
  routingContext?: RoutingContextInput,
): { client: LLMClient; selection: ModelSelection } {
  // Determine the fallback chain for the requested role
  const fallbackChain: TaskRole[] = (() => {
    switch (role) {
      case 'step': return ['step', 'complex_subagent', 'brain'];
      case 'plan_summary': return ['plan_summary', 'summary', 'brain'];
      default: return [role, 'brain'];
    }
  })();

  for (const candidateRole of fallbackChain) {
    try {
      const selection = resolveSelectionForRole(candidateRole, getTaskHintsForRole(candidateRole), routingContext);
      if (selection.provider && selection.model) {
        if (candidateRole !== role) {
          logger.info(
            { requestedRole: role, resolvedRole: candidateRole, provider: selection.provider, model: selection.model },
            'Role not configured; resolved via fallback chain',
          );
        }
        const client = getClient(selection);
        return { client, selection };
      }
    } catch {
      // Continue to next fallback
    }
  }

  // Final fallback: caller-provided client
  if (fallbackClient) {
    logger.warn({ requestedRole: role }, 'Role resolution exhausted fallback chain; using caller fallbackClient');
    // Best-effort selection for metadata: use brain selection if available, otherwise synthesize
    try {
      return { client: fallbackClient, selection: getBrainClient(routingContext).selection };
    } catch {
      return {
        client: fallbackClient,
        selection: { provider: '', model: '', role: 'brain' },
      };
    }
  }

  // No fallback client either — try brain as absolute last resort
  try {
    logger.warn({ requestedRole: role }, 'Role resolution exhausted all fallbacks; using brain client');
    return getBrainClient(routingContext);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`getClientForRole('${role}'): no usable provider found in fallback chain. ${message}`);
  }
}

/**
 * Get the model selection for a specific role directly.
 * Routes through the policy engine so routing_preferences and capability-aware
 * selection apply to all callers (including vision.ts).
 */
export function getSelectionForRole(role: TaskRole, routingContext?: RoutingContextInput): ModelSelection {
  return resolveSelectionForRole(role, getTaskHintsForRole(role), routingContext);
}

/** Clear the cached LLM clients (e.g. on config reload) */
export function clearCache(): void {
  clientCache.clear();
}

function applyEntitlementContext(selection: ModelSelection, routingContext?: RoutingContextInput): ModelSelection {
  const normalized = normalizeRoutingContext(routingContext);
  const tenantId = normalized.tenantId?.trim();
  const userId = normalized.userId?.trim();
  if (!tenantId && !userId) {
    return selection;
  }

  let resolution: AllowedModelsResolution | undefined;
  if (selection.model && tenantId && userId) {
    resolution = assertModelAllowed(tenantId, userId, selection.model);
  }

  return {
    ...selection,
    ...(tenantId ? { tenantId } : {}),
    ...(userId ? { userId } : {}),
    ...(resolution ? { allowedModels: resolution.models } : {}),
  };
}

function withSelectionContext(options: ChatOptions | undefined, selection: ModelSelection): ChatOptions | undefined {
  const tenantId = selection.tenantId;
  const userId = selection.userId;
  if (!tenantId && !userId && selection.allowedModels === undefined) {
    return options;
  }

  const next: ChatOptions = { ...(options ?? {}) };
  if (tenantId) {
    next.billing = {
      ...(options?.billing ?? {}),
      tenantId: options?.billing?.tenantId ?? tenantId,
      userId: options?.billing?.userId ?? userId,
    };
  }
  if (tenantId && userId) {
    next.entitlements = {
      tenantId,
      userId,
      allowedModels: selection.allowedModels,
    };
  }
  return next;
}

function withFailoverContext(options: ChatOptions | undefined, selection: ModelSelection): FailoverChatOptions {
  const failoverOptions = options as FailoverChatOptions | undefined;
  const next: FailoverChatOptions = {
    ...(options ?? {}),
    provider: failoverOptions?.provider ?? selection.provider,
    model: options?.model ?? selection.model,
  };
  return withSelectionContext(next, selection) as FailoverChatOptions;
}

// ---------------------------------------------------------------------------
// Role determination logic
// ---------------------------------------------------------------------------

function determineRole(hints: TaskHints): TaskRole {
  // Summary tasks always use the summary model
  if (hints.type === 'summary') return 'summary';

  // Code tasks use the code model (or complex_subagent if not configured)
  if (hints.type === 'code') return 'code';

  // Complexity-based routing
  if (hints.complexity === 'high') return 'complex_subagent';
  if (hints.complexity === 'low') return 'simple_subagent';

  // Medium complexity or general: use complex_subagent if high token estimate
  if (hints.estimated_tokens && hints.estimated_tokens > 5000) return 'complex_subagent';

  return 'simple_subagent';
}

// ---------------------------------------------------------------------------
// Config lookup
// ---------------------------------------------------------------------------

function getRoleConfig(role: TaskRole): RoleConfig {
  const config = getConfig();

  // Check if model_router is configured in the config
  const routerConfig = config.model_router;

  if (routerConfig?.roles) {
    const roles = routerConfig.roles as Record<string, RoleConfig>;
    if (roles[role]) {
      const resolved = resolveChatRoleConfig(roles[role].provider, roles[role].model);
      return {
        ...resolved,
        think: roles[role].think ?? config.brain.think,
      };
    }
  }

  if ((role === 'simple_subagent' || role === 'summary') && config.models.light.provider && config.models.light.model) {
    const resolved = resolveChatRoleConfig(config.models.light.provider, config.models.light.model);
    return {
      provider: resolved.provider,
      model: resolved.model,
      think: config.brain.think,
    };
  }

  // Handle brain role
  if (role === 'brain') {
    const provider = routerConfig?.brain_provider ?? '';
    const model = config.brain.model || (provider ? getProvider(provider)?.defaultModel ?? '' : '');
    return { ...resolveChatRoleConfig(provider, model), think: config.brain.think };
  }

  // Fallback: derive from the configured brain_provider so that all roles
  // respect the user's chosen provider instead of hardcoding to OpenAI/Anthropic.
  const configuredBrainProvider = routerConfig?.brain_provider ?? '';
  const configuredBrainModel = config.brain.model || (configuredBrainProvider ? getProvider(configuredBrainProvider)?.defaultModel ?? '' : '');
  const { provider: brainProvider, model: brainModel } = resolveChatRoleConfig(configuredBrainProvider, configuredBrainModel);
  const fallbackModel = config.brain.fallback_model;
  const providerDef = getProvider(brainProvider);
  // Use the provider's recommended default model for lighter-weight roles.
  const defaultModel = providerDef?.defaultModel ?? fallbackModel;

  switch (role) {
    case 'complex_subagent':
      return { provider: brainProvider, model: brainModel, think: config.brain.think };
    case 'simple_subagent':
      return { provider: brainProvider, model: defaultModel, think: config.brain.think };
    case 'summary':
      return { provider: brainProvider, model: defaultModel, think: config.brain.think };
    case 'code':
      return { provider: brainProvider, model: brainModel, think: config.brain.think };
    case 'step':
      // Fallback chain: step → complex_subagent → brain.
      // Prefer brain model (strong tool-calling capability); opt-in via config.model_router.roles.step.
      return { provider: brainProvider, model: brainModel, think: config.brain.think };
    case 'plan_summary':
      // Fallback chain: plan_summary → summary → brain.
      // Use lighter model (short output, low temp); opt-in via config.model_router.roles.plan_summary.
      return { provider: brainProvider, model: defaultModel, think: config.brain.think };
    case 'vision': {
      // Use brain model if it supports vision
      const registered = getConfig().model_discovery?.models?.[brainProvider] ?? [];
      const visionModelDef = resolveRuntimeModel(brainProvider, brainModel, { allowUnknown: registered.includes(brainModel) });
      if (visionModelDef?.supportsVision) {
        return { provider: brainProvider, model: brainModel, think: config.brain.think };
      }
      // Brain model lacks vision — find a provider that has it
      const visionProviders = getVisionCapableProviders();
      if (visionProviders.length > 0) {
        const pick = visionProviders[0];
        logger.info({ provider: pick.provider, model: pick.model, reason: 'brain model lacks vision' }, 'Vision role routed to alternate provider');
        return { provider: pick.provider, model: pick.model, think: config.brain.think };
      }
      // Nothing found — return brain model anyway (will likely fail)
      logger.warn({ provider: brainProvider, model: brainModel }, 'No vision-capable provider found, falling back to brain');
      return { provider: brainProvider, model: brainModel, think: config.brain.think };
    }
    default:
      return { provider: brainProvider, model: fallbackModel, think: config.brain.think };
  }
}
