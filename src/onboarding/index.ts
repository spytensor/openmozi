/**
 * Onboarding — Interactive first-run setup via Telegram conversation.
 *
 * Flow:
 * 1. Detect providers from env (API keys)
 * 2. User selects Brain model
 * 3. Model Discovery — list available models per provider
 * 4. Quick Benchmark — test reasoning, instruction following, code gen, tool calling
 * 5. Auto-generate Model Router config
 * 6. Save to mozi.json
 * 7. Mark onboarding complete
 */

import { create, type LLMClient, type ChatResponse } from '../core/llm.js';
import { detectConfiguredProviders, resolveApiKey, resolveBaseUrl, getWizardProviders, getProvider, getModel } from '../core/providers.js';
import { buildModelCapabilitySnapshot } from '../core/model-capability-map.js';
import { execSync } from 'node:child_process';
import { getBootstrapState, setBootstrapState } from './state.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { validateBotToken, setBotCommands } from '../channels/telegram.js';
import { getConfigPath } from '../paths.js';
import { readConfigWithLegacyFallback, writeConfigObject } from '../config/storage.js';
import {
  persistEnvValue,
  persistSearchKey,
  persistTelegramBotToken,
  saveServerDefaultsToConfig,
  saveWorkspaceDirToConfig,
} from './persistence.js';

const logger = pino({ name: 'mozi:onboarding' });

const NO_PROVIDER_GUIDE_IDS = ['anthropic', 'openai', 'google', 'deepseek', 'minimax', 'moonshot', 'groq', 'xai', 'mistral', 'zai', 'openrouter', 'claude-cli', 'codex-cli', 'gemini-cli'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  models: ModelInfo[];
  healthy: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  reasoning?: boolean;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
}

