/**
 * Runtime Model Capability Snapshot — single source of truth for healthy,
 * currently usable provider/model combinations.
 *
 * Brain and operators should query this snapshot instead of guessing model
 * availability from static provider metadata alone.
 */

import {
  getAllProviders,
  getProvider,
  resolveBaseUrl,
  type ProviderDef,
  type ModelDef,
  type ProviderApiMode,
} from './providers.js';
import { hasRuntimeApiKey } from './runtime-provider-keys.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:model-capability-map' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Recommended routing lane for a model entry. */
export type RoutingLane = 'brain' | 'complex_subagent' | 'simple_subagent' | 'summary' | 'code' | 'vision';

/** A single model's runtime capability record. */
export interface ModelCapabilityEntry {
  provider: string;
  providerName: string;
  model: string;
  modelName: string;
  apiMode: ProviderApiMode;
  tier: 'high' | 'mid' | 'low';
  healthy: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per 1M input tokens (undefined = unknown). */
  inputCostPer1M?: number;
  /** USD per 1M output tokens (undefined = unknown). */
  outputCostPer1M?: number;
  /** USD per 1M provider-managed cache-read tokens (undefined = unknown). */
  cacheReadCostPer1M?: number;
  /** Recommended routing lanes based on model capabilities. */
  recommendedLanes: RoutingLane[];
}

/** The full runtime capability snapshot. */
export interface ModelCapabilitySnapshot {
  /** Timestamp when the snapshot was generated (ISO 8601). */
  generatedAt: string;
  /** All configured model entries (including unhealthy). */
  all: ModelCapabilityEntry[];
  /** Only the healthy, usable subset. */
  usable: ModelCapabilityEntry[];
  /** Count summary. */
  counts: {
    totalProviders: number;
    totalModels: number;
    healthyModels: number;
    unhealthyModels: number;
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Determine whether a provider is "healthy" — i.e. has at least one valid
 * API key configured (or is a cli-pipe provider that doesn't need one).
 */
function isProviderHealthy(def: ProviderDef): boolean {
  // CLI-pipe providers are healthy if the CLI binary is presumed present
  // (we don't probe the filesystem here — that's a runtime concern).
  if (def.apiMode === 'cli-pipe') return true;

  return hasRuntimeApiKey(def.id);
}

/**
 * Infer recommended routing lanes from model capabilities.
 */
function inferLanes(m: ModelDef): RoutingLane[] {
  const lanes: RoutingLane[] = [];

  if (m.tier === 'high') {
    lanes.push('brain', 'complex_subagent', 'code');
  }
  if (m.tier === 'mid') {
    lanes.push('simple_subagent', 'summary');
    if (lanes.length === 0) lanes.push('code');
  }
  if (m.tier === 'low') {
    lanes.push('simple_subagent', 'summary');
  }
  if (m.supportsVision) {
    lanes.push('vision');
  }

  return [...new Set(lanes)];
}

function buildEntry(def: ProviderDef, m: ModelDef, healthy: boolean): ModelCapabilityEntry {
  return {
    provider: def.id,
    providerName: def.name,
    model: m.id,
    modelName: m.name,
    apiMode: def.apiMode,
    tier: m.tier,
    healthy,
    supportsTools: m.supportsTools,
    supportsStreaming: m.supportsStreaming,
    supportsVision: m.supportsVision,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    inputCostPer1M: m.inputCostPer1M,
    outputCostPer1M: m.outputCostPer1M,
    cacheReadCostPer1M: m.cacheReadCostPer1M,
    recommendedLanes: inferLanes(m),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a point-in-time capability snapshot of all configured providers and
 * their models, marking each as healthy or unhealthy based on current env
 * key availability.
 *
 * @param explicitProviderIds - Provider IDs that must always be included
 *   even if `autoDetect` is false (e.g. CLI-pipe providers configured as
 *   brain_provider). This prevents the snapshot from silently dropping
 *   explicitly-configured providers.
 */
export function buildModelCapabilitySnapshot(
  explicitProviderIds?: string[],
): ModelCapabilitySnapshot {
  const providers = getAllProviders();
  const all: ModelCapabilityEntry[] = [];
  const explicitSet = new Set(explicitProviderIds ?? []);

  const seenProviders = new Set<string>();

  for (const def of providers) {
    // Include providers that are auto-detected OR explicitly requested.
    // This ensures CLI-pipe providers (autoDetect: false) appear in the
    // snapshot when configured as brain_provider.
    if (!def.autoDetect && !explicitSet.has(def.id)) continue;

    const healthy = isProviderHealthy(def);
    seenProviders.add(def.id);

    for (const m of def.models) {
      all.push(buildEntry(def, m, healthy));
    }
  }

  // Also pick up any explicit providers that weren't in getAllProviders()
  // (shouldn't happen, but defensive).
  for (const id of explicitSet) {
    if (seenProviders.has(id)) continue;
    const def = getProvider(id);
    if (!def) continue;
    const healthy = isProviderHealthy(def);
    seenProviders.add(def.id);
    for (const m of def.models) {
      all.push(buildEntry(def, m, healthy));
    }
  }

  const usable = all.filter(e => e.healthy);

  const snapshot: ModelCapabilitySnapshot = {
    generatedAt: new Date().toISOString(),
    all,
    usable,
    counts: {
      totalProviders: seenProviders.size,
      totalModels: all.length,
      healthyModels: usable.length,
      unhealthyModels: all.length - usable.length,
    },
  };

  logger.debug(
    { totalProviders: snapshot.counts.totalProviders, healthy: snapshot.counts.healthyModels, unhealthy: snapshot.counts.unhealthyModels },
    'Model capability snapshot built',
  );

  return snapshot;
}

/**
 * Format the snapshot for operator-visible output (CLI / status command).
 */
export function formatModelCapabilityOutput(snapshot: ModelCapabilitySnapshot): string {
  const lines: string[] = [
    'Model Capability Snapshot',
    `Generated: ${snapshot.generatedAt}`,
    `Providers: ${snapshot.counts.totalProviders} | Models: ${snapshot.counts.totalModels} (${snapshot.counts.healthyModels} healthy, ${snapshot.counts.unhealthyModels} unavailable)`,
    '',
  ];

  if (snapshot.usable.length === 0) {
    lines.push('No healthy models available. Configure at least one provider API key.');
    return lines.join('\n');
  }

  lines.push('Healthy Models:');
  for (const entry of snapshot.usable) {
    const cost = entry.inputCostPer1M != null
      ? ` $${entry.inputCostPer1M}/$${entry.outputCostPer1M} per 1M`
      : '';
    const caps = [
      entry.supportsTools ? 'tools' : null,
      entry.supportsVision ? 'vision' : null,
      entry.reasoning ? 'reasoning' : null,
      entry.supportsStreaming ? 'stream' : null,
    ].filter(Boolean).join(',');
    const lanes = entry.recommendedLanes.join(',');
    lines.push(`  ${entry.provider}/${entry.model} [${entry.tier}] (${caps})${cost} → lanes: ${lanes}`);
  }

  const unhealthy = snapshot.all.filter(e => !e.healthy);
  if (unhealthy.length > 0) {
    lines.push('');
    lines.push('Unavailable (no API key):');
    const providerIds = [...new Set(unhealthy.map(e => e.provider))];
    for (const pid of providerIds) {
      const models = unhealthy.filter(e => e.provider === pid).map(e => e.model).join(', ');
      lines.push(`  ${pid}: ${models}`);
    }
  }

  return lines.join('\n');
}
