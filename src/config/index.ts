import { z } from 'zod';
import { getConfigPath, getDefaultAllowedRoots, getDefaultWorkspaceDir } from '../paths.js';
import { readConfigWithLegacyFallback } from './storage.js';
import { MCPConfigSchema } from '../mcp/config.js';

// ---------------------------------------------------------------------------
// Zod schemas for each config section
// ---------------------------------------------------------------------------

const SystemConfigSchema = z.object({
  max_parallel_agents: z.number().default(5),
  watchdog_interval_seconds: z.number().default(5),
  heartbeat_timeout_seconds: z.number().default(15),
});

const BrainConfigSchema = z.object({
  model: z.string().default(''),
  fallback_model: z.string().default(''),
  think: z.union([z.boolean(), z.enum(['low', 'medium', 'high']), z.number().int().min(1)]).optional(),
  max_dag_depth: z.number().default(5),
  max_plan_steps: z.number().default(12),
  // How decompose_task executes the plan DAG.
  // Production only accepts 'background' (the default). 'inline' was a legacy
  // synchronous mode that caused double-execution and turn-timeout fragility; it
  // has been removed from production. If your config still sets 'inline', it is
  // silently mapped to 'background' with a loud startup warning — do not ship
  // configs with 'inline'. The only remaining test-only escape hatch is the env
  // variable MOZI_TEST_INLINE_DAG=1 (see dag-bridge.ts).
  dag_execution_mode: z
    .union([z.literal('background'), z.literal('inline')])
    .default('background')
    .transform((val) => {
      if (val === 'inline') {
        // Loud warning: inline is not a valid production mode.
        // eslint-disable-next-line no-console
        console.warn(
          '[MOZI CONFIG WARNING] brain.dag_execution_mode="inline" is no longer supported in ' +
          'production. The value has been mapped to "background". Update your config to remove ' +
          '"inline" or set MOZI_TEST_INLINE_DAG=1 for the test-only inline path.',
        );
        return 'background' as const;
      }
      return 'background' as const;
    }),
  // Resume incomplete plan DAGs at process startup (crash or restart recovery).
  resume_plans_on_boot: z.boolean().default(true),
});

const ModelRoleSlotSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
});

const ModelsConfigSchema = z.object({
  light: ModelRoleSlotSchema.default(() => ({ provider: '', model: '' })),
});

const TokenBudgetConfigSchema = z.object({
  watermark_soft: z.number().default(0.70),
  watermark_hard: z.number().default(0.85),
  watermark_rotate: z.number().default(0.95),
  running_summary_cap_tokens: z.number().default(2000),
  subagent_startup_budget_pct: z.number().default(0.10),
});

const ToolSlaSchema = z.object({
  timeout: z.number(),
  soft_timeout: z.number().optional(),
  retries: z.number().default(0),
  sandbox: z.string().optional(),
  fallback: z.string().optional(),
});

const TelConfigSchema = z.object({
  tools: z.record(z.string(), ToolSlaSchema).default(() => ({})),
});

const EvolutionConfigSchema = z.object({
  promote_min_spawns: z.number().default(5),
  promote_min_score: z.number().default(0.8),
  archive_inactive_days: z.number().default(30),
  demote_min_tasks: z.number().default(10),
  demote_score_threshold: z.number().default(0.5),
});

const RateLimitEntrySchema = z.object({
  rpm: z.number(),
  tpm: z.number(),
  concurrent: z.number(),
});

const HttpRateLimitConfigSchema = z.object({
  /**
   * Global limit: max requests per minute across all endpoints. Generous by
   * default because MOZI is a personal single-operator app whose data-rich SPA
   * fires many reads per screen (and in Docker all requests share one bucket).
   * This is a runaway/DoS backstop, not a per-user throttle.
   */
  global_rpm: z.number().int().min(1).default(2000),
  /** Limit for /api/auth/* endpoints (e.g. /api/auth/status). */
  auth_rpm: z.number().int().min(1).default(10),
  /** Limit for /api/auth/pair — brute-force protection on pairing codes. */
  pair_rpm: z.number().int().min(1).default(5),
});