export interface BenchmarkResult {
  modelId: string;
  provider: string;
  reasoning: TestResult;
  instruction: TestResult;
  codeGen: TestResult;
  overall: number; // 0-100
  avgLatencyMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface TestResult {
  passed: boolean;
  latencyMs: number;
  tokens: number;
}

export interface OnboardingState {
  step: 'risk_ack' | 'configure_workspace' | 'detect_providers' | 'no_providers' | 'select_brain' | 'discover_models' | 'benchmark' | 'review_routing' | 'configure_search' | 'configure_channels' | 'complete';
  providers: ProviderInfo[];
  benchmarkResults: BenchmarkResult[];
  selectedBrain?: { provider: string; model: string };
  routingConfig?: RoutingConfig;
}

/** Recommended model for a routing preference slot. */
export interface RoutingRecommendation {
  role: string;
  provider: string;
  model: string;
  reason: string;
}

interface RoutingPreferencesConfig {
  cost_sensitivity?: 'low' | 'medium' | 'high';
  preferred_code?: { provider: string; model: string };
  preferred_vision?: { provider: string; model: string };
  preferred_cheap?: { provider: string; model: string };
  preferred_summary?: { provider: string; model: string };
}

interface RoutingConfig {
  brain: { provider: string; model: string };
  fallback_brain?: { provider: string; model: string };
  roles: {
    complex_subagent: { provider: string; model: string };
    simple_subagent: { provider: string; model: string };
    summary: { provider: string; model: string };
    code: { provider: string; model: string };
  };
  routing_preferences?: RoutingPreferencesConfig;
  /** Human-readable recommendations shown during onboarding. */
  recommendations?: RoutingRecommendation[];
}

interface RecommendationCandidate {
  provider: string;
  model: string;
  overall: number;
  avgLatencyMs: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

// ---------------------------------------------------------------------------
// Provider Detection
// ---------------------------------------------------------------------------

/**
 * Detect which LLM providers have API keys configured.
 * Uses the Provider Registry as single source of truth.
 */
export function detectProviders(): ProviderInfo[] {
  const configured = detectConfiguredProviders();
  const detected = configured.map(def => ({
    id: def.id,
    name: def.name,
    apiKey: resolveApiKey(def.id) || '',
    baseUrl: resolveBaseUrl(def.id),
    models: def.models.map(m => ({ id: m.id, name: m.name, provider: def.id, reasoning: m.reasoning })),
    healthy: false,
  }));

  // CLI-pipe providers have no API keys, so include them when their CLI command is installed.
  const seen = new Set(detected.map(p => p.id));
  for (const def of getWizardProviders()) {
    if (seen.has(def.id) || def.apiMode !== 'cli-pipe' || !def.cliBackend) continue;
    try {
      execSync(`command -v ${def.cliBackend.command}`, { stdio: 'pipe' });
    } catch {
      continue;
    }
    detected.push({
      id: def.id,
      name: def.name,
      apiKey: '',
      baseUrl: '',
      models: def.models.map(m => ({ id: m.id, name: m.name, provider: def.id, reasoning: m.reasoning })),
      healthy: false,
    });
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

/** API modes whose GET /models listing follows the {data: [{id}]} shape. */
const MODEL_LISTING_API_MODES = new Set(['openai-compat', 'openai-responses', 'anthropic']);

/** Model-id fragments that are never chat models — keep the drift log quiet. */
const DRIFT_IGNORED_ID_PARTS = ['tts', 'transcribe', 'whisper', 'moderation', 'embedding', 'embed', 'speech', 'image', 'video', 'audio', 'voice', 'music', 'rerank'];

/**
 * Pure part of the drift check: given the model ids a provider's API actually
 * serves, return the chat-model ids the bundled catalog doesn't know about.
 */
export function diffServedModelsAgainstCatalog(providerId: string, servedIds: string[]): string[] {
  const def = getProvider(providerId);
  if (!def) return [];
  const known = new Set(def.models.map(m => m.id.toLowerCase()));
  return servedIds
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .filter(id => !DRIFT_IGNORED_ID_PARTS.some(part => id.toLowerCase().includes(part)))
    .filter(id => !known.has(id.toLowerCase()));
}

/**
 * Best-effort catalog drift check: after a provider passes its health check,
 * list the models the API actually serves and warn about ids missing from the
 * bundled catalog. The catalog has repeatedly lagged reality (Kimi K2.6,
 * MiniMax M3 both shipped without entries); this makes the gap visible in the
 * logs instead of surfacing as "the model picker is missing X".
 * Never throws and never affects the health verdict.
 */
async function logCatalogDrift(provider: ProviderInfo): Promise<void> {
  try {
    const def = getProvider(provider.id);
    if (!def || !provider.apiKey || !MODEL_LISTING_API_MODES.has(def.apiMode)) return;
    const base = (provider.baseUrl || def.baseUrl).trim().replace(/\/+$/, '');
    if (!base) return;
    const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
      });
      if (!response.ok) return;
      body = await response.json();
    } finally {
      clearTimeout(timer);
    }

    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) return;
    const served = data
      .map(entry => (entry as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string');
    const missing = diffServedModelsAgainstCatalog(provider.id, served);
    if (missing.length > 0) {
      logger.warn(
        { provider: provider.id, missing: missing.slice(0, 10), missingCount: missing.length },
        'Provider serves models that are not in the bundled catalog — provider-catalog.ts may be stale',
      );
    }
  } catch {
    // Drift detection is advisory only.
  }
}

/**
 * Quick health check — send a tiny request to verify the provider works.
 * For CLI-pipe providers, verifies binary exists AND is authorized (not just `command -v`).
 */
export async function checkProviderHealth(provider: ProviderInfo): Promise<boolean> {
  try {
    // CLI-pipe providers — verify binary exists AND can actually run
    const providerDef = getProvider(provider.id);
    if (providerDef?.apiMode === 'cli-pipe' && providerDef.cliBackend) {
      const { detectCodingWorkers } = await import('./coding-workers.js');
      const probes = detectCodingWorkers();
      const probe = probes.find(p => p.command === providerDef.cliBackend!.command);
      if (!probe) {
        // Fallback: just check binary exists
        try {
          execSync(`command -v ${providerDef.cliBackend.command}`, { stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      }
      if (!probe.installed) {
        logger.warn({ provider: provider.id, command: probe.command }, 'CLI command not found in PATH');
        return false;
      }
      if (!probe.authorized) {
        logger.warn({ provider: provider.id, command: probe.command, authHint: probe.authHint }, 'CLI installed but not authorized');
        return false;
      }
      return true;
    }

    // Use provider's default model for health check (most reliable)
    const wizardDefs = getWizardProviders();
    const def = wizardDefs.find(d => d.id === provider.id);
    const model = (def ? provider.models.find(m => m.id === def.defaultModel) : null)
      ?? provider.models[0];
    const client = create(provider.id, {
      model: model.id,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
    });

    // Reasoning models (GPT-5, DeepSeek R1, etc.) don't support temperature
    const opts: Record<string, unknown> = { max_tokens: 16 };
    if (!model.reasoning) opts.temperature = 0;
    await client.chat(
      [{ role: 'user', content: 'Say "ok"' }],
      opts,
    );

    // A successful roundtrip means provider auth+endpoint+model are valid.
    // Some providers/models may emit reasoning-only chunks (empty final text),
    // which should still be considered healthy.
    void logCatalogDrift(provider);
    return true;
  } catch (err) {
    logger.warn({ provider: provider.id, error: err instanceof Error ? err.message : String(err) }, 'Provider health check failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

const BENCHMARK_TESTS = {
  reasoning: {
    prompt: 'If A implies B and B implies C, does A imply C? Answer with only "yes" or "no".',
    evaluate: (r: string) => r.toLowerCase().includes('yes'),
  },
  instruction: {
    prompt: 'Return exactly this JSON, nothing else: {"status": "ok", "count": 3}',
    evaluate: (r: string) => {
      try {
        const parsed = JSON.parse(r.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, ''));
        return parsed.status === 'ok' && parsed.count === 3;
      } catch {
        return false;
      }
    },
  },
  codeGen: {
    prompt: 'Write a Python function that reverses a string. Output ONLY the function definition, no explanation, no markdown.',
    evaluate: (r: string) => r.includes('def ') && (r.includes('reverse') || r.includes('[::-1]') || r.includes('reversed')),
  },
};

/**
 * Run benchmark suite on a single model. Uses max_tokens:50 to save cost.
 */
export async function benchmarkModel(provider: ProviderInfo, model: ModelInfo): Promise<BenchmarkResult> {
  const client = create(provider.id, {
    model: model.id,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
  });

  const results: Record<string, TestResult> = {};
  let totalLatency = 0;
  let totalTokens = 0;

  for (const [name, test] of Object.entries(BENCHMARK_TESTS)) {
    const start = Date.now();
    try {
      const benchOpts: Record<string, unknown> = { max_tokens: 100 };
      if (!model.reasoning) benchOpts.temperature = 0;
      const response = await client.chat(
        [{ role: 'user', content: test.prompt }],
        benchOpts,
      );
      const latency = Date.now() - start;
      const tokens = response.usage.input_tokens + response.usage.output_tokens;

      results[name] = {
        passed: test.evaluate(response.content),
        latencyMs: latency,
        tokens,
      };
      totalLatency += latency;
      totalTokens += tokens;
    } catch (err) {
      results[name] = { passed: false, latencyMs: Date.now() - start, tokens: 0 };
      logger.warn({ model: model.id, test: name, error: err instanceof Error ? err.message : String(err) }, 'Benchmark test failed');
    }
  }

  const passedCount = Object.values(results).filter(r => r.passed).length;
  const overall = Math.round((passedCount / Object.keys(BENCHMARK_TESTS).length) * 100);

  return {
    modelId: model.id,
    provider: provider.id,
    reasoning: results.reasoning,
    instruction: results.instruction,
    codeGen: results.codeGen,
    overall,
    avgLatencyMs: Math.round(totalLatency / Object.keys(BENCHMARK_TESTS).length),
    totalTokens,
    estimatedCostUsd: totalTokens * 0.00001, // rough estimate
  };
}

// ---------------------------------------------------------------------------
// Routing Generation
// ---------------------------------------------------------------------------

/**
 * Generate model routing config.
 *
 * @param benchmarks - Benchmark results for all tested models
 * @param brain - The user's explicitly chosen brain provider + model.
 *   This is NEVER overridden by benchmarks — the user's choice is final.
 *   Benchmarks only determine secondary roles (subagent, summary, etc.).
 */
export function generateRouting(
  benchmarks: BenchmarkResult[],
  brain: { provider: string; model: string },
): RoutingConfig {
  // Secondary models — ranked by score then latency (brain excluded from ranking)
  const secondary = [...benchmarks]
    .filter(b => !(b.provider === brain.provider && b.modelId === brain.model))
    .sort((a, b) => {
      if (b.overall !== a.overall) return b.overall - a.overall;
      return a.avgLatencyMs - b.avgLatencyMs;
    });

  const cheapest = [...benchmarks]
    .filter(b => b.overall >= 66)
    .sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd)[0];
  const fastest = [...benchmarks]
    .filter(b => b.overall >= 66)
    .sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0];

  // Fallback: best non-brain model, if available
  const fallback = secondary.length > 0 ? secondary[0] : undefined;

  // Build recommendations and preferences from capability snapshot
  const { recommendations, preferences } = generateRecommendations(brain, benchmarks);

  return {
    brain,
    fallback_brain: fallback
      ? { provider: fallback.provider, model: fallback.modelId }
      : undefined,
    roles: {
      complex_subagent: { provider: brain.provider, model: brain.model },
      simple_subagent: cheapest
        ? { provider: cheapest.provider, model: cheapest.modelId }
        : { provider: brain.provider, model: brain.model },
      summary: fastest
        ? { provider: fastest.provider, model: fastest.modelId }
        : { provider: brain.provider, model: brain.model },
      code: { provider: brain.provider, model: brain.model },
    },
    routing_preferences: preferences,
    recommendations,
  };
}

/**
 * Generate multi-model routing recommendations from the capability snapshot.
 * Uses healthy models to suggest practical role assignments.
 */
function generateRecommendations(
  brain: { provider: string; model: string },
  benchmarks: BenchmarkResult[],
): { recommendations: RoutingRecommendation[]; preferences: RoutingPreferencesConfig } {
  const explicitProviders = [...new Set([brain.provider, ...benchmarks.map((b) => b.provider)])];
  const snapshot = buildModelCapabilitySnapshot(explicitProviders);
  const snapshotByKey = new Map(snapshot.usable.map((entry) => [`${entry.provider}:${entry.model}`, entry] as const));
  const benchmarkedModels: RecommendationCandidate[] = benchmarks.map((benchmark) => {
    const key = `${benchmark.provider}:${benchmark.modelId}` as `${string}:${string}`;
    const snapshotEntry = snapshotByKey.get(key);
    const modelDef = getModel(benchmark.provider, benchmark.modelId);

    return {
      provider: benchmark.provider,
      model: benchmark.modelId,
      overall: benchmark.overall,
      avgLatencyMs: benchmark.avgLatencyMs,
      inputCostPer1M: snapshotEntry?.inputCostPer1M ?? modelDef?.inputCostPer1M,
      outputCostPer1M: snapshotEntry?.outputCostPer1M ?? modelDef?.outputCostPer1M,
      supportsTools: snapshotEntry?.supportsTools ?? modelDef?.supportsTools ?? false,
      supportsVision: snapshotEntry?.supportsVision ?? modelDef?.supportsVision ?? false,
    };
  });
  const qualifiedModels = benchmarkedModels.filter((candidate) => candidate.overall >= 66);
  const recommendations: RoutingRecommendation[] = [];
  const preferences: RoutingPreferencesConfig = { cost_sensitivity: 'medium' };

  // Brain is always first recommendation
  recommendations.push({
    role: 'brain',
    provider: brain.provider,
    model: brain.model,
    reason: 'User-selected primary brain model',
  });

  // Only recommend models that actually passed onboarding benchmarks.
  const cheapCandidates = qualifiedModels
    .filter(candidate => candidate.supportsTools && !(candidate.provider === brain.provider && candidate.model === brain.model))
    .sort((a, b) => ((a.inputCostPer1M ?? 50) + (a.outputCostPer1M ?? 50)) - ((b.inputCostPer1M ?? 50) + (b.outputCostPer1M ?? 50)));
  if (cheapCandidates.length > 0) {
    const pick = cheapCandidates[0];
    preferences.preferred_cheap = { provider: pick.provider, model: pick.model };
    recommendations.push({
      role: 'cheap executor',
      provider: pick.provider,
      model: pick.model,
      reason: `Cheapest healthy model with tool support ($${pick.inputCostPer1M ?? '?'}/$${pick.outputCostPer1M ?? '?'} per 1M)`,
    });
  }

  // Prefer a benchmarked vision-capable model, not a merely configured one.
  const visionCandidates = qualifiedModels
    .filter(candidate => candidate.supportsVision)
    .sort((a, b) => (a.inputCostPer1M ?? 50) - (b.inputCostPer1M ?? 50));
  if (visionCandidates.length > 0) {
    const pick = visionCandidates[0];
    preferences.preferred_vision = { provider: pick.provider, model: pick.model };
    if (pick.provider !== brain.provider || pick.model !== brain.model) {
      recommendations.push({
        role: 'vision/UI specialist',
        provider: pick.provider,
        model: pick.model,
        reason: `Vision-capable model${pick.provider !== brain.provider ? ' (different provider)' : ''}`,
      });
    }
  }

  // Code preference: brain model (user's explicit choice for quality)
  preferences.preferred_code = { provider: brain.provider, model: brain.model };

  // Summary preference: fastest from benchmarks or cheapest
  const fastBenchmark = [...benchmarks]
    .filter(b => b.overall >= 66)
    .sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0];
  if (fastBenchmark) {
    preferences.preferred_summary = { provider: fastBenchmark.provider, model: fastBenchmark.modelId };
    if (fastBenchmark.provider !== brain.provider || fastBenchmark.modelId !== brain.model) {
      recommendations.push({
        role: 'summary/fast',
        provider: fastBenchmark.provider,
        model: fastBenchmark.modelId,
        reason: `Fastest model passing quality bar (${fastBenchmark.avgLatencyMs}ms avg)`,
      });
    }
  }

  return { recommendations, preferences };
}

/**
 * Format routing recommendations for display during onboarding.
 */
export function formatRecommendations(recommendations: RoutingRecommendation[]): string {
  if (recommendations.length === 0) return 'No multi-model recommendations (single provider setup).';

  const lines = ['Recommended Model Stack:'];
  for (const rec of recommendations) {
    lines.push(`  ${rec.role}: ${rec.provider}/${rec.model}`);
    lines.push(`    ${rec.reason}`);
  }
  return lines.join('\n');
}

function formatRoutingAssignments(routing: RoutingConfig): string {
  const lines = [
    'Routing To Save:',
    `  Brain: ${routing.brain.provider}/${routing.brain.model}`,
  ];

  if (routing.fallback_brain) {
    lines.push(`  Fallback: ${routing.fallback_brain.provider}/${routing.fallback_brain.model}`);
  }

  lines.push(`  Complex Agent: ${routing.roles.complex_subagent.provider}/${routing.roles.complex_subagent.model}`);
  lines.push(`  Simple Agent: ${routing.roles.simple_subagent.provider}/${routing.roles.simple_subagent.model}`);
  lines.push(`  Summary: ${routing.roles.summary.provider}/${routing.roles.summary.model}`);
  lines.push(`  Code: ${routing.roles.code.provider}/${routing.roles.code.model}`);

  return lines.join('\n');
}

export function formatRoutingReview(routing: RoutingConfig): string {
  return [
    formatRecommendations(routing.recommendations ?? []),
    formatRoutingAssignments(routing),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Config Persistence
// ---------------------------------------------------------------------------

/**
 * Save routing config to mozi.json, merging with existing config.
 */
export function saveRoutingToConfig(routing: RoutingConfig, configPath = getConfigPath()): void {
  const existing = readConfigWithLegacyFallback(configPath).config;

  // Update brain config
  if (!existing.brain) existing.brain = {};
  (existing.brain as Record<string, unknown>).model = routing.brain.model;
  if (routing.fallback_brain) {
    (existing.brain as Record<string, unknown>).fallback_model = routing.fallback_brain.model;
  }

  // Update model_router
  const routerConfig: Record<string, unknown> = {
    brain_provider: routing.brain.provider,
    roles: routing.roles,
  };
  if (routing.fallback_brain) {
    routerConfig.fallback_brain_provider = routing.fallback_brain.provider;
  }
  if (routing.routing_preferences) {
    routerConfig.routing_preferences = routing.routing_preferences;
  }
  existing.model_router = routerConfig;

  writeConfigObject(configPath, existing);

  logger.info({ configPath }, 'Routing config saved');
}

/**
 * Mark onboarding as complete.
 */
export function completeOnboarding(): void {
  setBootstrapState('onboarding.completed', 'true');
  logger.info('Onboarding completed');
}

// ---------------------------------------------------------------------------
// Conversation Flow (Telegram interactive)
// ---------------------------------------------------------------------------

// Per-chat onboarding sessions
const sessions = new Map<string, OnboardingState>();

/**
 * Get or create an onboarding session for a chat.
 */
export function getSession(chatId: string): OnboardingState | undefined {
  return sessions.get(chatId);
}

/**
 * Start a new onboarding session.
 */
export function startSession(chatId: string): OnboardingState {
  // Skip risk_ack if already accepted
  const riskAccepted = getBootstrapState('risk_accepted') === 'true';
  const state: OnboardingState = {
    step: riskAccepted ? 'configure_workspace' : 'risk_ack',
    providers: [],
    benchmarkResults: [],
  };
  sessions.set(chatId, state);
  return state;
}

/**
 * Remove an onboarding session.
 */
export function endSession(chatId: string): void {
  sessions.delete(chatId);
}

/**
 * Check if a chat is in an active onboarding session.
 */
export function isOnboarding(chatId: string): boolean {
  return sessions.has(chatId);
}

/**
 * Process a user message during onboarding. Returns the bot's response.
 *
 * Smart flow:
 * - API keys detected → auto-select best provider/model → benchmark → apply → done
 * - No API keys → guide through provider setup (like OpenClaw onboard)
 */
export async function processOnboardingMessage(chatId: string, text: string): Promise<string> {
  const session = sessions.get(chatId);
  if (!session) return 'No active onboarding session.';

  switch (session.step) {
    case 'risk_ack':
      return handleRiskAck(session, text);

    case 'configure_workspace':
      return handleConfigureWorkspace(session, text);

    case 'detect_providers':
      return await handleDetectProviders(session, chatId);

    case 'no_providers':
      return handleNoProviders(session, chatId, text);

    case 'select_brain':
      return await handleSelectBrain(session, text);

    case 'discover_models':
      return await handleDiscoverModels(session);

    case 'benchmark':
      return await handleBenchmark(session);

    case 'review_routing':
      return handleReviewRouting(session, chatId, text);

    case 'configure_search':
      return handleConfigureSearch(session, text);

    case 'configure_channels':
      return await handleConfigureChannels(session, chatId, text);

    case 'complete':
      endSession(chatId);
      return 'Onboarding already complete!';

    default:
      return 'Unknown onboarding step.';
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Risk Acknowledgement (Issue #5)
// ---------------------------------------------------------------------------

/**
 * Show risk warning and require user to type "yes" to proceed.
 */
function handleRiskAck(session: OnboardingState, text: string): string {
  const input = text.trim().toLowerCase();

  if (input === 'yes') {
    setBootstrapState('risk_accepted', 'true');
    session.step = 'configure_workspace';
    return [
      '✅ Risk acknowledged.',
      '',
      '— Workspace Setup —',
      '',
      `Default workspace: ~/.mozi/workspace`,
      '',
      'Press enter / type "ok" to accept, or type a custom path:',
    ].join('\n');
  }

  // First call (empty text) or non-"yes" response — show warning
  return [
    '⚠️  Security & Liability Notice',
    '',
    'MOZI is an autonomous agent operating system.',
    'Once running, it MAY autonomously:',
    '',
    '• Execute arbitrary shell commands on your machine',
    '• Read, create, modify, and delete files',
    '• Install or remove software packages',
    '• Access network resources and external APIs',
    '• Consume LLM API tokens (which cost real money)',
    '• Spawn sub-agents that perform the above actions',
    '',
    'You are solely responsible for any consequences',
    'resulting from running MOZI, including but not',
    'limited to data loss, security breaches,',
    'unintended charges, or system damage.',
    '',
    'Recommended safety measures:',
    '• Run in a sandboxed / containerized environment',
    '• Limit filesystem access to the workspace directory',
    '• Set API spending limits with your LLM provider',
    '• Review agent actions regularly',
    '',
    'Type "yes" to accept these risks and continue:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Workspace Configuration (Issue #8)
// ---------------------------------------------------------------------------

/**
 * Resolve ~ to home directory in a path.
 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the system templates directory (dist/templates or src/templates).
 */
function resolveSystemTemplatesDir(): string {
  const distDir = join(dirname(fileURLToPath(import.meta.url)), 'templates');
  if (existsSync(distDir)) return distDir;
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

/**
 * Scaffold a workspace directory with user-layer files.
 *
 * System templates (SOUL.md, AGENTS.md) are loaded at runtime from dist/templates
 * and auto-updated with each release. User customizations live in *.local.md files
 * in the workspace directory.
 *
 * Migration: if a user previously edited SOUL.md or AGENTS.md in their workspace,
 * those files are renamed to *.local.md to preserve customizations.
 */
export function scaffoldWorkspace(dir: string): void {
  const expanded = expandHome(dir);
  mkdirSync(expanded, { recursive: true });

  // Migrate existing user-edited workspace templates to *.local.md
  migrateWorkspaceTemplates(expanded);

  // Create empty files/dirs if they don't exist
  const userMd = join(expanded, 'USER.md');
  if (!existsSync(userMd)) {
    writeFileSync(userMd, '# User Instructions\n\nAdd your custom instructions here.\n', 'utf-8');
  }

  const memoryMd = join(expanded, 'MEMORY.md');
  if (!existsSync(memoryMd)) {
    writeFileSync(memoryMd, '', 'utf-8');
  }

  const memoryDir = join(expanded, 'memory');
  mkdirSync(memoryDir, { recursive: true });
}

export function describeWorkspacePromptLayers(dir: string): string[] {
  const expanded = expandHome(dir);
  return [
    'System prompts update automatically from the MOZI release bundle.',
    `Your editable overrides live in ${join(expanded, 'SOUL.local.md')}, ${join(expanded, 'AGENTS.local.md')}, and ${join(expanded, 'USER.md')}.`,
    'Legacy workspace SOUL.md / AGENTS.md files are migrated to *.local.md when they contain custom edits.',
  ];
}

/**
 * Migrate workspace templates from the old copy-on-init pattern to the layered pattern.
 *
 * If the user has a SOUL.md or AGENTS.md in their workspace that differs from the
 * current system version, it's renamed to SOUL.local.md / AGENTS.local.md so their
 * customizations are preserved as an override layer.
 *
 * If the workspace copy is identical to the system version (never edited), it's removed
 * since the system version is now loaded directly from dist/templates at runtime.
 */
export function migrateWorkspaceTemplates(workspaceDir: string): void {
  const systemDir = resolveSystemTemplatesDir();

  for (const file of ['SOUL.md', 'AGENTS.md']) {
    const workspacePath = join(workspaceDir, file);
    const systemPath = join(systemDir, file);
    const localPath = join(workspaceDir, file.replace('.md', '.local.md'));

    if (!existsSync(workspacePath)) continue;
    if (!existsSync(systemPath)) continue;
    if (existsSync(localPath)) continue; // already migrated

    const workspaceContent = readFileSync(workspacePath, 'utf-8');
    const systemContent = readFileSync(systemPath, 'utf-8');

    if (workspaceContent !== systemContent) {
      // User has customized this template — preserve as .local.md override
      renameSync(workspacePath, localPath);
      logger.info({ file, localPath }, 'Migrated custom workspace template to .local.md');
    }
    // If identical to system, leave it. It won't be loaded (loadSystemPrompt reads
    // from dist/templates now), but removing it during migration could surprise users.
  }
}

/**
 * Handle workspace directory selection.
 */
function handleConfigureWorkspace(session: OnboardingState, text: string): string {
  const input = text.trim();
  const defaultPath = '~/.mozi/workspace';

  if (input === '' || input.toLowerCase() === 'ok') {
    // Accept default
    scaffoldWorkspace(defaultPath);
    saveWorkspaceDirToConfig(defaultPath);
    saveServerDefaultsToConfig();
    session.step = 'detect_providers';
    return [
      `✅ Workspace created at ${defaultPath}`,
      '',
      ...describeWorkspacePromptLayers(defaultPath),
      '',
      'Detecting LLM providers...',
    ].join('\n');
  }

  // Custom path
  const customPath = input;
  try {
    scaffoldWorkspace(customPath);
    saveWorkspaceDirToConfig(customPath);
    saveServerDefaultsToConfig();
    session.step = 'detect_providers';
    return [
      `✅ Workspace created at ${customPath}`,
      '',
      ...describeWorkspacePromptLayers(customPath),
      '',
      'Detecting LLM providers...',
    ].join('\n');
  } catch (err) {
    return `❌ Failed to create workspace at ${customPath}: ${err instanceof Error ? err.message : String(err)}\n\nTry a different path, or type "ok" for default (~/.mozi/workspace):`;
  }
}

// ---------------------------------------------------------------------------
// Search Tool Key Configuration
// ---------------------------------------------------------------------------

function handleConfigureSearch(session: OnboardingState, text: string): string {
  const input = text.trim();

  if (input === '' || input.toLowerCase() === 'skip' || input.toLowerCase() === 'no') {
    session.step = 'configure_channels';
    return [
      '⚠️ SEARCH1API_KEY skipped. web_search/web_fetch will stay disabled.',
      '',
      '— Channel Configuration —',
      '',
      'Configure Telegram bot? Paste your bot token or type "skip":',
      '',
      'To get a token, talk to @BotFather on Telegram.',
    ].join('\n');
  }

  const maybeKv = input.includes('=')
    ? input.slice(input.indexOf('=') + 1).trim()
    : input;
  if (!maybeKv) {
    return 'Please provide SEARCH1API_KEY, or type "skip":';
  }

  try {
    persistSearchKey(maybeKv);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist SEARCH1API_KEY to secret storage');
  }
  session.step = 'configure_channels';
  return [
    '✅ SEARCH1API_KEY configured. web_search/web_fetch enabled.',
    '',
    '— Channel Configuration —',
    '',
    'Configure Telegram bot? Paste your bot token or type "skip":',
    '',
    'To get a token, talk to @BotFather on Telegram.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Channel Configuration (Issue #7)
// ---------------------------------------------------------------------------

/**
 * Handle channel configuration after routing is saved.
 */
async function handleConfigureChannels(session: OnboardingState, chatId: string, text: string): Promise<string> {
  const input = text.trim();

  if (input.toLowerCase() === 'skip' || input.toLowerCase() === 'no') {
    completeOnboarding();
    session.step = 'complete';
    endSession(chatId);
    return [
      '✅ Onboarding complete!',
      '',
      'The runtime is ready. Send me a message or use /help.',
    ].join('\n');
  }

  // Check if it looks like a bot token (numeric:alphanumeric)
  if (/^\d+:[A-Za-z0-9_-]+$/.test(input)) {
    const result = await validateBotToken(input);
    if (result.valid) {
      persistTelegramBotToken(input);
      try {
        await setBotCommands(input);
      } catch {
        // Non-fatal
      }
      completeOnboarding();
      session.step = 'complete';
      endSession(chatId);
      return [
        `✅ Telegram bot configured: @${result.username} (${result.botName})`,
        'Bot commands registered.',
        '',
        '✅ Onboarding complete!',
        'Restart the runtime to apply the new Telegram configuration.',
      ].join('\n');
    }
    return '❌ Invalid bot token. Please paste a valid token, or type "skip":';
  }

  // First entry to this step (empty text or unknown)
  return [
    '— Channel Configuration —',
    '',
    'Configure Telegram bot? Paste your bot token or type "skip":',
    '',
    'To get a token, talk to @BotFather on Telegram.',
  ].join('\n');
}

/** Provider tier ranking — higher = better brain candidate */
const PROVIDER_RANK: Record<string, number> = {
  anthropic: 100,
  openai: 90,
  google: 80,
  zai: 75,
  openrouter: 72,
  deepseek: 70,
  minimax: 68,
  moonshot: 65,
  groq: 60,
  together: 55,
  mistral: 55,
  huggingface: 50,
  glm: 65,
};

/** Pick the best model from healthy providers as default brain. */
function pickBestBrain(providers: ProviderInfo[]): { provider: ProviderInfo; model: ModelInfo } | null {
  // Sort providers by rank
  const sorted = [...providers].sort((a, b) => (PROVIDER_RANK[b.id] ?? 0) - (PROVIDER_RANK[a.id] ?? 0));
  const wizardDefs = getWizardProviders();
  for (const p of sorted) {
    if (p.models.length > 0) {
      const def = wizardDefs.find(d => d.id === p.id);
      const defaultModel = def ? p.models.find(m => m.id === def.defaultModel) : null;
      return { provider: p, model: defaultModel ?? p.models[0] };
    }
  }
  return null;
}

async function handleDetectProviders(session: OnboardingState, chatId: string): Promise<string> {
  const providers = detectProviders();

  if (providers.length === 0) {
    const wizardProviders = getWizardProviders().filter(provider => NO_PROVIDER_GUIDE_IDS.includes(provider.id));
    const options = wizardProviders
      .map((provider, idx) => `${idx + 1}. ${provider.name}`)
      .join('\n');

    // No keys at all → guided setup
    session.step = 'no_providers';
    return [
      'Welcome to your agent runtime',
      '',
      'No LLM provider API keys detected.',
      'Which provider would you like to use?',
      '',
      options || '1. Anthropic\n2. OpenAI\n3. Google\n4. DeepSeek',
      '',
      'Reply with a number, or paste your API key directly (auto-detect):',
    ].join('\n');
  }

  // Keys found → auto-detect, health check, and go
  const lines = ['Agent Runtime — Initializing...\n'];

  for (const p of providers) {
    p.healthy = await checkProviderHealth(p);
    const icon = p.healthy ? '✅' : '❌';
    lines.push(`${icon} ${p.name}`);
  }

  const healthyProviders = providers.filter(p => p.healthy);

  if (healthyProviders.length === 0) {
    lines.push('\n⚠️ All providers failed health check. Verify your API keys and restart.');
    return lines.join('\n');
  }

  session.providers = healthyProviders;

  // Auto-select best brain
  const best = pickBestBrain(healthyProviders);
  if (!best) {
    session.step = 'select_brain';
    return lines.join('\n') + '\n\nCould not auto-select. Please choose manually.';
  }

  session.selectedBrain = { provider: best.provider.id, model: best.model.id };
  lines.push(`\nBrain: ${best.model.name} (${best.provider.name})`);
  lines.push('Running benchmarks...');

  // Auto-proceed to benchmark
  session.step = 'benchmark';
  const benchmarkResult = await handleBenchmark(session);

  // If benchmark produced routing, auto-apply and proceed to search key config
  if (session.routingConfig) {
    saveRoutingToConfig(session.routingConfig);
    session.step = 'configure_search';

    return [
      ...lines,
      '',
      benchmarkResult,
      '',
      '✅ Model routing saved automatically.',
      '',
      '— Search Tool Setup —',
      '',
      'Paste SEARCH1API_KEY to enable web_search/web_fetch, or type "skip":',
    ].join('\n');
  }

  return lines.join('\n') + '\n\n' + benchmarkResult;
}

/**
 * Handle the guided setup when no API keys are detected.
 */
function handleNoProviders(session: OnboardingState, chatId: string, text: string): string {
  const input = text.trim();
  const lower = input.toLowerCase();

  // Accept KEY=VALUE quick input.
  if (input.includes('=')) {
    const eq = input.indexOf('=');
    const key = input.slice(0, eq).trim().toUpperCase();
    const value = input.slice(eq + 1).trim();
    if (key && value) {
      try {
        persistEnvValue(key, value);
      } catch (err) {
        logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, 'Failed to persist onboarding env input');
        process.env[key] = value;
      }
      session.step = 'detect_providers';
      return `Set ${key}. Detecting providers...`;
    }
  }

  const detectProviderFromKey = (): { id: string; envKey: string; name: string } | null => {
    const wizardProviders = getWizardProviders();
    const provider = (id: string) => wizardProviders.find(p => p.id === id);

    if (input.startsWith('sk-ant-')) {
      const p = provider('anthropic');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    if (input.startsWith('sk-or-')) {
      const p = provider('openrouter');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    if (input.startsWith('gsk_')) {
      const p = provider('groq');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    if (input.startsWith('hf_')) {
      const p = provider('huggingface');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    if (input.startsWith('AIza')) {
      const p = provider('google');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    if (input.startsWith('eyJ')) {
      const p = provider('minimax');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    if (input.startsWith('sk-')) {
      const p = provider('openai');
      return p ? { id: p.id, envKey: p.envKey, name: p.name } : null;
    }
    return null;
  };

  // If user pasted a key, auto-map to a provider.
  if (input.length >= 12 && !input.startsWith('/') && !Number.isFinite(Number(input))) {
    const detected = detectProviderFromKey();
    if (detected) {
      try {
        persistEnvValue(detected.envKey, input);
      } catch (err) {
        logger.warn({ key: detected.envKey, err: err instanceof Error ? err.message : String(err) }, 'Failed to persist detected provider key during onboarding');
        process.env[detected.envKey] = input;
      }
      session.step = 'detect_providers';
      return `${detected.name} API key set (${detected.envKey}). Detecting providers...`;
    }
  }

  // Number selection → show env setup for selected provider.
  const wizardProviders = getWizardProviders().filter(provider => NO_PROVIDER_GUIDE_IDS.includes(provider.id));
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= wizardProviders.length) {
    const selected = wizardProviders[num - 1];

    // CLI-pipe provider — verify CLI exists, no API key needed
    if (selected.apiMode === 'cli-pipe' && selected.cliBackend) {
      const command = selected.cliBackend.command;
      let cliFound = false;
      try {
        execSync(`command -v ${command}`, { stdio: 'pipe' });
        cliFound = true;
      } catch { /* not found */ }

      if (cliFound) {
        // Set up as provider (no env var needed)
        session.providers = [{
          id: selected.id,
          name: selected.name,
          apiKey: '',
          models: selected.models.map(m => ({ id: m.id, name: m.name, provider: selected.id })),
          healthy: true,
        }];
        session.step = 'detect_providers';
        return `✅ Found "${command}" CLI — no API key needed. Detecting providers...`;
      }

      return [
        `❌ "${command}" not found in PATH.`,
        '',
        `Install ${selected.name} first, then try again.`,
        '',
        `Reply with 1-${wizardProviders.length} to choose a different provider, or paste your API key directly:`,
      ].join('\n');
    }

    const aliases = selected.env.keyAliases.length > 0
      ? `Aliases: ${selected.env.keyAliases.join(', ')}`
      : '';
    const primaryPrefix = selected.env.keyPrefixes[0];
    const comboKeys = primaryPrefix
      ? [
          `MOZI_LIVE_${primaryPrefix}_KEY`,
          `${primaryPrefix}_API_KEYS`,
          `${primaryPrefix}_API_KEY_1`,
        ].join(', ')
      : '';

    const lines = [
      `Set ${selected.envKey} in your secret storage or .env:`,
      '',
      `${selected.envKey}=<your-key>`,
      '',
    ];
    if (aliases) {
      lines.push(aliases, '');
    }
    if (comboKeys) {
      lines.push(`Supported key-combo envs: ${comboKeys}`, '');
    }
    lines.push('Then restart MOZI, or paste your key here:');
    return lines.join('\n');
  }

  return `Reply with 1-${wizardProviders.length} to choose a provider, paste KEY=VALUE, or paste your API key directly.`;
}

async function handleSelectBrain(session: OnboardingState, text: string): Promise<string> {
  const input = text.trim();

  // Flatten all models
  const allModels: { provider: ProviderInfo; model: ModelInfo }[] = [];
  for (const p of session.providers) {
    for (const m of p.models) {
      allModels.push({ provider: p, model: m });
    }
  }

  // Try as number first
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= allModels.length) {
    const selected = allModels[num - 1];
    session.selectedBrain = { provider: selected.provider.id, model: selected.model.id };
    session.step = 'discover_models';
    return `Selected: ${selected.model.name} (${selected.provider.name})\n\nRunning model benchmarks... (this takes ~30 seconds)`;
  }

  // Try to match model name / ID from input text
  const normalized = input.toLowerCase().replace(/[^a-z0-9.-]/g, '');
  for (const { provider, model } of allModels) {
    const modelNorm = model.id.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const nameNorm = model.name.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (normalized.includes(modelNorm) || normalized.includes(nameNorm) || modelNorm.includes(normalized)) {
      session.selectedBrain = { provider: provider.id, model: model.id };
      session.step = 'discover_models';
      return `Matched: ${model.name} (${provider.name})\n\nRunning model benchmarks... (this takes ~30 seconds)`;
    }
  }

  // Allow custom model: "provider:model-id" or just "model-id" (defaults to first healthy provider)
  if (input.includes(':')) {
    const [provId, modelId] = input.split(':', 2);
    const matchedProvider = session.providers.find(p => p.id === provId.trim().toLowerCase());
    if (matchedProvider) {
      // Add custom model to provider's model list
      const customModel: ModelInfo = { id: modelId.trim(), name: modelId.trim(), provider: matchedProvider.id };
      matchedProvider.models.push(customModel);
      session.selectedBrain = { provider: matchedProvider.id, model: modelId.trim() };
      session.step = 'discover_models';
      return `Custom model added: ${modelId.trim()} (${matchedProvider.name})\n\nRunning model benchmarks... (this takes ~30 seconds)`;
    }
  }

  // Treat as custom model ID for first available provider
  if (input.length > 2 && !input.startsWith('/')) {
    const provider = session.providers[0];
    const customModel: ModelInfo = { id: input, name: input, provider: provider.id };
    provider.models.push(customModel);
    session.selectedBrain = { provider: provider.id, model: input };
    session.step = 'discover_models';
    return `Custom model added: ${input} (${provider.name})\n\nRunning model benchmarks... (this takes ~30 seconds)`;
  }

  return `Reply with a number (1-${allModels.length}), a model name, or a custom model ID:`;
}

export function saveCustomProviderToConfig(baseUrl: string, apiKey: string, modelId: string, configPath = getConfigPath()): void {
  const existing = readConfigWithLegacyFallback(configPath).config;

  if (!existing.providers) {
    existing.providers = [];
  }

  const providers = existing.providers as Array<Record<string, unknown>>;
  providers.push({
    base_url: baseUrl,
    ...(apiKey ? { api_key: apiKey } : {}),
    model: modelId,
  });

  writeConfigObject(configPath, existing);
  logger.info({ baseUrl, modelId }, 'Custom provider config saved');
}

async function handleDiscoverModels(session: OnboardingState): Promise<string> {
  // Automatically proceed to benchmark
  session.step = 'benchmark';
  return await handleBenchmark(session);
}

async function handleBenchmark(session: OnboardingState): Promise<string> {
  const results: BenchmarkResult[] = [];

  for (const provider of session.providers) {
    for (const model of provider.models) {
      try {
        const result = await benchmarkModel(provider, model);
        results.push(result);
        logger.info({
          model: model.id,
          overall: result.overall,
          latency: result.avgLatencyMs,
        }, 'Benchmark complete');
      } catch (err) {
        logger.warn({ model: model.id, error: err instanceof Error ? err.message : String(err) }, 'Benchmark failed');
      }
    }
  }

  session.benchmarkResults = results;

  if (results.length === 0) {
    session.step = 'detect_providers';
    return '⚠️ All benchmarks failed. Check provider connectivity and try /onboard again.';
  }

  // Generate routing — brain is the user's explicit selection, never overridden
  const brain = session.selectedBrain ?? { provider: results[0].provider, model: results[0].modelId };
  const routing = generateRouting(results, brain);
  session.routingConfig = routing;
  session.step = 'review_routing';

  // Format results table
  const lines = ['📊 Benchmark Results:\n'];
  lines.push('Model                 | Reasoning | Instruct | Code | Score | Latency');
  lines.push('─'.repeat(70));

  for (const r of results) {
    const pass = (t: TestResult) => t.passed ? '✅' : '❌';
    const name = r.modelId.padEnd(22).slice(0, 22);
    lines.push(`${name}| ${pass(r.reasoning)}        | ${pass(r.instruction)}       | ${pass(r.codeGen)}   | ${String(r.overall).padStart(3)}%  | ${r.avgLatencyMs}ms`);
  }

  lines.push('');
  lines.push(formatRoutingReview(routing));
  lines.push('\nApply this routing? (yes/no)');

  return lines.join('\n');
}

function handleReviewRouting(session: OnboardingState, chatId: string, text: string): string {
  const answer = text.trim().toLowerCase();

  if (answer === 'yes' || answer === 'y') {
    if (session.routingConfig) {
      saveRoutingToConfig(session.routingConfig);
    }
    session.step = 'configure_search';

    return [
      '✅ Model routing saved to mozi.json.',
      '',
      '— Search Tool Setup —',
      '',
      'Paste SEARCH1API_KEY to enable web_search/web_fetch, or type "skip":',
      '',
      'Get a key from Search1API dashboard.',
    ].join('\n');
  }

  if (answer === 'no' || answer === 'n') {
    session.step = 'select_brain';
    const allModels: string[] = [];
    let idx = 1;
    for (const p of session.providers) {
      for (const m of p.models) {
        allModels.push(`${idx}. ${m.name} (${p.name})`);
        idx++;
      }
    }
    return [
      'Routing rejected. Let\'s try again.',
      '',
      '— Select Brain Model —',
      '',
      ...allModels,
      '',
      `Reply with a number (1-${idx - 1}):`,
    ].join('\n');
  }

  return 'Please reply with "yes" or "no".';
}
