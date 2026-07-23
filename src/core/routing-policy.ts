/**
 * Policy-Based Routing Engine — resolves provider/model for a given task
 * using runtime capability truth instead of static config alone.
 *
 * Policy precedence:
 * 1. Explicit user/brain override (config roles or brain preference)
 * 2. Capability-aware policy rules (task type → model requirements)
 * 3. Healthy fallback (best available model when preferred is unavailable)
 */

import type { TaskRole, TaskHints } from './model-router.js';
import {
  buildModelCapabilitySnapshot,
  type ModelCapabilitySnapshot,
  type ModelCapabilityEntry,
} from './model-capability-map.js';
import {
  getProvider,
  isChatRoleEligibleProvider,
  resolveRuntimeModel,
} from './providers.js';
import { getConfig } from '../config/index.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:routing-policy' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a particular model was selected. */
export interface RoutingReason {
  /** Which policy stage resolved the selection. */
  stage: 'explicit_config' | 'preference_override' | 'policy_match' | 'healthy_fallback' | 'no_healthy_model';
  /** Human-readable explanation. */
  explanation: string;
  /** The policy rule that matched (if stage === 'policy_match'). */
  rule?: string;
  /** Whether the preferred model was available. */
  preferredAvailable?: boolean;
}

/** Result of a policy-based routing decision. */
export interface PolicyRoutingResult {
  provider: string;
  model: string;
  role: TaskRole;
  reason: RoutingReason;
}

/** Static config for a role (from mozi.json model_router.roles). */
export interface RoleOverride {
  provider: string;
  model: string;
}

/** User-level routing preference for a specific lane. */
export interface RoutingPreferenceEntry {
  provider?: string;
  model?: string;
}

/** Global routing preferences from config. */
export interface RoutingPreferences {
  cost_sensitivity?: 'low' | 'medium' | 'high';
  preferred_code?: RoutingPreferenceEntry;
  preferred_vision?: RoutingPreferenceEntry;
  preferred_cheap?: RoutingPreferenceEntry;
  preferred_summary?: RoutingPreferenceEntry;
}

/** Inputs to the routing policy engine. */
export interface PolicyInput {
  role: TaskRole;
  hints: TaskHints;
  /** Explicit role overrides from config (model_router.roles). */
  configRoles?: Record<string, RoleOverride>;
  /** Configured brain provider ID. */
  brainProvider?: string;
  /** Configured brain model ID. */
  brainModel?: string;
  /** User-level routing preferences from config. */
  preferences?: RoutingPreferences;
  /** Pre-built snapshot (avoids rebuilding for batch calls). */
  snapshot?: ModelCapabilitySnapshot;
}

// ---------------------------------------------------------------------------
// Policy rules
// ---------------------------------------------------------------------------

interface PolicyRule {
  /** Unique rule name for observability. */
  name: string;
  /** Which roles this rule applies to. */
  roles: TaskRole[];
  /** Filter function to find candidate models from the usable set. */
  filter: (entry: ModelCapabilityEntry, hints: TaskHints) => boolean;
  /** Sort comparator — lower score = preferred. */
  score: (entry: ModelCapabilityEntry) => number;
}

/**
 * Built-in policy rules, evaluated in order. First rule that matches the
 * role and yields at least one candidate wins.
 */
/**
 * Policy rule scores are split into a quality component (returned by `score`)
 * and a cost component (derived from model pricing). `costAdjustedScore`
 * combines them using the user's cost_sensitivity setting.
 *
 * Rule `score()` functions should return quality-only scores (lower = better).
 * Cost is handled externally so sensitivity can re-weight it.
 */