const OidcIssuerConfigSchema = z.object({
  tenant_id: z.string(),
  issuer: z.string(),
  jwks_uri: z.string().optional(),
  audience: z.string().optional(),
  tenant_claim: z.string().default('tenant_id'),
  user_claim: z.string().default('sub'),
  roles_claim: z.string().default('roles'),
});

const SamlIdpConfigSchema = z.object({
  tenant_id: z.string(),
  entity_id: z.string(),
  certificate: z.string(),
  audience: z.string().optional(),
  tenant_attribute: z.string().default('tenant_id'),
  user_attribute: z.string().default('user_id'),
  roles_attribute: z.string().default('roles'),
});

const EnterpriseAuthConfigSchema = z.object({
  oidc: z.object({
    issuers: z.array(OidcIssuerConfigSchema).default(() => []),
  }).default(() => ({ issuers: [] })),
  saml: z.object({
    idps: z.array(SamlIdpConfigSchema).default(() => []),
  }).default(() => ({ idps: [] })),
});

// #230 — OAuth2/OIDC provider configuration
const OAuthProviderConfigSchema = z.object({
  /** Provider identifier. 'custom' enables arbitrary OIDC discovery. */
  provider: z.enum(['google', 'github', 'azure_ad', 'okta', 'custom']),
  client_id: z.string(),
  client_secret: z.string(),
  /** Scopes to request. Defaults to openid + email + profile. */
  scopes: z.array(z.string()).default(() => ['openid', 'email', 'profile']),
  /** OIDC discovery URL. Required for 'custom'; auto-set for known providers. */
  discovery_url: z.string().optional(),
  /** Override the callback URL (default: derived from server.host + server.port). */
  redirect_uri: z.string().optional(),
  /** Azure AD tenant ID (required for azure_ad provider). */
  azure_tenant: z.string().optional(),
  /** Okta domain, e.g. "dev-12345.okta.com" (required for okta provider). */
  okta_domain: z.string().optional(),
});

const OAuthConfigSchema = z.object({
  providers: z.array(OAuthProviderConfigSchema).default(() => []),
});

// #234 — SAML 2.0 SP configuration
const SamlSpConfigSchema = z.object({
  /** SP entity ID (typically the app URL). */
  entity_id: z.string().default(''),
  /** Assertion Consumer Service URL. */
  acs_url: z.string().default(''),
  /** PEM-encoded SP public certificate (used in metadata). */
  certificate: z.string().default(''),
  /** PEM-encoded SP private key (for signing AuthnRequests). */
  private_key: z.string().default(''),
  /** IdP entity ID. */
  idp_entity_id: z.string().default(''),
  /** IdP SSO URL (redirect binding). */
  idp_sso_url: z.string().default(''),
  /** PEM-encoded IdP certificate (for validating assertions). */
  idp_certificate: z.string().default(''),
  /** Optional: URL to fetch IdP metadata XML. */
  idp_metadata_url: z.string().optional(),
});

const SecurityConfigSchema = z.object({
  default_permission: z.string().default('L3_FULL_ACCESS'),
  hard_gates: z.array(z.string()).default([]),
  registration: z.enum(['open', 'invite', 'closed']).default('invite'),
  /**
   * Default role for users with no explicit role assignment.
   * Omit to let MOZI auto-detect: localhost → admin (self-hosted), network-exposed → viewer.
   * Set explicitly to override the auto-detection (e.g. force viewer even on localhost).
   */
  default_role: z.enum(['admin', 'operator', 'viewer']).optional(),
  enterprise: EnterpriseAuthConfigSchema.default(() => ({
    oidc: { issuers: [] },
    saml: { idps: [] },
  })),
  /** #230 OAuth2/OIDC provider integrations */
  oauth: OAuthConfigSchema.default(() => ({ providers: [] })),
  /** #234 SAML 2.0 SP configuration */
  saml_sp: SamlSpConfigSchema.optional(),
  /**
   * Browser refresh-token lifetime in days. Sliding window: every rotation
   * (any app open within the window) extends it by this much, so active
   * users stay signed in indefinitely. Requires restart to change.
   */
  refresh_token_ttl_days: z.number().min(1).max(365).default(30),
});

