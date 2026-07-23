/**
 * Provider Registry — Single source of truth for all LLM provider definitions.
 *
 * Responsibilities:
 * - Provider/model catalog metadata (via provider-catalog.ts)
 * - API mode routing metadata (adapter selection)
 * - API key normalization for `mozi onboard` + onboarding discovery
 * - Backward-compatible env/config migration helpers (via legacy-migration.ts)
 */

import {
  PROVIDERS,
  WIZARD_PROVIDER_IDS,
  parseApiKeysList,
  resolveNumberedApiKeys,
  resolveForwardCompatModel,
} from './provider-catalog.js';
import { isSafeCustomModelId } from './model-discovery.js';

// Re-export catalog + migration for consumers that import from providers.js
export { PROVIDERS, WIZARD_PROVIDER_IDS } from './provider-catalog.js';
export { migrateEnvVars } from './legacy-migration.js';
export type { MigrationResult } from './legacy-migration.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderApiMode =
  | 'openai-compat'
  | 'anthropic'
  | 'openai-responses'
  | 'openai-codex-responses'
  | 'google-generative-ai'
  | 'bedrock-converse-stream'
  | 'ollama-native'
  | 'cli-pipe';

/** Declarative backend config for CLI-pipe providers (inspired by OpenClaw). */
export interface CliBackendConfig {
  /** CLI executable name (e.g. "claude", "codex", "gemini"). */
  command: string;
  /** Base args passed on every invocation. */
  args: string[];
  /** Args used when resuming a session (replaces `args`). */
  resumeArgs?: string[];
  /** How the prompt is passed: as the last CLI arg, or via stdin. */
  input: 'arg' | 'stdin';
  /** How to parse stdout: single JSON object, newline-delimited JSON, or raw text. */
  output: 'json' | 'jsonl' | 'text';
  /** Auto-switch to stdin when the UTF-8 prompt reaches this many bytes. */
  maxPromptArgBytes?: number;
  /** Args appended when the prompt is delivered through stdin. */
  stdinPromptArgs?: string[];
  /** CLI flag for specifying the model (e.g. "--model"). */
  modelArg?: string;
  /** @deprecated — removed. CLI providers must respect user-configured model IDs. */
  fixedModel?: never;
  /** Inline system prompt into the user prompt when no dedicated system arg exists. */
  inlineSystemPrompt?: boolean;
  /** Optional CLI flag for prompt text in non-interactive/headless mode (e.g. "-p"). */
  promptArg?: string;
  /** Map MOZI model IDs → CLI-specific model names. */
  modelAliases?: Record<string, string>;
  /** CLI flag for system prompt (e.g. "--append-system-prompt"). */
  systemPromptArg?: string;
  /** How to encode system prompt value for `systemPromptArg`. */
  systemPromptFormat?: 'raw' | 'codex-config-instructions';
  /** When to include system prompt: only on first turn, or every turn. */
  systemPromptWhen?: 'first' | 'always';
  /** CLI flag for session/conversation ID (e.g. "--session-id"). */
  sessionArg?: string;
  /** Session handling mode: always create, reuse existing, or never. */
  sessionMode?: 'always' | 'existing' | 'none';
  /** JSON field path(s) to extract session ID from CLI output. */
  sessionIdFields?: string[];
  /** CLI flag for image path (vision support). */
  imageArg?: string;
  /** Optional CLI flag for MCP config path when the CLI supports MCP client mode. */
  mcpConfigArg?: string;
  /** Optional CLI flag to require strict MCP config handling. */
  strictMcpConfigFlag?: string;
  /** Per-invocation timeout in ms (default 120_000). */
  timeoutMs?: number;
}

export interface ModelDef {
  id: string;
  name: string;
  tier: 'high' | 'mid' | 'low';
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  reasoning: boolean;        // reasoning model — temperature not supported
  inputCostPer1M?: number;   // USD per 1M input tokens
  outputCostPer1M?: number;  // USD per 1M output tokens
  cacheReadCostPer1M?: number; // USD per 1M provider-managed cache-read tokens
  cacheWriteCostPer1M?: number; // USD per 1M provider-managed cache-write tokens
}

export interface RegionDef {
  id: string;
  name: string;
  baseUrl: string;
}

export interface ForwardCompatRule {
  pattern: RegExp;
  templateModel: string;
}

export interface ProviderEnvDef {
  /** Canonical env var for single-key setup */
  primaryKey: string;
  /** Backward-compatible aliases (e.g. GOOGLE_API_KEY for Gemini) */
  keyAliases: string[];
  /** Prefixes used by key-combo envs (LIVE/API_KEYS/API_KEY_N) */
  keyPrefixes: string[];
  /** Optional explicit base URL env vars in priority order */
  baseUrlKeys: string[];
}