const POLICY_RULES: PolicyRule[] = [
  {
    name: 'strong_reasoning',
    roles: ['brain', 'complex_subagent', 'code'],
    filter: (e, hints) => {
      if (hints.complexity === 'high' || hints.type === 'code') {
        return e.tier === 'high' && e.supportsTools;
      }
      return e.tier === 'high';
    },
    // Quality-only score: reasoning > tools
    score: (e) => {
      let s = 0;
      if (!e.reasoning) s += 10;
      if (!e.supportsTools) s += 20;
      return s;
    },
  },
  {
    name: 'vision_capable',
    roles: ['vision'],
    filter: (e) => e.supportsVision,
    // Quality-only: prefer models with tool support
    score: (e) => (e.supportsTools ? 0 : 10),
  },
  {
    name: 'cheap_executor',
    roles: ['simple_subagent', 'summary'],
    filter: (e) => e.supportsTools,
    // Quality-only: prefer lower tiers (they're designed for light work)
    score: (e) => {
      let s = 0;
      if (e.tier === 'high') s += 5;
      if (e.tier === 'mid') s += 2;
      // low tier gets s=0 (best for cheap executor)
      return s;
    },
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Check if a specific provider/model pair is healthy in the snapshot.
 *
 * The snapshot only enumerates the bundled catalog, but explicit config may
 * name a forward-compat model (e.g. openai/gpt-5.4) that resolves via pattern
 * in the runtime resolver. Treat such a model as healthy when its provider has any
 * healthy entry — otherwise every newly-released model silently degrades to
 * the catalog fallback and the operator's explicit choice never runs.
 */
function isModelHealthy(
  snapshot: ModelCapabilitySnapshot,
  provider: string,
  model: string,
): boolean {
  if (snapshot.usable.some(e => e.provider === provider && e.model === model)) return true;
  const providerHealthy = snapshot.usable.some(e => e.provider === provider);
  const registered = getConfig().model_discovery?.models?.[provider] ?? [];
  return providerHealthy && resolveRuntimeModel(provider, model, { allowUnknown: registered.includes(model) }) !== undefined;
}

/**
 * Find the best healthy model for a provider (its default or highest-tier).
 */
function bestModelForProvider(
  snapshot: ModelCapabilitySnapshot,
  provider: string,
): ModelCapabilityEntry | undefined {
  const candidates = snapshot.usable.filter(e => e.provider === provider);
  if (candidates.length === 0) return undefined;
  // Prefer high > mid > low, then cheaper
  candidates.sort((a, b) => {
    const tierOrder = { high: 0, mid: 1, low: 2 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return (a.inputCostPer1M ?? 50) - (b.inputCostPer1M ?? 50);
  });
  return candidates[0];
}

/**
 * Resolve a model selection through the policy engine.
 *
 * This is the main entry point. It checks explicit config first, then
 * applies policy rules, then falls back to any healthy model.
 */
/**
 * Map role → preference key.
 */
function preferenceForRole(role: TaskRole, preferences?: RoutingPreferences): RoutingPreferenceEntry | undefined {
  if (!preferences) return undefined;
  switch (role) {
    case 'code': return preferences.preferred_code;
    case 'vision': return preferences.preferred_vision;
    case 'simple_subagent': return preferences.preferred_cheap;
    case 'summary': return preferences.preferred_summary;
    default: return undefined;
  }
}

/**
 * Compute a cost-sensitivity-adjusted score.
 *
 * The key insight: multiplying the entire score by a constant preserves
 * ordering and is a no-op. Instead, we separate the base quality score
 * from the cost component and weight only the cost part.
 *
 *   final = qualityScore + costWeight * costComponent
 *
 * - low  sensitivity: costWeight=0.3 (quality dominates, cost barely matters)
 * - medium:           costWeight=1.0 (balanced)
 * - high:             costWeight=3.0 (cost dominates, cheapest viable model wins)
 */
function costWeight(sensitivity?: 'low' | 'medium' | 'high'): number {
  switch (sensitivity) {
    case 'low': return 0.3;
    case 'high': return 3.0;
    default: return 1.0;
  }
}

function costAdjustedScore(
  baseScore: number,
  entry: ModelCapabilityEntry,
  weight: number,
): number {
  // Cost component: average of input+output cost (or 50 if unknown)
  const costComponent = ((entry.inputCostPer1M ?? 50) + (entry.outputCostPer1M ?? 50)) / 2;
  return baseScore + weight * costComponent;
}

function isChatRoleEligibleEntry(entry: ModelCapabilityEntry): boolean {
  return entry.apiMode !== 'cli-pipe' || isChatRoleEligibleProvider(entry.provider);
}

export function resolveRouting(input: PolicyInput): PolicyRoutingResult {
  const snapshot = input.snapshot ?? buildModelCapabilitySnapshot();
  const { role, hints, configRoles, brainProvider, brainModel, preferences } = input;
  const usableForRole = snapshot.usable.filter(isChatRoleEligibleEntry);

  // ── Stage 1: Explicit config role override ──
  const configRole = configRoles?.[role];
  if (configRole?.provider && configRole?.model && isChatRoleEligibleProvider(configRole.provider)) {
    const healthy = isModelHealthy(snapshot, configRole.provider, configRole.model);
    if (healthy) {
      // Success is logged (not just the fallback) so a live run can prove the
      // configured model actually engaged — silent success is unverifiable.
      logger.info(
        { role, model: `${configRole.provider}/${configRole.model}` },
        'Explicit role config resolved',
      );
      return {
        provider: configRole.provider,
        model: configRole.model,
        role,
        reason: {
          stage: 'explicit_config',
          explanation: `Explicit role config: ${configRole.provider}/${configRole.model}`,
          preferredAvailable: true,
        },
      };
    }
    // Explicit config model is unhealthy — try fallback within same provider
    const fallback = bestModelForProvider(snapshot, configRole.provider);
    if (fallback) {
      logger.info(
        { role, preferred: `${configRole.provider}/${configRole.model}`, fallback: `${fallback.provider}/${fallback.model}` },
        'Configured model unhealthy, falling back within provider',
      );
      return {
        provider: fallback.provider,
        model: fallback.model,
        role,
        reason: {
          stage: 'healthy_fallback',
          explanation: `Config model ${configRole.provider}/${configRole.model} unavailable; fell back to ${fallback.provider}/${fallback.model}`,
          preferredAvailable: false,
        },
      };
    }
    // Fall through to policy rules
  }

  // ── Stage 1b: Brain provider/model for brain role ──
  if (role === 'brain' && brainProvider && brainModel && isChatRoleEligibleProvider(brainProvider)) {
    const healthy = isModelHealthy(snapshot, brainProvider, brainModel);
    if (healthy) {
      return {
        provider: brainProvider,
        model: brainModel,
        role,
        reason: {
          stage: 'explicit_config',
          explanation: `Brain config: ${brainProvider}/${brainModel}`,
          preferredAvailable: true,
        },
      };
    }
    // Brain model unhealthy — try another model from same provider
    const fallback = bestModelForProvider(snapshot, brainProvider);
    if (fallback) {
      return {
        provider: fallback.provider,
        model: fallback.model,
        role,
        reason: {
          stage: 'healthy_fallback',
          explanation: `Brain model ${brainProvider}/${brainModel} unavailable; fell back to ${fallback.provider}/${fallback.model}`,
          preferredAvailable: false,
        },
      };
    }
  }

  // ── Stage 1c: User routing preferences ──
  const pref = preferenceForRole(role, preferences);
  if (pref?.provider || pref?.model) {
    // Find a matching healthy model from the preference
    const prefCandidates = usableForRole.filter(e => {
      if (pref.provider && e.provider !== pref.provider) return false;
      if (pref.model && e.model !== pref.model) return false;
      return true;
    });
    if (prefCandidates.length > 0) {
      // Pick best from preference candidates
      prefCandidates.sort((a, b) => {
        const tierOrder = { high: 0, mid: 1, low: 2 };
        return tierOrder[a.tier] - tierOrder[b.tier];
      });
      const pick = prefCandidates[0];
      return {
        provider: pick.provider,
        model: pick.model,
        role,
        reason: {
          stage: 'preference_override',
          explanation: `User preference for ${role}: ${pick.provider}/${pick.model}`,
          preferredAvailable: true,
        },
      };
    }
    logger.info(
      { role, preference: pref },
      'User routing preference not available in healthy models, falling through to policy',
    );
  }

  // ── Stage 2: Policy rules (cost-sensitivity aware) ──
  const cw = costWeight(preferences?.cost_sensitivity);
  for (const rule of POLICY_RULES) {
    if (!rule.roles.includes(role)) continue;

    const candidates = usableForRole.filter(e => rule.filter(e, hints));
    if (candidates.length === 0) continue;

    // If brain provider is configured, prefer models from that provider
    const preferBrain = brainProvider && isChatRoleEligibleProvider(brainProvider)
      ? candidates.filter(e => e.provider === brainProvider)
      : [];
    const pool = preferBrain.length > 0 ? preferBrain : candidates;

    pool.sort((a, b) => {
      return costAdjustedScore(rule.score(a), a, cw) - costAdjustedScore(rule.score(b), b, cw);
    });
    const pick = pool[0];

    return {
      provider: pick.provider,
      model: pick.model,
      role,
      reason: {
        stage: 'policy_match',
        explanation: `Policy rule '${rule.name}' selected ${pick.provider}/${pick.model} (tier=${pick.tier})`,
        rule: rule.name,
        preferredAvailable: true,
      },
    };
  }

  // ── Stage 3: Any healthy model fallback ──
  if (usableForRole.length > 0) {
    // Prefer brain provider if available, else cheapest high-tier
    const brainCandidates = brainProvider && isChatRoleEligibleProvider(brainProvider)
      ? usableForRole.filter(e => e.provider === brainProvider)
      : [];
    const pool = brainCandidates.length > 0 ? brainCandidates : usableForRole;
    pool.sort((a, b) => {
      const tierOrder = { high: 0, mid: 1, low: 2 };
      return tierOrder[a.tier] - tierOrder[b.tier];
    });
    const pick = pool[0];

    return {
      provider: pick.provider,
      model: pick.model,
      role,
      reason: {
        stage: 'healthy_fallback',
        explanation: `No policy rule matched; fell back to ${pick.provider}/${pick.model}`,
        preferredAvailable: false,
      },
    };
  }

  // ── Stage 4: No healthy models at all ──
  // Return the brain config as-is (will likely fail at LLM call time)
  const fallbackProvider = isChatRoleEligibleProvider(brainProvider) ? brainProvider ?? '' : '';
  const fallbackModel = fallbackProvider ? brainModel ?? '' : '';

  return {
    provider: fallbackProvider,
    model: fallbackModel,
    role,
    reason: {
      stage: 'no_healthy_model',
      explanation: 'No healthy models available; using configured defaults (may fail)',
      preferredAvailable: false,
    },
  };
}