const TelegramConfigSchema = z.object({
  bot_token: z.string().default(''),
  dm_policy: z.enum(['open', 'pairing', 'allowlist']).default('pairing'),
  // 0 means unlimited. Prevents Telegraf's default 90s middleware timeout.
  handler_timeout_ms: z.number().int().min(0).default(0),
  // Telegram reply streaming mode:
  // - off: final-only reply
  // - append: live stream via follow-up messages without mutating visible text
  // - edit: legacy single-message edit stream
  // - draft: native Telegram draft streaming via sendMessageDraft (Bot API 9.5+)
  //          Falls back to edit mode in groups or when draft transport fails.
  stream_mode: z.enum(['off', 'append', 'edit', 'draft']).default('draft'),
  // Minimum debounce interval for append/edit stream flushes.
  stream_edit_interval_ms: z.number().int().min(250).max(10_000).default(900),
  // When true, discard queued Telegram updates on startup to avoid backlog floods after restart.
  drop_pending_updates: z.boolean().default(true),
  // Ignore updates older than this many seconds from process startup (0 = disabled).
  ignore_stale_updates_seconds: z.number().int().min(0).default(120),
  // Hard cap for interactive Telegram turn runtime (0 = unlimited).
  // Used as a channel-level safety guard when global loop timeout is unlimited.
  interactive_turn_timeout_ms: z.number().int().min(0).default(600_000),
});

const WeChatConfigSchema = z.object({
  /** iLink Bot token obtained via QR code scan */
  bot_token: z.string().default(''),
  /** Hard cap for interactive turn runtime (0 = unlimited). */
  interactive_turn_timeout_ms: z.number().int().min(0).default(600_000),
});

const VoiceChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  stt_provider: z.string().default('builtin'),
  tts_provider: z.string().default('builtin'),
  vad_enabled: z.boolean().default(false),
  language: z.string().default('auto'),
});

const ChannelsConfigSchema = z.object({
  voice: VoiceChannelConfigSchema.default(() => ({
    enabled: false,
    stt_provider: 'builtin',
    tts_provider: 'builtin',
    vad_enabled: false,
    language: 'auto',
  })),
});

const ServerConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(9210),
  auth_token: z.string().optional(),
  auth_mode: z.enum(['token', 'none', 'oauth', 'saml', 'local']).default('token'),
});

const ContextConfigSchema = z.object({
  max_tokens: z.number().default(0),  // 0 = auto (use model's context window)
  compression_threshold: z.number().default(0.7),
});

const MemoryConfigSchema = z.object({
  write_policy: z.enum(['upsert', 'first_write_wins']).default('upsert'),
  recall_strategy: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid'),
  semantic_top_k: z.number().int().min(1).max(50).default(12),
  semantic_min_score: z.number().min(0).max(1).default(0.18),
  /** Keep small memory sets local and deterministic. External embeddings only
   * become useful after the accessible fact set reaches this size. */
  semantic_activation_threshold: z.number().int().min(1).max(100_000).default(100),
  embedding: z.object({
    provider: z.enum(['auto', 'openai', 'ollama', 'minimax', 'none']).default('auto'),
    model: z.string().optional(),
    api_key: z.string().optional(),
    base_url: z.string().optional(),
    dimensions: z.number().int().positive().optional(),
  }).default(() => ({
    provider: 'auto' as const,
  })),
});

const WorkspaceConfigSchema = z.object({
  dir: z.string().default(() => getDefaultWorkspaceDir()),
});

/**
 * Tool loop safety caps — UPPER BOUNDS.
 * The Brain suggests per-task values via task.constraints; config limits cap them.
 * 0 means unlimited (Brain fully decides).
 */