/**
 * How the adapter lays out system messages for a provider's API.
 *
 * 'preserve-interleaved' keeps system messages where the runtime placed them
 * (turn context after history, kernel directives at the tail). This is what
 * keeps provider-side prefix caches alive: mid-turn directives append instead
 * of rewriting the head of every request.
 *
 * 'interleaved-as-user' keeps every message in place but sends mid-array
 * system messages (anything after the leading system block) with role 'user',
 * content untouched. For providers whose SERVER re-positions mid-conversation
 * system messages: DeepSeek accepts them over HTTP but its template handling
 * kills prefix-cache reuse for everything after the head the moment one
 * appears in a tool loop — probed live 2026-07-20: identical byte-wise
 * requests, cache capped at the pre-loop head with mid-array system, full
 * reuse without them or with the same content as user role.
 *
 * 'consolidate-leading' merges every system message into one leading block.
 * Required by APIs that reject or misread mid-conversation system messages
 * (Anthropic transports, Qwen/DashScope's messages[0] rule).
 */
export type SystemMessagePolicy = 'preserve-interleaved' | 'interleaved-as-user' | 'consolidate-leading';

export interface ProviderDef {
  id: string;
  name: string;
  /** Backward-compatible alias for existing callers/tests */
  envKey: string;
  baseUrl: string;
  /** Backward-compatible alias for existing callers/tests */
  apiType: ProviderApiMode;
  apiMode: ProviderApiMode;
  defaultModel: string;
  models: ModelDef[];
  /**
   * System-message layout this provider's API is verified to accept. Unset
   * defaults to 'consolidate-leading': the conservative failure mode is lost
   * cache efficiency, not a rejected request. Only set 'preserve-interleaved'
   * after verifying the endpoint accepts a system message after tool results.
   */
  systemMessagePolicy?: SystemMessagePolicy;
  hint?: string;
  placeholder?: string;
  /** Regional endpoint variants (e.g. MiniMax global vs China) */
  regions?: RegionDef[];
  /** Env resolution metadata */
  env: ProviderEnvDef;
  /** Unknown-but-related model fallback template rules */
  forwardCompat?: ForwardCompatRule[];
  /** Whether detectConfiguredProviders should auto-include this provider */
  autoDetect: boolean;
  /** CLI backend config (only for apiMode === 'cli-pipe'). */
  cliBackend?: CliBackendConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get a provider definition by ID */
export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS[id];
}

/**
 * API modes where a declared non-consolidating policy is even honorable.
 * Every other transport (anthropic, bedrock, google-generative-ai,
 * ollama-native, cli-pipe) either rejects mid-array system messages outright
 * or has no verified in-array system contract, so a catalog typo there must
 * not be able to ship a rejected-request bug.
 */
const PRESERVE_CAPABLE_API_MODES: ReadonlySet<ProviderApiMode> = new Set([
  'openai-responses',
  'openai-codex-responses',
  'openai-compat',
]);

/**
 * Resolve the system-message layout for a provider. Unknown providers (custom
 * OpenAI-compatible endpoints) and providers without an explicit policy get
 * 'consolidate-leading' — never guess 'preserve-interleaved' from apiMode
 * alone, since protocol compatibility does not imply mid-conversation system
 * support (Qwen/DashScope is OpenAI-compatible and still requires messages[0]).
 * A declared non-consolidating policy is honored only on OpenAI-family API
 * modes; on any other transport it is a misconfiguration and consolidation wins.
 */
export function resolveSystemMessagePolicy(providerId: string | undefined): SystemMessagePolicy {
  const def = providerId ? getProvider(providerId) : undefined;
  if (!def) return 'consolidate-leading';
  if (!PRESERVE_CAPABLE_API_MODES.has(def.apiMode)) return 'consolidate-leading';
  return def.systemMessagePolicy ?? 'consolidate-leading';
}

/** Get all registered providers */
export function getAllProviders(): ProviderDef[] {
  return Object.values(PROVIDERS);
}

/** Get providers suitable for the setup wizard */
export function getWizardProviders(): ProviderDef[] {
  return WIZARD_PROVIDER_IDS
    .map(id => PROVIDERS[id])
    .filter((provider): provider is ProviderDef => Boolean(provider));
}

/** Providers with an implemented chat-role execution path. */
export function isChatRoleEligibleProvider(providerOrId: ProviderDef | string | undefined): boolean {
  const def = typeof providerOrId === 'string' ? getProvider(providerOrId) : providerOrId;
  return Boolean(def && (def.apiMode !== 'cli-pipe' || def.id === 'codex-cli' || def.id === 'claude-cli'));
}

/** Providers that can be used for brain/light model roles. */
export function getChatRoleEligibleProviders(): ProviderDef[] {
  return getAllProviders().filter(isChatRoleEligibleProvider);
}