const ToolLoopsConfigSchema = z.object({
  // 0 means unlimited. Positive numbers set a hard cap.
  max_iterations: z.number().int().min(0).default(0),
  dag_max_iterations: z.number().int().min(0).default(0),
  subagent_max_iterations: z.number().int().min(0).default(0),
  // 0 means unlimited. Hard timeout for a single LLM call (chat/chatStream).
  // Does NOT affect tool execution time — only the LLM inference itself.
  // For CLI-pipe providers (claude, codex, gemini) this is the full agent turn timeout,
  // so it must be generous enough for the CLI to think + use tools + respond.
  llm_call_timeout_ms: z.number().int().min(0).default(300_000),
  // 0 means unlimited. Positive numbers cap end-to-end loop runtime per turn.
  // Checked between iterations, so a long-running tool won't be killed mid-execution.
  max_elapsed_ms: z.number().int().min(0).default(600_000),
  // Consecutive failed tool batches before injecting a failure hint (not a kill switch).
  max_failed_tool_batches: z.number().int().min(1).max(20).default(5),
  // Repeated identical tool batches before stopping a loop.
  repeated_batch_threshold: z.number().int().min(2).max(20).default(2),
  self_heal_retries: z.number().int().min(0).max(10).default(1),
  self_heal_backoff_ms: z.number().int().min(0).default(250),
});

const ToolFsConfigSchema = z.object({
  workspace_only: z.boolean().default(true),
  allow_project_root_read: z.boolean().default(true),
  additional_allowed_roots: z.array(z.string()).default(() => getDefaultAllowedRoots()),
  granted_project_roots: z.array(z.object({
    path: z.string(),
    label: z.string().default(''),
    granted_at: z.string().default(() => new Date().toISOString()),
    /** Reserved for native security-scoped bookmarks in Track B. */
    bookmark: z.string().nullable().default(null),
  }).strict()).default(() => []),
});

const BackgroundProcessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_concurrent: z.number().int().min(1).max(50).default(10),
  process_timeout_seconds: z.number().int().min(60).max(7200).default(3600),
  max_output_buffer_bytes: z.number().int().min(1024).default(10 * 1024 * 1024),
});

const ToolShellConfigSchema = z.object({
  restricted: z.boolean().default(false),
  network_isolation: z.boolean().default(false),
  executor: z.enum(['docker', 'native']).default('native'),
  docker_image: z.string().default('alpine:3.20'),
  background_processes: BackgroundProcessConfigSchema.default(() => ({
    enabled: true,
    max_concurrent: 10,
    process_timeout_seconds: 3600,
    max_output_buffer_bytes: 10 * 1024 * 1024,
  })),
});

const ToolSubagentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  enabled_tenants: z.array(z.string()).default(() => []),
  enabled_sessions: z.array(z.string()).default(() => []),
  session_capability: z.string().default('subagent_execution'),
});

const ToolNetworkConfigSchema = z.object({
  ssrf_protection: z.boolean().default(true),
  block_private_ips: z.boolean().default(true),
  block_metadata_endpoints: z.boolean().default(true),
  allowed_internal_hosts: z.array(z.string()).default(() => []),
  dns_rebinding_protection: z.boolean().default(true),
});

const ToolsConfigSchema = z.object({
  loops: ToolLoopsConfigSchema.default(() => ({
    max_iterations: 0,
    dag_max_iterations: 0,
    subagent_max_iterations: 0,
    llm_call_timeout_ms: 300000,
    max_elapsed_ms: 600000,
    max_failed_tool_batches: 5,
    repeated_batch_threshold: 2,
    self_heal_retries: 1,
    self_heal_backoff_ms: 250,
  })),
  fs: ToolFsConfigSchema.default(() => ({
    workspace_only: true,
    allow_project_root_read: true,
    additional_allowed_roots: getDefaultAllowedRoots(),
    granted_project_roots: [],
  })),
  shell: ToolShellConfigSchema.default(() => ({
    restricted: false,
    network_isolation: false,
    executor: 'native' as const,
    docker_image: 'alpine:3.20',
    background_processes: {
      enabled: true,
      max_concurrent: 10,
      process_timeout_seconds: 3600,
      max_output_buffer_bytes: 10 * 1024 * 1024,
    },
  })),
  subagents: ToolSubagentsConfigSchema.default(() => ({
    enabled: false,
    enabled_tenants: [],
    enabled_sessions: [],
    session_capability: 'subagent_execution',
  })),
  network: ToolNetworkConfigSchema.default(() => ({
    ssrf_protection: true,
    block_private_ips: true,
    block_metadata_endpoints: true,
    allowed_internal_hosts: [],
    dns_rebinding_protection: true,
  })),
});

const ReflectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  checkpoint_interval: z.number().min(1).max(20).default(3),
  force_summary_at: z.number().min(1).max(50).default(8),
});

const ModelRouterRoleSchema = z.object({
  provider: z.string(),
  model: z.string(),
  think: z.union([z.boolean(), z.enum(['low', 'medium', 'high']), z.number().int().min(1)]).optional(),
});

/** Cost sensitivity level — controls how aggressively cheaper models are preferred. */
const CostSensitivitySchema = z.enum(['low', 'medium', 'high']).default('medium');

/**
 * Routing preference for a specific lane — lets users express intent like
 * "use this model for code tasks" without editing raw role maps.
 */
const RoutingPreferenceEntrySchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
}).optional();

/**
 * Global routing preferences — user-facing layer above raw role mappings.
 *
 * Precedence: explicit request > routing_preferences > default policy > fallback
 */
const RoutingPreferencesSchema = z.object({
  /** Cost sensitivity: low = prefer quality, high = prefer cheapest viable model. */
  cost_sensitivity: CostSensitivitySchema,
  /** Preferred provider/model for code generation tasks. */
  preferred_code: RoutingPreferenceEntrySchema,
  /** Preferred provider/model for vision/UI tasks. */
  preferred_vision: RoutingPreferenceEntrySchema,
  /** Preferred cheap executor for simple/verification work. */
  preferred_cheap: RoutingPreferenceEntrySchema,
  /** Preferred model for summary/compression tasks. */
  preferred_summary: RoutingPreferenceEntrySchema,
});

const ModelRouterConfigSchema = z.object({
  brain_provider: z.string().optional(),
  fallback_brain_provider: z.string().optional(),
  roles: z.record(z.string(), ModelRouterRoleSchema).default(() => ({})),
  routing_preferences: RoutingPreferencesSchema.optional(),
});

const ModelDiscoveryConfigSchema = z.object({
  /** Provider-scoped IDs confirmed by live discovery or explicit operator entry. */
  models: z.record(z.string(), z.array(z.string())).default(() => ({})),
  /** Subset of models entered manually, retained for source labeling. */
  manual_models: z.record(z.string(), z.array(z.string())).default(() => ({})),
  /** Last successful provider fetch time for persisted cache labeling. */
  fetched_at: z.record(z.string(), z.string()).default(() => ({})),
});

/** Normalize provider override keys to lowercase (accept baseUrl, base_url, baseurl etc.) */
const ProviderOverrideSchema = z.preprocess((val) => {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(val as Record<string, unknown>)) {
    normalized[key.toLowerCase().replace(/_/g, '')] = value;
  }
  return normalized;
}, z.object({
  apikey: z.string().optional(),
  baseurl: z.string().optional(),
}).passthrough());