/** Resolve API keys for a provider using normalized env precedence. */
export function resolveApiKeys(providerId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const def = PROVIDERS[providerId];
  if (!def) return [];

  const seen = new Set<string>();
  const resolved: string[] = [];

  const addValue = (value: string | undefined) => {
    const trimmed = (value || '').trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    resolved.push(trimmed);
  };

  // 1) Per-provider live override: MOZI_LIVE_<PROVIDER>_KEY
  for (const prefix of def.env.keyPrefixes) {
    addValue(env[`MOZI_LIVE_${prefix}_KEY`]);
  }

  // 2) Combined list: <PROVIDER>_API_KEYS (comma/semicolon)
  for (const prefix of def.env.keyPrefixes) {
    for (const value of parseApiKeysList(env[`${prefix}_API_KEYS`])) {
      addValue(value);
    }
  }

  // 3) Primary + aliases
  addValue(env[def.env.primaryKey]);
  for (const alias of def.env.keyAliases) {
    addValue(env[alias]);
  }

  // 4) Numbered fallback: <PROVIDER>_API_KEY_1, _2, ...
  for (const prefix of def.env.keyPrefixes) {
    for (const value of resolveNumberedApiKeys(prefix, env)) {
      addValue(value);
    }
  }

  return resolved;
}

/** Resolve the first (highest-priority) API key for a provider. */
export function resolveApiKey(
  providerId: string,
  configProviders?: Record<string, { apikey?: string }>,
): string | undefined {
  // Config override (highest priority)
  const configEntry = configProviders?.[providerId];
  if (configEntry?.apikey?.trim()) return configEntry.apikey.trim();

  return resolveApiKeys(providerId)[0];
}

/** Resolve base URL for a provider — config override > env var override > registry default. */
export function resolveBaseUrl(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
  configProviders?: Record<string, { baseurl?: string }>,
): string {
  // Config override (highest priority)
  const configEntry = configProviders?.[providerId];
  if (configEntry?.baseurl?.trim()) return configEntry.baseurl.trim();

  const def = PROVIDERS[providerId];
  if (!def) return '';

  for (const envKey of def.env.baseUrlKeys) {
    const value = (env[envKey] || '').trim();
    if (value) {
      return value;
    }
  }

  return def.baseUrl;
}

/** Resolve API mode for adapter routing. */
export function resolveApiMode(providerId: string): ProviderApiMode | undefined {
  return PROVIDERS[providerId]?.apiMode;
}

/** Get a specific model definition from a provider (supports forward-compat clone). */
export function getModel(providerId: string, modelId: string): ModelDef | undefined {
  const def = PROVIDERS[providerId];
  if (!def) return undefined;

  const exact = def.models.find(m => m.id === modelId);
  if (exact) {
    return exact;
  }

  return resolveForwardCompatModel(def, modelId);
}

/** Resolve an operator-selected live/manual model with conservative capabilities. */
export function resolveRuntimeModel(providerId: string, modelId: string, options: { allowUnknown?: boolean } = {}): ModelDef | undefined {
  const known = getModel(providerId, modelId);
  if (known) return known;
  const provider = PROVIDERS[providerId];
  const trimmed = modelId.trim();
  if (!options.allowUnknown || !provider || provider.apiMode === 'cli-pipe' || !isSafeCustomModelId(trimmed)) return undefined;
  return {
    id: trimmed,
    name: trimmed,
    tier: 'low',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    supportsTools: false,
    supportsStreaming: true,
    supportsVision: false,
    reasoning: false,
  };
}

/** Detect which providers have API keys configured in process.env. */
export function detectConfiguredProviders(env: NodeJS.ProcessEnv = process.env): ProviderDef[] {
  return getAllProviders().filter(def => def.autoDetect && resolveApiKeys(def.id, env).length > 0);
}

/**
 * Get providers that have vision-capable models AND valid API keys.
 * Returns entries ordered: openai-compat first (broadest raw-fetch support),
 * then anthropic-format providers.
 */
export function getVisionCapableProviders(): Array<{
  provider: string;
  model: string;
  apiMode: ProviderApiMode;
  baseUrl: string;
}> {
  const result: Array<{ provider: string; model: string; apiMode: ProviderApiMode; baseUrl: string }> = [];
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (!resolveApiKey(id)) continue;
    const visionModel = def.models.find(m => m.supportsVision);
    if (!visionModel) continue;
    result.push({
      provider: id,
      model: visionModel.id,
      apiMode: def.apiMode,
      baseUrl: resolveBaseUrl(id),
    });
  }
  // Prefer openai-compat / openai-responses (raw-fetch friendly) over anthropic
  result.sort((a, b) => {
    const aScore = a.apiMode === 'anthropic' ? 1 : 0;
    const bScore = b.apiMode === 'anthropic' ? 1 : 0;
    return aScore - bScore;
  });
  return result;
}