const MoziConfigSchema = z.object({
  system: SystemConfigSchema.default(() => ({
    max_parallel_agents: 5,
    watchdog_interval_seconds: 5,
    heartbeat_timeout_seconds: 15,
  })),
  brain: BrainConfigSchema.default(() => ({
    model: '',
    fallback_model: '',
    max_dag_depth: 5,
    max_plan_steps: 12,
    dag_execution_mode: 'background' as const,
    resume_plans_on_boot: true,
  })),
  models: ModelsConfigSchema.default(() => ({
    light: { provider: '', model: '' },
  })),
  token_budget: TokenBudgetConfigSchema.default(() => ({
    watermark_soft: 0.70,
    watermark_hard: 0.85,
    watermark_rotate: 0.95,
    running_summary_cap_tokens: 2000,
    subagent_startup_budget_pct: 0.10,
  })),
  tel: TelConfigSchema.default(() => ({
    tools: {},
  })),
  evolution: EvolutionConfigSchema.default(() => ({
    promote_min_spawns: 5,
    promote_min_score: 0.8,
    archive_inactive_days: 30,
    demote_min_tasks: 10,
    demote_score_threshold: 0.5,
  })),
  rate_limits: z.record(z.string(), RateLimitEntrySchema).default(() => ({})),
  http_rate_limit: HttpRateLimitConfigSchema.default(() => ({
    global_rpm: 2000,
    auth_rpm: 10,
    pair_rpm: 5,
  })),
  security: SecurityConfigSchema.default(() => ({
    default_permission: 'L3_FULL_ACCESS',
    hard_gates: [],
    enterprise: {
      oidc: { issuers: [] },
      saml: { idps: [] },
    },
    oauth: { providers: [] },
    registration: 'invite' as const,
    refresh_token_ttl_days: 30,
  })),
  telegram: TelegramConfigSchema.default(() => ({
    bot_token: '',
    dm_policy: 'pairing' as const,
    handler_timeout_ms: 0,
    stream_mode: 'draft' as const,
    stream_edit_interval_ms: 900,
    drop_pending_updates: true,
    ignore_stale_updates_seconds: 120,
    interactive_turn_timeout_ms: 600_000,
  })),
  wechat: WeChatConfigSchema.default(() => ({
    bot_token: '',
    interactive_turn_timeout_ms: 600_000,
  })),
  channels: ChannelsConfigSchema.default(() => ({
    voice: {
      enabled: false,
      stt_provider: 'builtin',
      tts_provider: 'builtin',
      vad_enabled: false,
      language: 'auto',
    },
  })),
  server: ServerConfigSchema.default(() => ({
    host: '127.0.0.1',
    port: 9210,
    auth_mode: 'token' as const,
  })),
  context: ContextConfigSchema.default(() => ({
    max_tokens: 0,
    compression_threshold: 0.7,
  })),
  memory: MemoryConfigSchema.default(() => ({
    write_policy: 'upsert' as const,
    recall_strategy: 'hybrid' as const,
    semantic_top_k: 12,
    semantic_min_score: 0.18,
    semantic_activation_threshold: 100,
    embedding: {
      provider: 'auto' as const,
    },
  })),
  workspace: WorkspaceConfigSchema.default(() => ({
    dir: getDefaultWorkspaceDir(),
  })),
  tools: ToolsConfigSchema.default(() => ({
    loops: {
      max_iterations: 0,
      dag_max_iterations: 0,
      subagent_max_iterations: 0,
      llm_call_timeout_ms: 300000,
      max_elapsed_ms: 600000,
      max_failed_tool_batches: 5,
      repeated_batch_threshold: 2,
      self_heal_retries: 1,
      self_heal_backoff_ms: 250,
    },
    fs: {
      workspace_only: true,
      allow_project_root_read: true,
      additional_allowed_roots: getDefaultAllowedRoots(),
      granted_project_roots: [],
    },
    shell: {
      restricted: false,
      network_isolation: false,
      executor: 'native' as const,
      docker_image: 'alpine:3.20',
      background_processes: {
        enabled: true,
        max_concurrent: 10,
        process_timeout_seconds: 3600,
        max_output_buffer_bytes: 10 * 1024 * 1024,
      },
    },
    subagents: {
      enabled: true,
      enabled_tenants: [],
      enabled_sessions: [],
      session_capability: 'subagent_execution',
    },
    network: {
      ssrf_protection: true,
      block_private_ips: true,
      block_metadata_endpoints: true,
      allowed_internal_hosts: [],
      dns_rebinding_protection: true,
    },
  })),
  reflection: ReflectionConfigSchema.default(() => ({
    enabled: true,
    checkpoint_interval: 3,
    force_summary_at: 8,
  })),
  model_router: ModelRouterConfigSchema.optional(),
  model_discovery: ModelDiscoveryConfigSchema.optional(),
  coding_worker: z.object({
    routing: z.enum(['auto', 'claude_code', 'codex_cli']).default('auto'),
    available: z.array(z.enum(['claude_code', 'codex_cli'])).default([]),
  }).optional(),
  providers: z.record(z.string(), ProviderOverrideSchema).default(() => ({})),
  mcp: MCPConfigSchema.default(() => ({ servers: {} })),
});

/** Fully validated MOZI configuration object. */
export type MoziConfig = z.infer<typeof MoziConfigSchema>;
export type OAuthProviderConfig = z.infer<typeof OAuthProviderConfigSchema>;
export type SamlSpConfig = z.infer<typeof SamlSpConfigSchema>;

// ---------------------------------------------------------------------------
// Hot-updatable key prefixes (changes take effect without restart)
// ---------------------------------------------------------------------------

const HOT_UPDATABLE_PREFIXES = [
  'system',
  'token_budget',
  'evolution',
  'rate_limits',
  'http_rate_limit',
  'context',
  'memory',
  'tools',
  'telegram',
  'wechat',
  'models',
  'reflection',
] as const;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let currentConfig: MoziConfig | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load configuration from disk, apply environment variable overrides,
 * and validate everything through the Zod schema.
 *
 * Canonical config is `~/.mozi/mozi.json`.
 * Legacy `~/.mozi/config.yaml` is still readable for backward compatibility.
 * If no config file exists, all defaults are used.
 *
 * @param configPath - explicit config path (defaults to canonical `mozi.json`)
 * @returns the validated MoziConfig
 */
export function loadConfig(configPath = getConfigPath()): MoziConfig {
  const { config: loadedConfig } = readConfigWithLegacyFallback(configPath);
  const rawConfig: Record<string, unknown> = { ...loadedConfig };

  // `gemini_cli` was historically admitted despite having no managed-worker
  // adapter. Normalize old files before validation so startup remains safe and
  // the runtime never advertises an unavailable worker.
  const rawCodingWorker = rawConfig.coding_worker;
  if (rawCodingWorker && typeof rawCodingWorker === 'object' && !Array.isArray(rawCodingWorker)) {
    const worker = rawCodingWorker as Record<string, unknown>;
    const available = worker.available;
    const removedGemini = (Array.isArray(available) && available.includes('gemini_cli'))
      || worker.routing === 'gemini_cli';
    // Migrate only the one historically admitted value. Preserve every other
    // shape/value so Zod still rejects typos and malformed configuration.
    if (Array.isArray(available) && available.includes('gemini_cli')) {
      worker.available = available.filter((id) => id !== 'gemini_cli');
    }
    if (worker.routing === 'gemini_cli') worker.routing = 'auto';
    if (removedGemini) {
      // eslint-disable-next-line no-console
      console.warn('[MOZI CONFIG WARNING] coding_worker gemini_cli is unsupported and was removed; configure claude_code or codex_cli instead.');
    }
  }

  // Apply environment variable overrides (MOZI_ prefix)
  applyEnvOverrides(rawConfig);
  const rawServer = rawConfig.server;
  if (rawServer && typeof rawServer === 'object' && !Array.isArray(rawServer)) {
    const registration = (rawServer as Record<string, unknown>).registration;
    if (typeof registration === 'string' && registration.trim().length > 0) {
      if (!rawConfig.security) rawConfig.security = {};
      (rawConfig.security as Record<string, unknown>).registration = registration.trim();
    }
  }

  // Resolve ${VAR} placeholders in providers config values
  if (rawConfig.providers && typeof rawConfig.providers === 'object' && !Array.isArray(rawConfig.providers)) {
    const providers = rawConfig.providers as Record<string, unknown>;
    for (const [id, entry] of Object.entries(providers)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        providers[id] = resolveEnvPlaceholdersDeep(entry as Record<string, unknown>);
      }
    }
  }

  // Bridge well-known env vars into config when not set in YAML
  if (rawConfig.telegram && typeof rawConfig.telegram === 'object' && !Array.isArray(rawConfig.telegram)) {
    const tg = rawConfig.telegram as Record<string, unknown>;
    // OpenClaw-style alias compatibility.
    if (!tg.stream_mode && typeof tg.streamMode === 'string') {
      tg.stream_mode = tg.streamMode;
    }
    // Legacy `partial` semantics mutated a visible message. Keep compatibility,
    // but upgrade old configs to the safer append-only mode by default.
    if (tg.stream_mode === 'partial') {
      tg.stream_mode = 'append';
    }
    if (!tg.stream_edit_interval_ms && typeof tg.streamEditIntervalMs === 'number') {
      tg.stream_edit_interval_ms = tg.streamEditIntervalMs;
    }
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    if (!rawConfig.telegram) rawConfig.telegram = {};
    const tg = rawConfig.telegram as Record<string, unknown>;
    if (!tg.bot_token) tg.bot_token = process.env.TELEGRAM_BOT_TOKEN;
  }

  // Bridge WeChat env vars into config when not set in config file
  if (process.env.WECHAT_BOT_TOKEN) {
    if (!rawConfig.wechat) rawConfig.wechat = {};
    const wc = rawConfig.wechat as Record<string, unknown>;
    if (!wc.bot_token) wc.bot_token = process.env.WECHAT_BOT_TOKEN;
  }

  // Bridge Google OAuth env vars into config when not set in config file
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    if (!rawConfig.security) rawConfig.security = {};
    const sec = rawConfig.security as Record<string, unknown>;
    if (!sec.oauth) sec.oauth = {};
    const oauth = sec.oauth as Record<string, unknown>;
    if (!oauth.providers) oauth.providers = [];
    const providers = oauth.providers as Array<Record<string, unknown>>;
    if (!providers.some(p => p.provider === 'google')) {
      providers.push({
        provider: 'google',
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
      });
    }
  }

  currentConfig = MoziConfigSchema.parse(rawConfig);
  return currentConfig;
}

/**
 * Return the current configuration. If no config has been loaded yet,
 * {@link loadConfig} is called with defaults.
 */
export function getConfig(): MoziConfig {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

/**
 * Hot-update a single configuration value at runtime.
 *
 * Only keys under hot-updatable prefixes (`system`, `token_budget`,
 * `evolution`, `rate_limits`) are allowed. Attempting to update a
 * non-hot-updatable key (e.g. `brain.model`, `security.*`) throws an error.
 *
 * @param path  - dot-separated config path, e.g. `system.max_parallel_agents`
 * @param value - the new value to set
 * @throws if the key is not hot-updatable or the path does not exist
 */
export function updateConfig(path: string, value: unknown): void {
  const topLevel = path.split('.')[0];
  if (!HOT_UPDATABLE_PREFIXES.includes(topLevel as (typeof HOT_UPDATABLE_PREFIXES)[number])) {
    throw new Error(
      `Config key "${path}" is not hot-updatable. Restart required.`,
    );
  }

  if (!currentConfig) {
    loadConfig();
  }

  const keys = path.split('.');
  const nextConfig = structuredClone(currentConfig) as Record<string, unknown>;
  let target: Record<string, unknown> = nextConfig;

  for (let i = 0; i < keys.length - 1; i++) {
    const next = target[keys[i]];
    if (!next || typeof next !== 'object') {
      throw new Error(`Config path "${path}" not found.`);
    }
    target = next as Record<string, unknown>;
  }

  const leaf = keys[keys.length - 1];
  if (!(leaf in target)) {
    throw new Error(`Config path "${path}" not found.`);
  }

  target[leaf] = coerceScalarValue(value);
  currentConfig = MoziConfigSchema.parse(nextConfig);
}

// ---------------------------------------------------------------------------
// Re-export the schema so other modules can reference it if needed
// ---------------------------------------------------------------------------

export { MoziConfigSchema };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk all `MOZI_*` environment variables and apply them as overrides to the
 * raw config object before Zod validation.
 *
 * Naming convention: `MOZI_<SECTION>_<KEY>` maps to `<section>.<key>`.
 * The first segment after `MOZI_` is the config section; the remaining
 * segments are joined with `_` to form the key within that section.
 *
 * Numeric strings are automatically coerced to numbers.
 */
function applyEnvOverrides(config: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('MOZI_') || !value) continue;

    // MOZI_BRAIN_MODEL -> ['brain', 'model']
    const parts = key.slice(5).toLowerCase().split('_');

    if (parts.length >= 2) {
      const section = parts[0];
      const rest = parts.slice(1).join('_');

      if (!config[section]) {
        config[section] = {};
      }
      const sectionObj = config[section] as Record<string, unknown>;

      // Coerce to number when possible
      const numValue = Number(value);
      sectionObj[rest] = isNaN(numValue) ? value : numValue;
    }
  }
}

/**
 * Resolve `${VAR}` placeholders in a string using process.env.
 * Returns the original string if the env var is not set.
 */
function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName.trim()];
    return envValue ?? '';
  });
}

/**
 * Deep-resolve `${VAR}` placeholders in all string values of a config object.
 */
function resolveEnvPlaceholdersDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = resolveEnvPlaceholders(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = resolveEnvPlaceholdersDeep(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function coerceScalarValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : value;
}
