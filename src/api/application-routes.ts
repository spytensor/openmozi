/**
 * REST API route registrations for Fastify.
 *
 * Extracted from index.ts to reduce file size. All routes are registered
 * via `registerApiRoutes()` which receives the Fastify app and dependencies.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import pino from 'pino';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { getBuildInfo } from '../runtime/build-info.js';
import { deleteSessionMessage, getAccessibleChatIdsForUser, getHistory, getSessionHistory } from '../memory/conversations.js';
import { deleteTimelineForSessionMessage, findFileArtifactSourceCandidates, getSessionTimelinePage } from '../memory/session-timeline.js';
import { getSessionTurns } from '../memory/turn-envelopes.js';
import { getLatestContextCheckpoint } from '../memory/context-checkpoints.js';
import {
  archiveSession,
  archiveUnusedDraftSessions,
  createSession,
  getReusableDraftSession,
  getSession,
  listSessions,
  countSessions,
  getSessionPermissionLevel,
  updateTitle,
  updateSessionWorkspaceContext,
  bindDraftSessionProject,
} from '../memory/sessions.js';
import type { WorkspaceMessageContext } from '../channels/telegram.js';
import { hasAnyPairedUsers, getAllowedUsers, isAllowed, validatePairingToken, addAllowedUser, createPairingToken } from '../security/pairing.js';
import { sign as jwtSign, verify as jwtVerify, revokeToken } from '../security/jwt.js';
import { authenticate as authenticateApi } from '../security/enterprise-auth.js';
import { AUTH_COOKIE_NAME, extractApiCredential, hasApiRole, isPublicApiRoute, requiredRoleForApiRoute } from '../security/api-auth.js';
import { assignRole, resolveRole, type Role } from '../security/rbac.js';
import {
  getSystemOverview,
  getTaskHistory,
  getCostSummary,
  getSloSummary,
  listObservedModels,
} from '../observer/dashboard.js';
import { getTenantUsage, getUsageAnalytics, type UsageAnalyticsFilters } from '../tenants/billing.js';
import { refreshPricingAndReprice } from '../tenants/billing-reconciliation.js';
import { getQuota, setQuota } from '../tenants/quotas.js';
import { exportAuditLog } from '../tenants/audit.js';
import { pushEvent, wake as wakeProactiveEngine } from '../core/proactive-engine.js';
import { registerConfigRoutes } from '../config/api.js';
import { logAudit, queryAuditLog, type AuditQueryFilters } from '../security/audit.js';
// Phase 2 imports
import { initiateOAuthFlow, handleOAuthCallback } from '../security/oauth.js';
// Phase 3 imports
import {
  getTenantConfig,
  setTenantConfig,
  deleteTenantConfig,
  listTenantOverrides,
} from '../config/tenant-config.js';
import {
  upsertTenantApiKey,
  getTenantApiKey as _getTenantApiKey,
  listTenantApiKeys,
  deleteTenantApiKey,
} from '../security/tenant-keys.js';
import {
  getQuotaStatus,
  setQuotaLimit,
} from '../security/quota.js';
import {
  canBootstrapLocalAdmin,
  createLocalUser,
  DuplicateUserError,
  ensureLocalUser,
  findOrCreateUser,
  getUserAuthByEmail,
  getUserAuthById,
  getUserByEmail,
  getUserById,
  updateUser,
  updateUserPasswordHash,
  updateUserRoleColumn,
  updateUserAllowedModels,
  updateUserStatus,
  markUserLogin,
  listUsers,
  deleteUser,
  LOCAL_USER_ID,
} from '../security/users.js';
import {
  getActiveRefreshToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  REFRESH_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type TokenPair,
} from '../security/refresh-token.js';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../security/password.js';
import {
  getOnboardingStatus,
  completeOnboarding,
  getUserPreferences,
  setUserPreference,
  deleteUserPreference,
} from '../security/onboarding.js';
import {
  generateSpMetadata,
  generateAuthnRequestUrl,
  validateSamlResponse,
  fetchIdpMetadata,
  hashAssertion,
} from '../security/saml.js';
import {
  buildRuntimeWorkspaceSnapshot,
  readRuntimeLogSnapshot,
} from '../runtime/workspace-snapshot.js';
import { buildDesktopCapabilitySnapshot } from '../runtime/desktop-capabilities.js';
import {
  getServiceStatus,
  installService,
  uninstallService,
  type ServiceInstallResult,
  type ServiceStatusResult,
  type ServiceUninstallResult,
} from '../runtime/service-install.js';
import { getConfigPath, getMoziHome } from '../paths.js';
import { getAllProviders, getProvider, getModel, resolveRuntimeModel, resolveApiKey, resolveBaseUrl, isChatRoleEligibleProvider, getChatRoleEligibleProviders, type ProviderDef, type ModelDef } from '../core/providers.js';
import { clearCache as clearModelRouterCache } from '../core/model-router.js';
import { enrich, type EnrichedModelMetadata } from '../core/model-registry-enrichment.js';
import { discoverProviderModels, isSafeCustomModelId, type ModelDiscoveryResult } from '../core/model-discovery.js';
import { assertModelAllowed, resolveAllowedModels, ModelNotAllowedError } from '../security/entitlements.js';
import { resolveRuntimeApiKey } from '../core/runtime-provider-keys.js';
import { readConfigWithLegacyFallback, writeConfigObject } from '../config/storage.js';
import { loadConfig, getConfig } from '../config/index.js';
import {
  discoverCodexCliModels,
  detectCodingWorkers,
  type CodingWorkerId,
  type CodingWorkerProbe,
} from '../onboarding/coding-workers.js';
import { getDefaultWorkerAdapterRegistry } from '../workers/index.js';
import { inspectWorkerAdapterLaneReadiness } from '../workers/preflight.js';
import { resetMemoryEmbeddingProviderCache } from '../memory/embedding-provider.js';
import { generateMasterKey, resolveMasterKey, resolveTenantMasterSecret, setSecret, getSecret, deleteSecret } from '../security/secrets.js';
import {
  SERVICE_PROVIDERS,
  SEARCH_PROVIDERS,
  getServiceProvider,
  resolveActiveSearchProvider,
} from '../core/service-providers.js';
import { PERMISSION_LEVELS } from '../security/permissions.js';
import { applySessionPermissionLevel } from '../security/session-permissions.js';
import { grantProjectRoot, listFsRoots, revokeProjectRoot } from '../tools/fs-root-grants.js';
import {
  ensureToolWorkspaceDir,
  getOutputDir,
  getWorkspaceAllowedRoots,
  isPathInsideRoot,
  resolvePersistedRuntimePath,
} from '../tools/workspace-policy.js';
import { classifyFileArtifactKind, mimeForFilePath } from '../artifacts/file-artifacts.js';
import { deliverableRegistry } from '../store/deliverables.js';
import { deliverableVersionStore } from '../store/deliverable-versions.js';
import { sessionDeliverableBindingStore } from '../store/session-deliverable-bindings.js';
import { getDb } from '../store/db.js';
import { registerOfficeRoutes } from '../api/office-routes.js';
import { registerGitBranchRoutes } from '../api/git-branch-routes.js';
import { registerMemoryRoutes } from '../api/memory-routes.js';
import { registerSchedulerRoutes } from '../api/scheduler-routes.js';
import { registerTaskTemplateRoutes } from '../api/task-template-routes.js';
import {
  canRunQuickLookPreviews,
  DEFAULT_FILE_PREVIEW_WIDTH,
  generateFilePreviewPng,
  isQuickLookPreviewExtension,
  MAX_FILE_PREVIEW_WIDTH,
  MIN_FILE_PREVIEW_WIDTH,
} from '../artifacts/file-preview.js';

const logger = pino({ name: 'mozi:api-routes' });
const WEB_AUTH_TTL_SECONDS = 86400 * 30;
const LOCAL_TENANT_ID = 'default';
const execFileAsync = promisify(execFile);
type ApiTenantContext = { tenant_id: string; user_id: string; roles: string[] };
const LOCAL_AUTH_CONTEXT = {
  tenant_id: LOCAL_TENANT_ID,
  user_id: LOCAL_USER_ID,
  roles: ['admin'],
};

/**
 * Does this token's subject still resolve to a live identity?
 *
 * A JWT proves we signed it, not that whoever it names still exists. Deleting an
 * account — or resetting the database while the signing secret survives — leaves
 * a token that verifies perfectly and names nobody, so every entry point must
 * re-resolve the subject rather than trust the signature alone.
 *
 * Two identity stores are legitimate: `users` (web accounts) and `allowed_users`
 * (channel pairings, which carry `legacy_pairing` tokens and have no `users`
 * row). Absence from BOTH is what makes a subject gone; checking only `users`
 * would lock out every paired Telegram/Discord operator.
 */
function subjectStillExists(userId: string, tenantId: string): boolean {
  return Boolean(getUserById(userId, tenantId)) || isAllowed(userId, tenantId);
}

const PermissionLevelBodySchema = z.object({
  permission_level: z.enum(PERMISSION_LEVELS),
}).strict();

const CodingWorkerConfigBodySchema = z.object({
  routing: z.enum(['auto', 'claude_code', 'codex_cli']),
  available: z.array(z.enum(['claude_code', 'codex_cli'])),
}).strict().superRefine((value, ctx) => {
  if (value.routing !== 'auto' && !value.available.includes(value.routing)) {
    ctx.addIssue({ code: 'custom', path: ['routing'], message: 'A specific routing worker must also be activated' });
  }
});

const ChatModelRoleBodySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
}).strict();

const OPENAI_EMBEDDING_MODELS = new Set(['text-embedding-3-small', 'text-embedding-3-large']);
const EmbeddingModelRoleBodySchema = z.object({
  provider: z.enum(['auto', 'openai', 'ollama', 'none']),
  model: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.provider === 'openai' && (!value.model || !OPENAI_EMBEDDING_MODELS.has(value.model))) {
    ctx.addIssue({ code: 'custom', path: ['model'], message: 'OpenAI memory search requires a supported embedding model' });
  }
  if (value.provider === 'ollama' && !value.model?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['model'], message: 'Ollama memory search requires an embedding model' });
  }
});

const ModelRolesPatchBodySchema = z.object({
  brain: ChatModelRoleBodySchema.optional(),
  light: ChatModelRoleBodySchema.optional(),
  step: ChatModelRoleBodySchema.nullable().optional(),
  plan_summary: ChatModelRoleBodySchema.nullable().optional(),
  embedding: EmbeddingModelRoleBodySchema.optional(),
}).strict().refine(
  (body) => body.brain !== undefined || body.light !== undefined || body.step !== undefined
    || body.plan_summary !== undefined || body.embedding !== undefined,
  'At least one role must be provided',
);

const FsRootPathBodySchema = z.object({
  path: z.string().min(1),
}).strict();

const FsMkdirBodySchema = z.object({
  dir: z.string().min(1),
  name: z.string().min(1).max(255),
}).strict();

const FsMoveBodySchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(200),
  destDir: z.string().min(1),
}).strict();

const FsRevealBodySchema = z.object({
  path: z.string().min(1),
}).strict();

const FsSourceQuerySchema = z.object({
  path: z.string().min(1),
}).strict();

const FsFileQuerySchema = z.object({
  path: z.string().min(1),
  // inline=1 renders in-browser (image/pdf/text preview) instead of forcing a
  // download. QuickLook previews are macOS-only, so browser-inline is the
  // cross-platform way to preview an uploaded attachment.
  inline: z.coerce.boolean().optional(),
}).strict();

const FsPreviewQuerySchema = z.object({
  path: z.string().min(1),
  w: z.coerce.number().int().min(MIN_FILE_PREVIEW_WIDTH).max(MAX_FILE_PREVIEW_WIDTH).optional(),
}).strict();

const FsOfficePdfQuerySchema = z.object({
  path: z.string().min(1),
}).strict();

const DeliverableRollbackBodySchema = z.object({
  version: z.number().int().positive(),
}).strict();

const RoleSchema = z.enum(['admin', 'operator', 'viewer']);

const LocalRegisterBodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(160).optional(),
  invite_code: z.string().trim().min(1).max(256).optional(),
}).strict();

const LocalLoginBodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
}).strict();

const PasswordChangeBodySchema = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: z.string().min(1).max(1024),
}).strict();

const AdminCreateUserBodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024).optional(),
  name: z.string().trim().min(1).max(160),
  role: RoleSchema,
}).strict();

const AdminPatchUserBodySchema = z.object({
  role: RoleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  new_password: z.string().min(1).max(1024).optional(),
  allowed_models: z.array(z.string().trim().min(1)).nullable().optional(),
}).strict().refine(
  (body) => body.role !== undefined
    || body.status !== undefined
    || body.new_password !== undefined
    || body.allowed_models !== undefined,
  'At least one user update must be provided',
);

const TenantQuotaUpdateBodySchema = z.object({
  daily_token_limit: z.number().int().nonnegative().optional(),
  monthly_token_limit: z.number().int().nonnegative().optional(),
  max_tokens_per_task: z.number().int().nonnegative().optional(),
  max_parallel_agents: z.number().int().positive().optional(),
  max_active_tasks: z.number().int().positive().optional(),
  max_storage_mb: z.number().int().positive().optional(),
  max_skills: z.number().int().positive().optional(),
  allowed_models: z.array(z.string().trim().min(1)).nullable().optional(),
  brain_model: z.string().optional(),
}).strict();

const InviteCreateBodySchema = z.object({
  role: RoleSchema,
  expires_minutes: z.number().int().min(1).max(10080).optional(),
}).strict();

const AuditExportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
  action: z.string().trim().min(1).optional(),
  user_id: z.string().trim().min(1).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
}).strict();

const SkillContentUpdateBodySchema = z.object({
  content: z.string().min(1),
}).strict();

const SkillStateBodySchema = z.object({
  enabled: z.boolean(),
}).strict();

const DUMMY_PASSWORD_HASH = 'scrypt$16384$8$1$bW96aS1sb2NhbC1hdXRoIQ==$9mWZenXdqdUZEQy5lVqu2rUOf7JtDazXO9DU+m3QgsV81SZlvsZC9/TT1STf6TeVQKiWBIAWqy9dOdlZPGVbMA==';

type ModelRoleSlot = {
  provider: string;
  model: string;
  ready: boolean;
  eligible: boolean;
  inherit?: boolean;
  configured?: {
    provider: string;
    model: string;
    eligible: false;
    reason: string;
  };
};
type RawConfigRecord = Record<string, unknown>;

function rfc5987Encode(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function asciiFallbackFilename(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/[\\"]/g, '_')
    .trim();
  return fallback || 'download';
}

function contentDispositionAttachment(filename: string): string {
  const fallback = asciiFallbackFilename(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveAllowedFsFile(inputPath: string, userId?: string | null): { path: string; stats: Stats } | null {
  const trimmed = inputPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;

  const allowedRoots = allowedFsRootsForUser(userId);
  const compatibilityCandidate = resolvePersistedRuntimePath(trimmed, userId);
  const candidates = [...new Set([resolve(trimmed), compatibilityCandidate].filter((path): path is string => Boolean(path)))];
  for (const candidate of candidates) {
    const realTarget = realpathOrNull(candidate);
    if (!realTarget) continue;
    let stats: Stats;
    try {
      stats = statSync(realTarget);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (!allowedRoots.some((root) => isPathInsideRoot(realTarget, root))) continue;
    return { path: realTarget, stats };
  }
  return null;
}

const STORED_UPLOAD_PREFIX_RE = /^[0-9]{10,}-[0-9a-f]{6,}-/;

function displayNameForFsEntry(name: string): string {
  const displayName = name.replace(STORED_UPLOAD_PREFIX_RE, '');
  return displayName || name;
}

function sanitizeFsSegment(input: string): string {
  return input
    .replace(/\0/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[<>:"|?*]/g, '_')
    .slice(0, 180);
}

function validateFsSegment(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed === '.' || trimmed.includes('..') || /[\\/]/.test(trimmed)) {
    return null;
  }
  const safe = sanitizeFsSegment(trimmed);
  if (!safe || safe === '.' || safe.includes('..') || /[\\/]/.test(safe)) return null;
  return safe;
}

function allowedFsRootsForUser(userId?: string | null): string[] {
  const roots = getWorkspaceAllowedRoots(userId).flatMap((root) => {
    const resolved = resolve(root);
    const real = realpathOrNull(root);
    return real && real !== resolved ? [resolved, real] : [resolved];
  });
  return [...new Set(roots)];
}

function isPathAllowedForRoots(targetPath: string, allowedRoots: string[]): boolean {
  const resolvedTarget = resolve(targetPath);
  return allowedRoots.some((root) => isPathInsideRoot(resolvedTarget, root));
}

/**
 * `output/` is MOZI's generated-deliverable directory, not an upload inbox.
 * Check both the configured path and its real path so a symlinked MOZI home
 * cannot bypass that product boundary.
 */
function isGeneratedOutputPath(targetPath: string): boolean {
  const outputDir = resolve(getOutputDir());
  const realOutputDir = realpathOrNull(outputDir);
  const resolvedTarget = resolve(targetPath);
  return isPathInsideRoot(resolvedTarget, outputDir)
    || Boolean(realOutputDir && isPathInsideRoot(resolvedTarget, realOutputDir));
}

function resolveAllowedFsPath(
  inputPath: string,
  userId: string,
  allowedRoots = allowedFsRootsForUser(userId),
): { path: string; stats: Stats } | null {
  const trimmed = inputPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  const realTarget = realpathOrNull(resolve(trimmed));
  if (!realTarget || !isPathAllowedForRoots(realTarget, allowedRoots)) return null;
  try {
    return { path: realTarget, stats: statSync(realTarget) };
  } catch {
    return null;
  }
}

function resolveAllowedFsDir(
  inputPath: string,
  userId: string,
  allowedRoots = allowedFsRootsForUser(userId),
): string | null {
  const resolved = resolveAllowedFsPath(inputPath, userId, allowedRoots);
  return resolved?.stats.isDirectory() ? resolved.path : null;
}

export function revealCommandForPlatform(
  platform: NodeJS.Platform,
  targetPath: string,
  isDirectory: boolean,
): { command: string; args: string[]; revealed: 'file' | 'folder' } {
  if (platform === 'darwin') return { command: 'open', args: ['-R', targetPath], revealed: isDirectory ? 'folder' : 'file' };
  const folder = isDirectory ? targetPath : dirname(targetPath);
  if (platform === 'win32') return { command: 'explorer.exe', args: isDirectory ? [folder] : ['/select,', targetPath], revealed: 'folder' };
  return { command: 'xdg-open', args: [folder], revealed: 'folder' };
}

function skillManagerErrorResponse(reply: FastifyReply, err: unknown): FastifyReply {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : '';
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'skill_not_found') {
    return reply.code(404).send({ success: false, error: message || 'Skill not found' });
  }
  if (code === 'skill_read_only') {
    return reply.code(403).send({ success: false, error: message || 'Bundled skills are read-only' });
  }
  if (code === 'skill_invalid_id' || code === 'skill_path_rejected' || code === 'skill_invalid_content') {
    return reply.code(400).send({ success: false, error: message || 'Invalid skill request' });
  }

  logger.warn({ error: message }, 'Skill management request failed');
  return reply.code(500).send({ success: false, error: 'Skill management request failed' });
}

function withSkillStatus<T extends { enabled: boolean }>(skill: T): T & { status: 'active' | 'disabled' } {
  return {
    ...skill,
    status: skill.enabled ? 'active' : 'disabled',
  };
}

export interface ApiRoutesConfig {
  server: { host?: string; port?: number; auth_token?: string; auth_mode?: string };
  security: {
    enterprise: unknown;
    registration?: 'open' | 'invite' | 'closed';
    oauth?: { providers: Array<{ provider?: unknown }> };
    saml_sp?: unknown;
    refresh_token_ttl_days?: number;
  };
  http_rate_limit?: { global_rpm: number; auth_rpm: number; pair_rpm: number };
  upload?: { max_bytes?: number };
}

const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAX_BYTES_ENV = 'MOZI_UPLOAD_MAX_BYTES';
// The line the whitelist draws (operator decision 2026-07-18): anything that is
// DATA for the Brain to read — documents, datasets, archives, web pages, source
// code, configs, notebooks — is accepted. What stays out is native executable
// material (exe/dll/dmg/pkg/app/msi/so/dylib): MOZI never needs the user to
// hand it a binary to run, and a chat surface must not become a side-load path.
// text/* is accepted wholesale (every code/markup/config format browsers can
// name), so the MIME set below only enumerates non-text families.
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/xhtml+xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-ipynb+json',
  'application/sql',
  'application/x-sh',
  'application/x-python-code',
  'application/msword',
  'application/pdf',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/epub+zip',
  // Archives — datasets routinely arrive zipped (the UCI starter downloads a
  // .zip itself); the Brain extracts them in the workspace sandbox.
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-bzip2',
  'application/x-xz',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  // Columnar/data-science binary formats.
  'application/x-parquet',
  'application/vnd.apache.parquet',
  'application/vnd.sqlite3',
  'application/x-sqlite3',
]);
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  // Images (fallback when the browser reports octet-stream).
  '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.webp',
  // Documents.
  '.doc', '.docx', '.epub', '.md', '.odg', '.odp', '.ods', '.odt',
  '.pdf', '.ppt', '.pptx', '.rtf', '.txt',
  // Data.
  '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.parquet', '.feather',
  '.xls', '.xlsx', '.sqlite', '.sqlite3', '.db', '.arrow',
  // Archives.
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.txz', '.7z', '.rar',
  // Web & markup.
  '.html', '.htm', '.xhtml', '.css', '.scss', '.less', '.xml', '.svelte', '.vue',
  // Code — read as text, never executed by the upload path.
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.ipynb', '.java',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  '.swift', '.kt', '.kts', '.scala', '.lua', '.pl', '.r', '.jl', '.dart',
  '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.proto', '.graphql',
  // Config & logs.
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
  '.log', '.lock', '.editorconfig', '.gitignore', '.dockerfile',
]);
// Every Office format LibreOffice can print to PDF. xlsx/docx were missing
// for months while the conversion route sat here fully built — users got a
// flat SheetJS grid (no sheets, no styles) and approximate mammoth HTML
// instead of native-fidelity rendering.
const OFFICE_PDF_EXTENSIONS = new Set(['pptx', 'ppt', 'odp', 'odt', 'ods', 'xlsx', 'xls', 'docx', 'doc', 'rtf']);
const OFFICE_PDF_CACHE_DIR = resolve(tmpdir(), 'mozi-office-pdf');

interface UploadedFileResponse {
  filename: string;
  path: string;
  size: number;
  mimeType: string;
}

class UploadValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function resolveUploadMaxBytes(config: ApiRoutesConfig): number {
  const configured = config.upload?.max_bytes;
  if (Number.isFinite(configured) && configured && configured > 0) {
    return Math.floor(configured);
  }

  const envValue = Number(process.env[UPLOAD_MAX_BYTES_ENV]);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.floor(envValue);
  }

  return DEFAULT_UPLOAD_MAX_BYTES;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Preserve a human-readable Unicode basename while removing filesystem-unsafe characters. */
export function sanitizeUploadFilename(filename: string): string {
  const base = basename(filename.replace(/\\/g, '/'))
    .normalize('NFC')
    .replace(/[\0-\x1F\x7F]/g, '')
    .trim();
  const safe = base
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!safe) return 'upload.bin';
  if (Buffer.byteLength(safe, 'utf8') <= 180) return safe;

  const dotIndex = safe.lastIndexOf('.');
  const extension = dotIndex > 0 ? safe.slice(dotIndex) : '';
  const stem = extension ? safe.slice(0, dotIndex) : safe;
  const extensionBytes = Buffer.byteLength(extension, 'utf8');
  if (extensionBytes >= 180) return truncateUtf8(safe, 180) || 'upload.bin';
  const stemBudget = Math.max(1, 180 - extensionBytes);
  const truncatedStem = truncateUtf8(stem, stemBudget);
  return `${truncatedStem}${extension}` || 'upload.bin';
}

function uploadExtension(filename: string): string {
  const safe = sanitizeUploadFilename(filename);
  const dotIdx = safe.lastIndexOf('.');
  return dotIdx >= 0 ? safe.slice(dotIdx).toLowerCase() : '';
}

function fileExtension(filename: string): string {
  const name = basename(filename);
  const dotIdx = name.lastIndexOf('.');
  return dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
}

function isAllowedUploadMime(mimeType: string, filename: string): boolean {
  const normalizedMime = mimeType.toLowerCase().split(';', 1)[0].trim();
  if (normalizedMime.startsWith('image/')) return true;
  // Every text format is readable data by definition — code, markup, configs.
  if (normalizedMime.startsWith('text/')) return true;
  if (ALLOWED_UPLOAD_MIME_TYPES.has(normalizedMime)) return true;
  if (normalizedMime === 'application/octet-stream' || normalizedMime === '') {
    // Extension-less files stay out except a short list of well-known text
    // names — a blanket extension-less allowance would readmit unnamed native
    // binaries through the octet-stream door.
    const name = basename(filename).toLowerCase();
    if (['dockerfile', 'makefile', 'license', 'readme', 'justfile', 'procfile'].includes(name)) {
      return true;
    }
    return ALLOWED_UPLOAD_EXTENSIONS.has(uploadExtension(filename));
  }
  return false;
}

function uploadRouteNeedsAuth(routePath: string): boolean {
  return routePath === '/upload' || routePath.startsWith('/api');
}

function sanitizeApiWorkspaceContext(input: unknown): WorkspaceMessageContext | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const rootPath = typeof raw.rootPath === 'string' ? raw.rootPath.trim() : '';
  if (!rootPath || rootPath.length > 4096 || !isAbsolute(rootPath)) return null;
  const rootKind = typeof raw.rootKind === 'string' ? raw.rootKind.trim().slice(0, 64) : undefined;
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 160) : undefined;
  const gitBranch = typeof raw.gitBranch === 'string' ? raw.gitBranch.trim().slice(0, 160) : undefined;
  return {
    rootPath,
    ...(rootKind ? { rootKind } : {}),
    ...(label ? { label } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
}

export interface ApiRoutesDeps {
  jwtSecret: string;
  config: ApiRoutesConfig;
  runtimeService?: {
    getStatus: () => Promise<ServiceStatusResult>;
    install: () => Promise<ServiceInstallResult>;
    uninstall: () => Promise<ServiceUninstallResult>;
  };
}

export function legacyPairingRoles(role: string | null | undefined): string[] {
  switch ((role ?? '').toLowerCase()) {
    case 'owner':
    case 'admin':
      return ['admin'];
    case 'viewer':
      return ['viewer'];
    case 'operator':
    case 'user':
    default:
      return ['operator'];
  }
}

function signWebAuthToken(
  user: { user_id: string; username: string; role: string },
  jwtSecret: string,
  tenantId = 'default',
): string {
  return jwtSign(user.user_id, jwtSecret, WEB_AUTH_TTL_SECONDS, {
    role: user.role,
    roles: legacyPairingRoles(user.role),
    username: user.username,
    tenant_id: tenantId,
    legacy_pairing: true,
  });
}

export function shouldUseSecureCookie(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto ?? (request as FastifyRequest & { protocol?: string }).protocol;
  return protocol?.split(',')[0]?.trim() === 'https';
}

function setWebAuthCookie(reply: FastifyReply, request: FastifyRequest, token: string): void {
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: 'strict',
    path: '/',
    maxAge: WEB_AUTH_TTL_SECONDS,
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getRegistrationPolicy(config: ApiRoutesConfig): 'open' | 'invite' | 'closed' {
  const policy = config.security.registration;
  return policy === 'open' || policy === 'closed' ? policy : 'invite';
}

function resolveRefreshTtlSeconds(config: ApiRoutesConfig): number {
  const days = config.security.refresh_token_ttl_days;
  if (typeof days === 'number' && Number.isFinite(days) && days >= 1) {
    return Math.round(days * 86400);
  }
  return REFRESH_TOKEN_TTL_SECONDS;
}

/**
 * Set the browser auth cookie pair. `secure` follows the request protocol
 * (not NODE_ENV): Secure cookies set over plain HTTP on a non-localhost
 * origin (e.g. Safari, or a LAN IP) are silently dropped by the browser,
 * which breaks session persistence entirely.
 */
function setBrowserAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  pair: TokenPair,
  refreshTtlSeconds: number,
): void {
  const secureCookie = shouldUseSecureCookie(request);
  reply.setCookie(AUTH_COOKIE_NAME, pair.accessToken, {
    httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(REFRESH_COOKIE_NAME, pair.refreshToken, {
    httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/api/auth/refresh',
    maxAge: refreshTtlSeconds,
  });
}

function issueBrowserAuthSession(
  reply: FastifyReply,
  request: FastifyRequest,
  input: {
    userId: string;
    tenantId: string;
    email?: string;
    role?: Role;
    jwtSecret: string;
    refreshTtlSeconds: number;
  },
): void {
  const pair = issueTokenPair(input.userId, input.tenantId, input.jwtSecret, {
    email: input.email,
    role: input.role,
    roles: input.role ? [input.role] : undefined,
    tenant_id: input.tenantId,
  }, request.headers['user-agent'] as string, input.refreshTtlSeconds);

  setBrowserAuthCookies(reply, request, pair, input.refreshTtlSeconds);
}

function registrationRoleFromPairingRole(role: string): Role | null {
  switch (role.toLowerCase()) {
    case 'owner':
    case 'admin':
      return 'admin';
    case 'operator':
    case 'user':
      return 'operator';
    case 'viewer':
      return 'viewer';
    default:
      return null;
  }
}

function generateOneTimePassword(): string {
  return `Mozi-${randomBytes(12).toString('base64url')}1a`;
}

function validationErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request body';
}

/**
 * Guard a session-scoped read against cross-user access.
 *
 * Only enforced when both an authenticated user and a persisted session row
 * exist: unknown sessions (no row) keep legacy behavior so single-user timelines
 * and pre-session-table history still load. A session owned by another user
 * yields 404 (not 403) so its existence isn't leaked across users.
 *
 * @returns `true` when the caller may proceed; `false` after a 404 was sent.
 */
function enforceSessionOwnership(
  reply: FastifyReply,
  sessionId: string,
  tenantId: string,
  userId: string | undefined,
): boolean {
  if (!userId) return true;
  const session = getSession(sessionId, tenantId);
  if (session && session.user_id !== userId) {
    reply.code(404).send({ error: 'Session not found' });
    return false;
  }
  return true;
}

function getPublicTenantId(request: FastifyRequest): string {
  const header = request.headers['x-mozi-tenant-id'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue?.trim()) return headerValue.trim();

  const query = request.query as Record<string, unknown> | undefined;
  const queryTenant = query?.tenantId ?? query?.tenant_id;
  if (typeof queryTenant === 'string' && queryTenant.trim()) return queryTenant.trim();

  const body = request.body as Record<string, unknown> | undefined;
  const bodyTenant = body?.tenantId ?? body?.tenant_id;
  if (typeof bodyTenant === 'string' && bodyTenant.trim()) return bodyTenant.trim();

  return 'default';
}

function ensureRawConfigRecord(parent: RawConfigRecord, key: string): RawConfigRecord {
  const current = parent[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as RawConfigRecord;
  }
  const next: RawConfigRecord = {};
  parent[key] = next;
  return next;
}

function providerHasConfiguredKey(
  providerId: string,
  rawProviders: Record<string, { apikey?: string; baseurl?: string }> | undefined,
  storedKeyProviders: Set<string>,
  readyCliProviders: Set<string> = new Set(),
): boolean {
  if (!providerId || providerId === 'auto' || providerId === 'none') return false;
  if (getProvider(providerId)?.apiMode === 'cli-pipe') return readyCliProviders.has(providerId);
  return storedKeyProviders.has(providerId) || Boolean(resolveApiKey(providerId, rawProviders));
}

function detectReadyCliProviderIds(probes: CodingWorkerProbe[] = detectCodingWorkers()): Set<string> {
  const providerByWorker: Record<CodingWorkerId, string> = {
    claude_code: 'claude-cli',
    codex_cli: 'codex-cli',
  };
  return new Set(
    probes
      .filter(probe => probe.installed && probe.authorized)
      .map(probe => providerByWorker[probe.id]),
  );
}

function embeddingRoleReady(
  providerId: string,
  rawProviders: Record<string, { apikey?: string; baseurl?: string }> | undefined,
  storedKeyProviders: Set<string>,
  embeddingConfig: { api_key?: string; base_url?: string },
): boolean {
  if (providerId === 'none') return false;
  if (providerId === 'auto') {
    return Boolean(
      embeddingConfig.api_key?.trim()
      || providerHasConfiguredKey('openai', rawProviders, storedKeyProviders)
      || providerHasConfiguredKey('minimax', rawProviders, storedKeyProviders)
      || rawProviders?.ollama?.baseurl?.trim()
      || process.env.OLLAMA_BASE_URL?.trim()
      || process.env.OLLAMA_HOST?.trim()
    );
  }
  if (providerId === 'ollama') {
    return Boolean(
      embeddingConfig.base_url?.trim()
      || rawProviders?.ollama?.baseurl?.trim()
      || process.env.OLLAMA_BASE_URL?.trim()
      || process.env.OLLAMA_HOST?.trim()
      || providerHasConfiguredKey('ollama', rawProviders, storedKeyProviders)
    );
  }
  return Boolean(embeddingConfig.api_key?.trim())
    || providerHasConfiguredKey(providerId, rawProviders, storedKeyProviders);
}

function defaultChatModelForProvider(providerId: string): string {
  const provider = getProvider(providerId);
  if (!provider || !isChatRoleEligibleProvider(provider)) return '';
  return provider.defaultModel || provider.models[0]?.id || '';
}

function resolveFallbackChatRoleSlot(
  rawProviders: Record<string, { apikey?: string; baseurl?: string }> | undefined,
  storedKeyProviders: Set<string>,
  readyCliProviders: Set<string>,
): ModelRoleSlot {
  for (const provider of getChatRoleEligibleProviders()) {
    if (!providerHasConfiguredKey(provider.id, rawProviders, storedKeyProviders, readyCliProviders)) continue;
    return {
      provider: provider.id,
      model: defaultChatModelForProvider(provider.id),
      ready: true,
      eligible: true,
    };
  }

  return { provider: '', model: '', ready: false, eligible: false };
}

function resolveChatRoleSlot(
  roleName: 'brain' | 'light' | 'step' | 'plan_summary',
  providerId: string,
  modelId: string,
  rawProviders: Record<string, { apikey?: string; baseurl?: string }> | undefined,
  storedKeyProviders: Set<string>,
  readyCliProviders: Set<string>,
): ModelRoleSlot {
  const provider = getProvider(providerId);
  if (provider && isChatRoleEligibleProvider(provider)) {
    const model = modelId && getModel(provider.id, modelId)
      ? modelId
      : defaultChatModelForProvider(provider.id);
    return {
      provider: provider.id,
      model,
      ready: providerHasConfiguredKey(provider.id, rawProviders, storedKeyProviders, readyCliProviders),
      eligible: true,
    };
  }

  if (!providerId) {
    return { provider: '', model: '', ready: false, eligible: false };
  }

  return {
    ...resolveFallbackChatRoleSlot(rawProviders, storedKeyProviders, readyCliProviders),
    configured: {
      provider: providerId,
      model: modelId,
      eligible: false,
      reason: `${roleName} provider does not have a registered chat-role model adapter.`,
    },
  };
}

function validateChatModelRole(roleName: 'brain' | 'light' | 'step' | 'plan_summary', role: { provider: string; model: string }): void {
  const provider = getProvider(role.provider);
  if (!provider) throw new Error(`Unknown ${roleName} provider`);
  if (!isChatRoleEligibleProvider(provider)) {
    throw new Error(`${roleName} provider is not eligible for chat roles`);
  }
  if (provider.apiMode === 'cli-pipe' && !detectReadyCliProviderIds().has(provider.id)) {
    throw new Error(`${roleName} provider is not installed and authenticated`);
  }
  const raw = readConfigWithLegacyFallback(getConfigPath()).config;
  const registered = ((raw.model_discovery as Record<string, unknown> | undefined)?.models ?? {}) as Record<string, string[]>;
  const validModel = provider.apiMode === 'cli-pipe'
    ? provider.models.some(model => model.id === role.model) || registered[provider.id]?.includes(role.model)
    : Boolean(resolveRuntimeModel(provider.id, role.model, { allowUnknown: registered[provider.id]?.includes(role.model) }));
  if (!validModel) {
    throw new Error(`Invalid ${roleName} model for provider`);
  }
}

function normalizeModelGrant(input: string[] | null): string[] | null {
  if (input === null) return null;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of input) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function serializeCatalogModel(model: ModelDef, allowed: boolean, discovered = false, metadata: EnrichedModelMetadata | null = null, source: 'live' | 'cache' | 'catalog' | 'manual' = 'catalog', confidence: 'provider' | 'catalog' | 'conservative' = 'catalog') {
  const merged = metadata ? { ...model, ...metadata } : model;
  return {
    id: merged.id,
    name: merged.name,
    tier: merged.tier,
    contextWindow: merged.contextWindow,
    maxOutputTokens: merged.maxOutputTokens,
    supportsTools: merged.supportsTools,
    supportsVision: merged.supportsVision,
    reasoning: merged.reasoning,
    inputCostPer1M: merged.inputCostPer1M ?? null,
    outputCostPer1M: merged.outputCostPer1M ?? null,
    allowed,
    source,
    capabilityConfidence: confidence,
    ...(discovered ? { discovered: true } : {}),
  };
}

async function buildProviderModels(provider: ProviderDef, allowedModels: string[] | null, discovery?: ModelDiscoveryResult, manualModelIds: string[] = []) {
  const bundledIds = new Set(provider.models.map(model => model.id));
  const includedIds = new Set(bundledIds);
  const liveById = new Map((discovery?.models ?? []).map(model => [model.id, model]));
  const models = provider.models.map((model) => serializeCatalogModel(
    model,
    allowedModels === null || allowedModels.includes(model.id),
    false,
    liveById.get(model.id) as EnrichedModelMetadata | undefined ?? null,
    liveById.has(model.id) ? discovery?.source ?? 'catalog' : 'catalog',
    liveById.has(model.id) ? discovery?.capabilityConfidence ?? 'catalog' : 'catalog',
  ));

  for (const live of discovery?.models ?? []) {
    if (bundledIds.has(live.id)) continue;
    const resolved = resolveRuntimeModel(provider.id, live.id, { allowUnknown: true });
    if (!resolved) continue;
    const registryMetadata = allowedModels !== null && allowedModels.includes(live.id)
      ? await enrich(provider.id, live.id)
      : null;
    models.push(serializeCatalogModel(
      { ...resolved, name: live.name ?? resolved.name },
      allowedModels === null || allowedModels.includes(live.id),
      true,
      { ...(registryMetadata ?? {}), ...live } as EnrichedModelMetadata,
      discovery?.source ?? 'live',
      discovery?.capabilityConfidence ?? 'provider',
    ));
    includedIds.add(live.id);
  }

  for (const modelId of manualModelIds) {
    if (includedIds.has(modelId)) continue;
    const resolved = resolveRuntimeModel(provider.id, modelId, { allowUnknown: true });
    if (!resolved) continue;
    models.push(serializeCatalogModel(resolved, allowedModels === null || allowedModels.includes(modelId), true, null, 'manual', 'conservative'));
    includedIds.add(modelId);
  }

  if (allowedModels === null) {
    return models;
  }
  if (provider.apiMode === 'cli-pipe') {
    return models;
  }

  for (const modelId of allowedModels) {
    if (includedIds.has(modelId)) continue;
    const resolved = getModel(provider.id, modelId);
    if (!resolved) continue;
    models.push(serializeCatalogModel(resolved, true, true, await enrich(provider.id, modelId), 'catalog', 'catalog'));
  }
  return models;
}

function validateKnownModelGrant(input: string[] | null): string[] | null {
  const normalized = normalizeModelGrant(input);
  if (normalized === null) return null;
  const providers = getAllProviders().filter(isChatRoleEligibleProvider);
  const raw = readConfigWithLegacyFallback(getConfigPath()).config;
  const registered = ((raw.model_discovery as Record<string, unknown> | undefined)?.models ?? {}) as Record<string, string[]>;
  const unknown = normalized.filter(model => !isSafeCustomModelId(model) || !providers.some(provider => Boolean(
    provider.apiMode === 'cli-pipe'
      ? provider.models.some(candidate => candidate.id === model) || registered[provider.id]?.includes(model)
      : getModel(provider.id, model) || registered[provider.id]?.includes(model),
  )));
  if (unknown.length > 0) {
    throw new Error(`Unknown model id(s): ${unknown.join(', ')}`);
  }
  return normalized;
}

function validateRequestedModelAllowed(ctx: ApiTenantContext, modelId: string): void {
  assertModelAllowed(ctx.tenant_id, ctx.user_id, modelId);
}

function getModelRolesForTenant(tenantId: string): { brain: ModelRoleSlot; light: ModelRoleSlot; step: ModelRoleSlot; plan_summary: ModelRoleSlot; embedding: ModelRoleSlot } {
  const raw = readConfigWithLegacyFallback(getConfigPath()).config;
  const config = loadConfig(getConfigPath());
  const rawProviders = raw.providers as Record<string, { apikey?: string; baseurl?: string }> | undefined;
  const storedKeyProviders = new Set(listTenantApiKeys(tenantId).map((entry) => entry.provider));
  const readyCliProviders = detectReadyCliProviderIds();

  const brainProvider = config.model_router?.brain_provider ?? '';
  const brainModel = config.brain.model || (brainProvider ? getProvider(brainProvider)?.defaultModel ?? '' : '');

  const legacyRoles = config.model_router?.roles as Record<string, { provider?: string; model?: string }> | undefined;
  const preferredCheap = config.model_router?.routing_preferences?.preferred_cheap;
  const lightProvider = config.models.light.provider
    || legacyRoles?.simple_subagent?.provider
    || legacyRoles?.summary?.provider
    || preferredCheap?.provider
    || '';
  const lightModel = config.models.light.model
    || legacyRoles?.simple_subagent?.model
    || legacyRoles?.summary?.model
    || preferredCheap?.model
    || '';

  const embeddingProvider = config.memory.embedding.provider;
  const embeddingModel = config.memory.embedding.model ?? '';
  const embeddingConfig = {
    api_key: config.memory.embedding.api_key,
    base_url: config.memory.embedding.base_url,
  };

  return {
    brain: resolveChatRoleSlot('brain', brainProvider, brainModel, rawProviders, storedKeyProviders, readyCliProviders),
    light: resolveChatRoleSlot('light', lightProvider, lightModel, rawProviders, storedKeyProviders, readyCliProviders),
    step: legacyRoles?.step?.provider && legacyRoles.step.model
      ? resolveChatRoleSlot('step', legacyRoles.step.provider, legacyRoles.step.model, rawProviders, storedKeyProviders, readyCliProviders)
      : { provider: '', model: '', ready: true, eligible: true, inherit: true },
    plan_summary: legacyRoles?.plan_summary?.provider && legacyRoles.plan_summary.model
      ? resolveChatRoleSlot('plan_summary', legacyRoles.plan_summary.provider, legacyRoles.plan_summary.model, rawProviders, storedKeyProviders, readyCliProviders)
      : { provider: '', model: '', ready: true, eligible: true, inherit: true },
    embedding: {
      provider: embeddingProvider,
      model: embeddingModel,
      ready: embeddingRoleReady(embeddingProvider, rawProviders, storedKeyProviders, embeddingConfig),
      eligible: true,
    },
  };
}

// ---------------------------------------------------------------------------
// REST API authn/authz guard
// ---------------------------------------------------------------------------

function registerAuthGuard(
  app: FastifyInstance,
  config: ApiRoutesConfig,
  jwtSecret: string,
): (request: { tenantContext?: ApiTenantContext }) => ApiTenantContext | undefined {
  app.addHook('preHandler', async (request, reply) => {
    const routePath = typeof request.routeOptions.url === 'string'
      ? request.routeOptions.url
      : request.url.split('?')[0];
    if (!uploadRouteNeedsAuth(routePath)) return;
    if (routePath.startsWith('/api') && isPublicApiRoute(request.method, routePath, config.server.auth_mode)) return;
    if (config.server.auth_mode === 'none') {
      ensureLocalUser(LOCAL_TENANT_ID);
      // Honor an existing web-auth cookie so REST requests resolve the SAME user
      // identity the WebSocket/Brain path derives from the same token (payload.sub).
      // Without this, REST falls back to 'local-user' while the WS upgrades to the
      // JWT subject (a UUID), so uploads land in a different per-user workspace than
      // the one the Brain reads and attachments appear to vanish.
      const credential = extractApiCredential(
        request.headers as Record<string, string | string[] | undefined>,
        (request as { cookies?: Record<string, string | undefined> }).cookies,
      );
      let ctx: ApiTenantContext = LOCAL_AUTH_CONTEXT;
      if (credential) {
        const payload = jwtVerify(credential, jwtSecret);
        if (payload && typeof payload.sub === 'string' && payload.sub) {
          ctx = {
            tenant_id: typeof payload.tenant_id === 'string' ? payload.tenant_id : LOCAL_TENANT_ID,
            user_id: payload.sub,
            roles: LOCAL_AUTH_CONTEXT.roles,
          };
        }
      }
      (request as { tenantContext?: ApiTenantContext }).tenantContext = ctx;
      return;
    }

    const credential = extractApiCredential(
      request.headers as Record<string, string | string[] | undefined>,
      (request as { cookies?: Record<string, string | undefined> }).cookies,
    );
    if (!credential) {
      logAudit({
        action: 'auth.fail',
        resource_type: 'api',
        resource_id: routePath,
        details: { reason: 'missing_credential', method: request.method },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(401).send({
        success: false,
        error: 'Authentication required (Bearer token or x-api-key)',
      });
    }

    const tenantContext = await authenticateApi(
      credential,
      jwtSecret,
      config.security.enterprise as Parameters<typeof authenticateApi>[2],
    );
    if (!tenantContext) {
      logAudit({
        action: 'auth.fail',
        resource_type: 'api',
        resource_id: routePath,
        details: { reason: 'invalid_credential', method: request.method },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(401).send({
        success: false,
        error: 'Invalid or expired credentials',
      });
    }

    const resolvedUser = getUserById(tenantContext.user_id, tenantContext.tenant_id);
    if (resolvedUser?.status === 'disabled') {
      logAudit({
        tenant_id: tenantContext.tenant_id,
        user_id: tenantContext.user_id,
        action: 'auth.fail',
        resource_type: 'api',
        resource_id: routePath,
        details: { reason: 'user_disabled', method: request.method },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(403).send({
        success: false,
        error: 'Account disabled',
      });
    }

    if (!resolvedUser && !subjectStillExists(tenantContext.user_id, tenantContext.tenant_id)) {
      logAudit({
        tenant_id: tenantContext.tenant_id,
        user_id: tenantContext.user_id,
        action: 'auth.fail',
        resource_type: 'api',
        resource_id: routePath,
        details: { reason: 'subject_gone', method: request.method },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(401).send({
        success: false,
        error: 'Invalid or expired credentials',
      });
    }

    const effectiveRole = resolveRole(
      tenantContext.tenant_id,
      tenantContext.user_id,
      tenantContext.roles,
    );
    const requiredRole = requiredRoleForApiRoute(request.method, routePath);
    if (!hasApiRole(requiredRole, effectiveRole)) {
      return reply.code(403).send({
        success: false,
        error: `Forbidden: ${requiredRole} role required`,
      });
    }

    (request as { tenantContext?: typeof tenantContext }).tenantContext = tenantContext;
    return undefined;
  });

  return (request) => request.tenantContext;
}

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiRoutesDeps,
): Promise<void> {
  const { jwtSecret, config } = deps;
  const runtimeService = deps.runtimeService ?? {
    getStatus: getServiceStatus,
    install: () => installService(),
    uninstall: uninstallService,
  };

  // Register cookie plugin — must be registered before any route handler reads cookies
  await app.register(fastifyCookie, { secret: jwtSecret });

  // ── Rate limiting ──
  const rlCfg = config.http_rate_limit ?? { global_rpm: 2000, auth_rpm: 10, pair_rpm: 5 };
  const refreshTtlSeconds = resolveRefreshTtlSeconds(config);
  await app.register(fastifyRateLimit, {
    global: true,
    max: rlCfg.global_rpm,
    timeWindow: '1 minute',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry after ${context.after}`,
    }),
  });

  const uploadMaxBytes = resolveUploadMaxBytes(config);
  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: uploadMaxBytes,
      files: 20,
      parts: 25,
    },
  });

  const getRequestTenantContext = registerAuthGuard(app, config, jwtSecret);

  /**
   * Fastify preHandler factory that enforces a minimum role requirement.
   * Returns 403 if the authenticated user's role is insufficient.
   */
  function requireRole(role: 'admin' | 'operator' | 'viewer') {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = (request as FastifyRequest & { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } }).tenantContext;
      if (!ctx) {
        return reply.code(401).send({ success: false, error: 'Not authenticated' });
      }
      const effectiveRole = resolveRole(ctx.tenant_id, ctx.user_id, ctx.roles);
      if (!hasApiRole(role, effectiveRole)) {
        return reply.code(403).send({ success: false, error: `Forbidden: ${role} role required` });
      }
    };
  }

  app.post('/upload', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    if (!request.isMultipart()) {
      return reply.code(415).send({ success: false, error: 'Expected multipart/form-data' });
    }

    const uploaded: UploadedFileResponse[] = [];
    try {
      const workspaceDir = await ensureToolWorkspaceDir(tenantContext.user_id);
      const allowedRoots = allowedFsRootsForUser(tenantContext.user_id);
      const query = request.query as { dir?: string } | undefined;
      let uploadDir = resolve(workspaceDir);
      const trySetUploadDir = (rawDir: string): void => {
        const requestedDir = resolve(rawDir);
        const realRequestedDir = realpathOrNull(requestedDir);
        if (!realRequestedDir) return;
        try {
          if (!statSync(realRequestedDir).isDirectory()) return;
        } catch {
          return;
        }
        if (isGeneratedOutputPath(requestedDir) || isGeneratedOutputPath(realRequestedDir)) {
          throw new UploadValidationError(
            'Output is reserved for files generated by MOZI; upload into the workspace instead',
            400,
            'generated_output_only',
          );
        }
        // Validate against realpath'd roots (handles the /var → /private/var
        // symlink on macOS), but keep the caller's namespace for the written
        // path so it stays consistent with the workspace dir we report.
        if (
          isPathAllowedForRoots(requestedDir, allowedRoots)
          || isPathAllowedForRoots(realRequestedDir, allowedRoots)
        ) {
          uploadDir = requestedDir;
        }
      };
      if (typeof query?.dir === 'string' && query.dir.trim()) {
        trySetUploadDir(query.dir.trim());
      }

      for await (const part of request.parts({
        limits: {
          fileSize: uploadMaxBytes,
          files: 20,
          parts: 25,
        },
      })) {
        if (part.type === 'field') {
          if (part.fieldname === 'dir' && typeof part.value === 'string' && part.value.trim()) {
            trySetUploadDir(part.value.trim());
          }
          continue;
        }

        const originalName = basename(part.filename || 'upload.bin');
        const mimeType = (part.mimetype || 'application/octet-stream').toLowerCase();
        if (!isAllowedUploadMime(mimeType, originalName)) {
          part.file.resume();
          throw new UploadValidationError(
            `Unsupported upload MIME type: ${mimeType}`,
            415,
            'unsupported_mime_type',
          );
        }

        const safeName = sanitizeUploadFilename(originalName);
        const storedName = `${Date.now()}-${randomBytes(6).toString('hex')}-${safeName}`;
        // uploadDir was already validated against the allowed roots above, so
        // here we only ensure the generated filename can't escape it. (Checking
        // the not-yet-created targetPath against realpath'd roots would spuriously
        // fail on the /var → /private/var symlink.)
        const targetPath = resolve(uploadDir, storedName);
        if (!isPathInsideRoot(targetPath, uploadDir)) {
          part.file.resume();
          throw new UploadValidationError('Invalid upload filename', 400, 'invalid_filename');
        }

        try {
          await pipeline(part.file, createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }));
        } catch (err) {
          try {
            unlinkSync(targetPath);
          } catch {
            // Ignore cleanup failure; the original stream error is reported below.
          }
          throw err;
        }

        const stats = statSync(targetPath);
        uploaded.push({
          filename: originalName,
          path: targetPath,
          size: stats.size,
          mimeType,
        });
      }

      if (uploaded.length === 0) {
        return reply.code(400).send({ success: false, error: 'No files uploaded' });
      }

      return reply.send(uploaded);
    } catch (err) {
      if (err instanceof UploadValidationError) {
        return reply.code(err.statusCode).send({ success: false, code: err.code, error: err.message });
      }
      if (err instanceof app.multipartErrors.RequestFileTooLargeError || (err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({
          success: false,
          code: 'file_too_large',
          error: `Uploaded file exceeds ${uploadMaxBytes} bytes`,
        });
      }

      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, userId: tenantContext.user_id }, 'Upload request failed');
      return reply.code(500).send({ success: false, error: 'Upload failed' });
    }
  });

  // ── REST API: chat history ──
  app.get('/api/history', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const query = request.query as Record<string, string>;
    const chatId = query.chatId || 'local-user';
    const limit = Number(query.limit) || 50;
    if (query.sessionId) {
      if (!enforceSessionOwnership(reply, query.sessionId, tenantId, tenantContext?.user_id)) return reply;
      const messages = getSessionHistory(query.sessionId, limit, tenantId);
      return reply.send({ chatId, sessionId: query.sessionId, messages });
    }
    const messages = getHistory(
      chatId,
      limit,
      tenantId,
      undefined,
      tenantContext?.user_id ? { userId: tenantContext.user_id } : undefined,
    );
    return reply.send({ chatId, messages });
  });

  // ── REST API: Web UI runtime workspace bootstrap ──
  app.get('/api/runtime/workspace', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const snapshot = await buildRuntimeWorkspaceSnapshot(tenantId);
    return reply.send(snapshot);
  });

  app.get('/api/runtime/desktop-capabilities', async (_request, reply) => {
    return reply.send(await buildDesktopCapabilitySnapshot());
  });

  // ── REST API: logical filesystem roots ──
  app.get('/api/fs/roots', async (_request, reply) => {
    return reply.send({ success: true, roots: listFsRoots() });
  });

  // The cross-session deliverable library (operator decision 2026-07-19):
  // every runtime-verified file MOZI produced for this user, grouped by the
  // session that made it — session TITLES, never UUIDs. Timeline rows are
  // pointers; the filesystem allow-list decides what is listed.
  app.get('/api/fs/deliverables', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { getVerifiedDeliverableLibrary } = await import('../memory/session-deliverables.js');
    const groups = getVerifiedDeliverableLibrary({
      tenantId: tenantContext.tenant_id,
      userId: tenantContext.user_id,
    });
    const registrations = new Map(
      deliverableRegistry.listByTenant(tenantContext.tenant_id)
        .map((deliverable) => [deliverable.path, deliverable] as const),
    );
    return reply.send({
      success: true,
      groups: groups.map((group) => ({
        ...group,
        deliverables: group.deliverables.map((deliverable) => {
          const registered = registrations.get(deliverable.path);
          return {
            ...deliverable,
            deliverableId: registered?.id ?? null,
            versionCount: registered?.versionCount ?? null,
          };
        }),
      })),
    });
  });

  app.get('/api/deliverables/:id/versions', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const deliverable = deliverableRegistry.getById(tenantContext.tenant_id, id);
    if (!deliverable) return reply.code(404).send({ success: false, error: 'Deliverable not found' });
    return reply.send({
      success: true,
      deliverableId: deliverable.id,
      versions: deliverableVersionStore.listByDeliverable(tenantContext.tenant_id, deliverable.id)
        .map((version) => ({
          id: version.id,
          deliverableId: version.deliverableId,
          version: version.version,
          size: version.size,
          createdAt: version.createdAt,
        })),
    });
  });

  app.post('/api/deliverables/:id/continue', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const deliverable = deliverableRegistry.getById(tenantContext.tenant_id, id);
    if (!deliverable) return reply.code(404).send({ success: false, error: 'Deliverable not found' });

    try {
      const session = getDb().transaction(() => {
        const created = createSession(
          tenantContext.user_id,
          deliverable.title,
          tenantContext.tenant_id,
        );
        sessionDeliverableBindingStore.create({
          tenantId: tenantContext.tenant_id,
          sessionId: created.id,
          deliverableId: deliverable.id,
        });
        return created;
      })();
      logAudit({
        tenant_id: tenantContext.tenant_id,
        user_id: tenantContext.user_id,
        action: 'session.create',
        resource_type: 'session',
        resource_id: session.id,
        details: { title: session.title, deliverable_id: deliverable.id, continuation: true },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
      });
      return reply.send({ success: true, session_id: session.id });
    } catch (error) {
      logger.warn({ err: error, deliverableId: deliverable.id }, 'Deliverable continuation session creation failed');
      return reply.code(500).send({ success: false, error: 'Deliverable continuation failed' });
    }
  });

  app.post('/api/deliverables/:id/rollback', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = DeliverableRollbackBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    const { id } = request.params as { id: string };
    const deliverable = deliverableRegistry.getById(tenantContext.tenant_id, id);
    if (!deliverable) return reply.code(404).send({ success: false, error: 'Deliverable not found' });
    const selected = deliverableVersionStore.getByVersion(
      tenantContext.tenant_id,
      deliverable.id,
      parsed.data.version,
    );
    if (!selected) return reply.code(404).send({ success: false, error: 'Deliverable version not found' });

    // The snapshot is server-owned and deliberately outside the Brain's roots.
    // Only the registered target must still resolve to a real allowed file.
    const target = resolveAllowedFsFile(deliverable.path, tenantContext.user_id);
    if (!target || target.path !== deliverable.path) {
      return reply.code(404).send({ success: false, error: 'Deliverable target is not available' });
    }

    try {
      copyFileSync(selected.snapshotPath, target.path);
      const stats = statSync(target.path);
      const updated = deliverableRegistry.upsertByPath({
        tenantId: tenantContext.tenant_id,
        path: target.path,
        kind: deliverable.kind,
        title: deliverable.title,
        currentSize: stats.size,
        currentMtimeMs: Math.trunc(stats.mtimeMs),
        currentHash: selected.hash,
      });
      const appended = deliverableVersionStore.snapshot({
        tenantId: tenantContext.tenant_id,
        deliverableId: updated.id,
        version: deliverable.versionCount + 1,
        sourcePath: target.path,
        hash: selected.hash,
      });
      return reply.send({
        success: true,
        deliverable: deliverableRegistry.getById(tenantContext.tenant_id, updated.id),
        version: {
          id: appended.id,
          deliverableId: appended.deliverableId,
          version: appended.version,
          size: appended.size,
          createdAt: appended.createdAt,
        },
      });
    } catch (error) {
      logger.warn({ err: error, deliverableId: deliverable.id, version: parsed.data.version }, 'Deliverable rollback failed');
      return reply.code(500).send({ success: false, error: 'Deliverable rollback failed' });
    }
  });

  app.get('/api/fs/file', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsFileQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    const resolved = resolveAllowedFsFile(parsed.data.path, tenantContext.user_id);
    if (!resolved) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const filename = basename(resolved.path);
    const disposition = parsed.data.inline
      ? `inline; filename="${asciiFallbackFilename(filename)}"`
      : contentDispositionAttachment(filename);
    reply
      .type(mimeForFilePath(resolved.path))
      .header('Content-Disposition', disposition)
      .header('Content-Length', String(resolved.stats.size));
    return reply.send(createReadStream(resolved.path));
  });

  registerOfficeRoutes(app, { resolveAllowedFile: resolveAllowedFsFile });

  registerGitBranchRoutes(app, { resolveAllowedDir: resolveAllowedFsDir });

  app.get('/api/fs/office-pdf', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = FsOfficePdfQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    const resolved = resolveAllowedFsFile(parsed.data.path, tenantContext.user_id);
    if (!resolved) {
      return reply.code(404).send({ success: false, error: 'File not found' });
    }

    const extension = fileExtension(resolved.path);
    if (!OFFICE_PDF_EXTENSIONS.has(extension)) {
      return reply.code(400).send({ success: false, error: 'Unsupported office file type' });
    }

    mkdirSync(OFFICE_PDF_CACHE_DIR, { recursive: true });
    const key = createHash('sha256')
      .update(`${resolved.path}:${resolved.stats.mtimeMs}:${resolved.stats.size}`)
      .digest('hex');
    const cachedPdfPath = resolve(OFFICE_PDF_CACHE_DIR, `${key}.pdf`);

    if (!existsSync(cachedPdfPath)) {
      const sourceBase = basename(resolved.path);
      const convertedPdfPath = resolve(
        OFFICE_PDF_CACHE_DIR,
        sourceBase.replace(/\.[^.]*$/, '.pdf'),
      );
      const userInstallationDir = resolve(
        OFFICE_PDF_CACHE_DIR,
        `lo-profile-${randomBytes(12).toString('hex')}`,
      );

      try {
        mkdirSync(userInstallationDir, { recursive: true });
        await execFileAsync('soffice', [
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          OFFICE_PDF_CACHE_DIR,
          `-env:UserInstallation=file://${userInstallationDir}`,
          resolved.path,
        ], { timeout: 90_000 });

        if (!existsSync(convertedPdfPath)) {
          if (!existsSync(cachedPdfPath)) {
            throw new Error(`Converted PDF not found at ${convertedPdfPath}`);
          }
        } else {
          renameSync(convertedPdfPath, cachedPdfPath);
        }
      } catch (err) {
        logger.warn({
          path: resolved.path,
          err: err instanceof Error ? err.message : String(err),
        }, 'Office conversion failed');
        return reply.code(500).send({ success: false, error: 'Office conversion failed' });
      }
    }

    const pdfStats = statSync(cachedPdfPath);
    reply
      .type('application/pdf')
      .header('Content-Disposition', 'inline; filename="preview.pdf"')
      .header('Content-Length', String(pdfStats.size));
    return reply.send(createReadStream(cachedPdfPath));
  });

  app.get('/api/fs/preview', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsPreviewQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    const resolved = resolveAllowedFsFile(parsed.data.path, tenantContext.user_id);
    if (!resolved) {
      return reply.code(404).send({ success: false, code: 'file_not_found', error: 'File not found' });
    }

    if (!isQuickLookPreviewExtension(resolved.path)) {
      return reply.code(404).send({
        success: false,
        code: 'preview_unsupported_type',
        error: 'No preview available for this file type',
      });
    }

    if (!canRunQuickLookPreviews()) {
      return reply.code(501).send({
        success: false,
        code: 'preview_unavailable_platform',
        error: 'File previews require macOS QuickLook',
      });
    }

    const previewPath = await generateFilePreviewPng(resolved.path, {
      width: parsed.data.w ?? DEFAULT_FILE_PREVIEW_WIDTH,
    });
    if (!previewPath) {
      return reply.code(404).send({
        success: false,
        code: 'preview_unavailable',
        error: 'No preview available',
      });
    }

    let previewStats: Stats;
    try {
      previewStats = statSync(previewPath);
    } catch (err) {
      logger.warn({
        path: resolved.path,
        previewPath,
        err: err instanceof Error ? err.message : String(err),
      }, 'Generated preview path could not be read');
      return reply.code(404).send({
        success: false,
        code: 'preview_unavailable',
        error: 'No preview available',
      });
    }

    reply
      .type('image/png')
      .header('Content-Length', String(previewStats.size));
    return reply.send(createReadStream(previewPath));
  });

  // ── Files manager: browse / delete / rename the caller's workspace ─────────

  /**
   * GET /api/fs/browse?dir=<optional> — folder picker for importing an existing
   * project. Unlike /api/fs/list (scoped to already-allowed roots), this browses
   * so the user can reach a folder they have NOT yet granted. Sandboxed to the
   * user's home subtree — you cannot escape above $HOME. Returns directory names
   * only (never file contents); the actual grant still goes through
   * POST /api/fs/roots, which validates the path.
   */
  app.get('/api/fs/browse', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    // Anchor on the user's own workspace dir and never climb above it. Homedir
    // is useless in the container (/root is empty; real folders live under the
    // mounted workspace volume). Its parent is the shared users/ dir, so
    // allowing "up" would leak sibling users' folders — we don't. Anything
    // outside the workspace goes through the paste-a-path escape hatch, and the
    // grant endpoint re-validates regardless.
    const base = realpathOrNull(await ensureToolWorkspaceDir(ctx.user_id)) ?? resolve(await ensureToolWorkspaceDir(ctx.user_id));
    const within = (p: string) => p === base || isPathInsideRoot(p, base);
    const query = request.query as Record<string, string>;
    let dir = query.dir?.trim() ? resolve(query.dir.trim()) : base;
    const realDir = realpathOrNull(dir);
    if (!realDir) return reply.send({ dir: base, base, parent: null, dirs: [] });
    dir = realDir;
    if (!within(dir)) {
      return reply.code(403).send({ success: false, error: 'Folder browsing is limited to your workspace area' });
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return reply.send({ dir, base, parent: dir === base ? null : dirname(dir), dirs: [] });
    }
    const dirs = names
      .filter((name) => !name.startsWith('.'))
      .map((name) => resolve(dir, name))
      .filter((full) => {
        try {
          return statSync(full).isDirectory();
        } catch {
          return false;
        }
      })
      .map((full) => ({ name: basename(full), path: full }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dir === base ? null : dirname(dir);
    return reply.send({ dir, base, parent, dirs });
  });

  /**
   * GET /api/fs/list?dir=<optional> — list entries in the caller's workspace
   * (or a subdirectory within their allowed roots). Returns metadata only.
   */
  app.get('/api/fs/list', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const query = request.query as Record<string, string>;
    const allowedRoots = allowedFsRootsForUser(ctx.user_id);
    const baseDir = await ensureToolWorkspaceDir(ctx.user_id);

    let dir = query.dir?.trim() ? resolve(query.dir.trim()) : resolve(baseDir);
    const realDir = realpathOrNull(dir);
    if (!realDir) return reply.send({ dir, root: resolve(baseDir), entries: [] });
    dir = realDir;
    // Any requested dir must sit inside an allowed root.
    if (!allowedRoots.some((root) => isPathInsideRoot(dir, root))) {
      return reply.code(403).send({ success: false, error: 'Directory is outside the allowed workspace' });
    }

    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return reply.send({ dir, root: resolve(baseDir), entries: [] });
    }
    const entries = names.map((name) => {
      const full = resolve(dir, name);
      try {
        const st = statSync(full);
        const isDir = st.isDirectory();
        return {
          name,
          displayName: displayNameForFsEntry(name),
          path: full,
          isDir,
          size: isDir ? undefined : st.size,
          created: st.birthtimeMs,
          mtime: st.mtimeMs,
          mime: isDir ? undefined : mimeForFilePath(full),
          artifactKind: isDir ? undefined : classifyFileArtifactKind(full.split('.').pop() ?? ''),
        };
      } catch {
        return null;
      }
    }).filter((e): e is NonNullable<typeof e> => e !== null)
      // Directories first, then newest files.
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : b.mtime - a.mtime));

    return reply.send({ dir, root: resolve(baseDir), entries });
  });

  app.post('/api/fs/reveal', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsRevealBodySchema.safeParse(request.body || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.message });

    const target = resolveAllowedFsPath(parsed.data.path.trim(), ctx.user_id);
    if (!target) return reply.code(400).send({ success: false, error: 'Path is outside the allowed workspace or does not exist' });
    const reveal = revealCommandForPlatform(process.platform, target.path, target.stats.isDirectory());
    try {
      await execFileAsync(reveal.command, reveal.args, { timeout: 5_000 });
      logger.info({ userId: ctx.user_id, path: target.path, revealed: reveal.revealed }, 'Revealed workspace path');
      return reply.send({ success: true, revealed: reveal.revealed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ userId: ctx.user_id, path: target.path, command: reveal.command, err: message }, 'Failed to reveal workspace path');
      return reply.code(500).send({ success: false, error: 'Reveal failed', detail: message });
    }
  });

  app.get('/api/fs/source', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsSourceQuerySchema.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.message });

    const target = resolveAllowedFsPath(parsed.data.path.trim(), ctx.user_id);
    if (!target || !target.stats.isFile()) {
      return reply.code(400).send({ success: false, error: 'Path is outside the allowed workspace or is not a file' });
    }
    const containingRoot = allowedFsRootsForUser(ctx.user_id)
      .filter((root) => isPathInsideRoot(target.path, root))
      .sort((a, b) => b.length - a.length)[0];
    const relativePath = containingRoot ? relative(containingRoot, target.path).split(sep).join('/') : basename(target.path);
    const candidates = findFileArtifactSourceCandidates(ctx.tenant_id, basename(target.path));
    const exact = candidates.find((candidate) => {
      const persisted = candidate.path.split('\\').join('/');
      return persisted === target.path.split(sep).join('/') || persisted === relativePath || persisted.endsWith(`/${relativePath}`);
    });
    const candidate = exact ?? candidates.find((item) => basename(item.path) === basename(target.path));
    if (!candidate) return reply.send({ source: null });

    const session = getSession(candidate.sessionId, ctx.tenant_id);
    if (!session) return reply.send({ source: null });
    logger.debug({ userId: ctx.user_id, path: target.path, sessionId: session.id }, 'Resolved file source session');
    return reply.send({
      source: {
        sessionId: session.id,
        sessionTitle: session.title,
        timestamp: candidate.timestamp,
      },
    });
  });

  /**
   * POST /api/fs/mkdir — create a single folder inside an allowed directory.
   */
  app.post('/api/fs/mkdir', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsMkdirBodySchema.safeParse(request.body || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.message });

    const safeName = validateFsSegment(parsed.data.name);
    if (!safeName) return reply.code(400).send({ success: false, error: 'Invalid folder name' });

    const allowedRoots = allowedFsRootsForUser(ctx.user_id);
    if (!isAbsolute(parsed.data.dir.trim())) {
      return reply.code(400).send({ success: false, error: 'Invalid directory' });
    }
    const parentDir = resolveAllowedFsDir(parsed.data.dir.trim(), ctx.user_id, allowedRoots);
    if (!parentDir) return reply.code(404).send({ success: false, error: 'Directory not found' });

    const destination = resolve(parentDir, safeName);
    if (!isPathInsideRoot(destination, parentDir) || !isPathAllowedForRoots(destination, allowedRoots)) {
      return reply.code(400).send({ success: false, error: 'Invalid destination' });
    }
    if (existsSync(destination)) {
      return reply.code(409).send({ success: false, error: 'A folder with that name already exists' });
    }

    try {
      mkdirSync(destination, { mode: 0o700 });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to create folder');
      return reply.code(500).send({ success: false, error: 'Create folder failed' });
    }
    return reply.send({ success: true, path: destination });
  });

  /**
   * POST /api/fs/move — move files or folders into an allowed destination dir.
   */
  app.post('/api/fs/move', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsMoveBodySchema.safeParse(request.body || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.message });

    const allowedRoots = allowedFsRootsForUser(ctx.user_id);
    const rawDestDir = parsed.data.destDir.trim();
    if (!isAbsolute(rawDestDir)) {
      return reply.code(400).send({ success: false, error: 'Invalid destination directory' });
    }
    const destDir = resolveAllowedFsDir(rawDestDir, ctx.user_id, allowedRoots);
    if (!destDir) return reply.code(404).send({ success: false, error: 'Destination directory not found' });
    const destinationIsGeneratedOutput = isGeneratedOutputPath(destDir);

    const moved: Array<{ from: string; to: string }> = [];
    const errors: Array<{ path: string; error: string; status: number }> = [];
    for (const rawPath of parsed.data.paths) {
      const inputPath = rawPath.trim();
      if (!isAbsolute(inputPath)) {
        errors.push({ path: rawPath, error: 'Invalid path', status: 400 });
        continue;
      }
      const source = resolveAllowedFsPath(inputPath, ctx.user_id, allowedRoots);
      if (!source) {
        errors.push({ path: rawPath, error: 'Path not found', status: 404 });
        continue;
      }
      if (destinationIsGeneratedOutput && !isGeneratedOutputPath(source.path)) {
        errors.push({
          path: rawPath,
          error: 'Output is reserved for files generated by MOZI',
          status: 400,
        });
        continue;
      }
      if (source.stats.isDirectory() && isPathInsideRoot(destDir, source.path)) {
        errors.push({ path: rawPath, error: 'Cannot move a folder into itself', status: 400 });
        continue;
      }

      const destination = resolve(destDir, basename(source.path));
      if (!isPathInsideRoot(destination, destDir) || !isPathAllowedForRoots(destination, allowedRoots)) {
        errors.push({ path: rawPath, error: 'Invalid destination', status: 400 });
        continue;
      }
      if (existsSync(destination)) {
        errors.push({ path: rawPath, error: 'Destination already exists', status: 409 });
        continue;
      }

      try {
        renameSync(source.path, destination);
        moved.push({ from: source.path, to: destination });
      } catch (err) {
        logger.warn({
          path: source.path,
          destDir,
          err: err instanceof Error ? err.message : String(err),
        }, 'Failed to move filesystem entry');
        errors.push({ path: rawPath, error: 'Move failed', status: 500 });
      }
    }

    return reply.send({ success: errors.length === 0, moved, errors });
  });

  /**
   * DELETE /api/fs/file?path=<path> — delete a file or folder inside the caller's roots.
   */
  app.delete('/api/fs/file', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const parsed = FsFileQuerySchema.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: parsed.error.message });
    const allowedRoots = allowedFsRootsForUser(ctx.user_id);
    const target = resolveAllowedFsPath(parsed.data.path.trim(), ctx.user_id, allowedRoots);
    if (!target) {
      return reply.code(404).send({ success: false, error: 'File not found' });
    }
    if (allowedRoots.some((root) => resolve(root) === target.path)) {
      return reply.code(400).send({ success: false, error: 'Cannot delete a workspace root' });
    }
    try {
      if (target.stats.isDirectory()) {
        rmSync(target.path, { recursive: true });
      } else if (target.stats.isFile()) {
        unlinkSync(target.path);
      } else {
        return reply.code(400).send({ success: false, error: 'Not a file or folder' });
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to delete file');
      return reply.code(500).send({ success: false, error: 'Delete failed' });
    }
    return reply.send({ success: true });
  });

  /**
   * POST /api/fs/rename — rename a file within its current directory.
   */
  app.post('/api/fs/rename', async (request, reply) => {
    const ctx = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const body = (request.body || {}) as { path?: string; newName?: string };
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    const newName = typeof body.newName === 'string' ? basename(body.newName.trim()) : '';
    if (!rawPath || !newName || newName !== body.newName?.trim() || /[\\/]/.test(newName)) {
      return reply.code(400).send({ success: false, error: 'Invalid path or filename' });
    }
    const allowedRoots = getWorkspaceAllowedRoots(ctx.user_id);
    const target = realpathOrNull(resolve(rawPath));
    if (!target || !allowedRoots.some((root) => { const rr = realpathOrNull(root); return rr && isPathInsideRoot(target, rr); })) {
      return reply.code(404).send({ success: false, error: 'File not found' });
    }
    const destination = resolve(dirname(target), newName);
    if (!isPathInsideRoot(destination, dirname(target))) {
      return reply.code(400).send({ success: false, error: 'Invalid destination' });
    }
    if (existsSync(destination)) return reply.code(409).send({ success: false, error: 'A file with that name already exists' });
    try {
      renameSync(target, destination);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to rename file');
      return reply.code(500).send({ success: false, error: 'Rename failed' });
    }
    return reply.send({ success: true, path: destination });
  });

  app.post('/api/fs/roots', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const parsed = FsRootPathBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    try {
      const grant = grantProjectRoot(parsed.data.path);
      const roots = listFsRoots();
      logAudit({
        tenant_id: tenantContext?.tenant_id ?? 'default',
        user_id: tenantContext?.user_id,
        action: 'fs_root.grant',
        resource_type: 'fs_root',
        resource_id: grant.path,
        details: { label: grant.label },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
      });
      return reply.send({
        success: true,
        root: roots.find((root) => root.path === grant.path) ?? {
          tier: 'project',
          path: grant.path,
          label: grant.label,
          granted_at: grant.granted_at,
          bookmark: grant.bookmark,
        },
        roots,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: message });
    }
  });

  app.delete('/api/fs/roots', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const bodyResult = FsRootPathBodySchema.safeParse(request.body || {});
    const query = request.query as { path?: string } | undefined;
    const path = bodyResult.success ? bodyResult.data.path : query?.path;
    if (!path) {
      return reply.code(400).send({ success: false, error: bodyResult.success ? 'path is required' : bodyResult.error.message });
    }

    const revoked = revokeProjectRoot(path);
    logAudit({
      tenant_id: tenantContext?.tenant_id ?? 'default',
      user_id: tenantContext?.user_id,
      action: 'fs_root.revoke',
      resource_type: 'fs_root',
      resource_id: path,
      details: { revoked },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    });
    return reply.send({ success: true, revoked, roots: listFsRoots() });
  });

  app.get('/api/runtime/logs', async (request, reply) => {
    const query = request.query as { lines?: string; bytes?: string };
    const lines = query.lines ? Number(query.lines) : undefined;
    const maxBytes = query.bytes ? Number(query.bytes) : undefined;
    return reply.send(readRuntimeLogSnapshot({ maxLines: lines, maxBytes }));
  });

  app.get('/api/runtime/service', async (_request, reply) => {
    return reply.send(await runtimeService.getStatus());
  });

  app.post('/api/runtime/service', async (request, reply) => {
    const body = (request.body || {}) as { action?: string };
    if (body.action === 'enable') {
      const result = await runtimeService.install();
      if (!result.ok) {
        return reply.code(500).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true, action: 'enable', result, status: await runtimeService.getStatus() });
    }
    if (body.action === 'disable') {
      const result = await runtimeService.uninstall();
      if (!result.ok) {
        return reply.code(500).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true, action: 'disable', result, status: await runtimeService.getStatus() });
    }
    return reply.code(400).send({ ok: false, error: 'Expected action "enable" or "disable".' });
  });

  // ── REST API: session CRUD ──
  app.get('/api/sessions', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const query = request.query as Record<string, string>;
    const userId = tenantContext?.user_id ?? (query.userId || 'local-user');
    const offset = Number(query.offset) || 0;
    const limit = Number(query.limit) || 20;
    const includeArchived = query.archived === 'true';
    const sessions = listSessions(userId, { tenantId, limit, offset, includeArchived });
    const total = countSessions(userId, { tenantId, includeArchived });
    return reply.send({ sessions, total });
  });

  app.post('/api/sessions', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const body = (request.body || {}) as Record<string, unknown>;
    const userId = tenantContext?.user_id ?? (typeof body.userId === 'string' && body.userId ? body.userId : 'local-user');
    const title = typeof body.title === 'string' ? body.title : undefined;
    const workspaceRootId = typeof body.workspaceRootId === 'string' && body.workspaceRootId.trim()
      ? body.workspaceRootId.trim().slice(0, 4096)
      : null;
    const workspaceContext = sanitizeApiWorkspaceContext(body.workspaceContext);
    if ((workspaceRootId && !workspaceContext) || (!workspaceRootId && workspaceContext)) {
      return reply.code(400).send({ error: 'Project binding requires both a stable root ID and an absolute root path.' });
    }
    const shouldReuseDraft = !title || title === 'New Chat';
    const reusableDraft = shouldReuseDraft ? getReusableDraftSession(userId, tenantId) : null;
    if (reusableDraft) {
      bindDraftSessionProject(reusableDraft.id, tenantId, { workspaceRootId, workspaceContext });
    }
    const session = reusableDraft
      ? getSession(reusableDraft.id, tenantId) ?? reusableDraft
      : createSession(userId, title, tenantId, { workspaceRootId, workspaceContext });
    const archivedDrafts = shouldReuseDraft ? archiveUnusedDraftSessions(userId, tenantId, session.id) : 0;
    logAudit({
      tenant_id: tenantId,
      user_id: userId,
      action: 'session.create',
      resource_type: 'session',
      resource_id: session.id,
      details: { title: session.title, reused: Boolean(reusableDraft), archived_unused_drafts: archivedDrafts },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    });
    return reply.send({ session, reused: Boolean(reusableDraft), archived_unused_drafts: archivedDrafts });
  });

  app.get('/api/sessions/:id/messages', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;
    const query = request.query as Record<string, string>;
    const limit = Number(query.limit) || 50;
    const messages = getSessionHistory(id, limit, tenantId);
    return reply.send({ sessionId: id, messages });
  });

  app.delete('/api/sessions/:id/messages/:messageId', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id, messageId: rawMessageId } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;
    const messageId = Number(rawMessageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      return reply.code(400).send({ error: 'Invalid message ID' });
    }

    const deleted = deleteSessionMessage(id, messageId, tenantId);
    if (!deleted) return reply.code(404).send({ error: 'Message not found' });
    const deletedTimelineCount = deleteTimelineForSessionMessage({
      tenantId,
      sessionId: id,
      role: deleted.role,
      content: deleted.content,
      messageOccurrence: deleted.message_occurrence,
      conversationId: messageId,
    });
    logAudit({
      tenant_id: tenantId,
      user_id: tenantContext?.user_id,
      action: 'session.message.delete',
      resource_type: 'session_message',
      resource_id: String(messageId),
      details: {
        session_id: id,
        role: deleted.role,
        deleted_conversation_count: deleted.deleted_conversation_count,
        deleted_timeline_count: deletedTimelineCount,
      },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    });
    return reply.send({
      ok: true,
      sessionId: id,
      deletedConversationCount: deleted.deleted_conversation_count,
      deletedTimelineCount,
    });
  });

  app.get('/api/sessions/:id/timeline', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;
    const query = request.query as Record<string, string>;
    const limit = Number(query.limit) || 100;
    try {
      const page = getSessionTimelinePage(id, { limit, tenantId, before: query.before });
      // Issue #627: expose the server-authoritative turn envelopes alongside the
      // rendered timeline so a reconnecting client learns turn grouping and
      // terminal status without re-deriving them. Only on the first page (no
      // cursor) to avoid re-sending the full turn list while paginating back.
      const turns = query.before ? undefined : getSessionTurns(id, tenantId);
      return reply.send({ sessionId: id, ...page, ...(turns ? { turns } : {}) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid timeline cursor' });
    }
  });

  app.get('/api/sessions/:id/context-checkpoint', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;
    return reply.send({ sessionId: id, checkpoint: getLatestContextCheckpoint(id, tenantId) });
  });

  app.get('/api/sessions/:id/permission-level', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;

    const permissionLevel = getSessionPermissionLevel(id, tenantId);
    if (!permissionLevel) return reply.code(404).send({ error: 'Session not found' });
    return reply.send({ sessionId: id, permission_level: permissionLevel });
  });

  app.patch('/api/sessions/:id/permission-level', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;

    const parsed = PermissionLevelBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    const updated = applySessionPermissionLevel({
      sessionId: id,
      tenantId,
      permissionLevel: parsed.data.permission_level,
      userId: tenantContext?.user_id,
      reason: 'manual_update',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    if (!updated) return reply.code(404).send({ error: 'Session not found' });
    return reply.send({ sessionId: id, permission_level: parsed.data.permission_level });
  });

  app.patch('/api/sessions/:id', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    const body = (request.body || {}) as Record<string, unknown>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;
    if (typeof body.title === 'string') {
      updateTitle(id, body.title, tenantId);
    }
    if ('workspaceRootId' in body || 'workspaceContext' in body) {
      const workspaceRootId = typeof body.workspaceRootId === 'string' && body.workspaceRootId.trim()
        ? body.workspaceRootId.trim().slice(0, 4096)
        : null;
      const workspaceContext = sanitizeApiWorkspaceContext(body.workspaceContext);
      if ((workspaceRootId && !workspaceContext) || (!workspaceRootId && workspaceContext)) {
        return reply.code(400).send({ error: 'Execution scope requires both a stable root ID and an absolute root path.' });
      }
      updateSessionWorkspaceContext(id, tenantId, {
        workspaceRootId,
        workspaceContext,
      });
    }
    if (body.archived === true) {
      archiveSession(id, tenantId);
    }
    const session = getSession(id, tenantId);
    return reply.send({ session });
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const { id } = request.params as Record<string, string>;
    if (!enforceSessionOwnership(reply, id, tenantId, tenantContext?.user_id)) return reply;
    archiveSession(id, tenantId);
    logAudit({
      tenant_id: tenantId,
      user_id: tenantContext?.user_id,
      action: 'session.delete',
      resource_type: 'session',
      resource_id: id,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
    });
    return reply.send({ ok: true });
  });

  // ── REST API: auth (pairing from Web UI) ──
  // NOTE: /api/auth/status is polled on every page load and only reveals a
  // boolean (are you authenticated) — it must NOT carry the tight auth_rpm
  // brute-force cap, or refreshing a few times trips a 429. It inherits the
  // generous global limit instead.
  app.get('/api/auth/status', async (request, reply) => {
    const authMode = config.server.auth_mode ?? 'token';
    const registrationPolicy = getRegistrationPolicy(config);
    const oauthProviderConfigs = Array.isArray(config.security.oauth?.providers)
      ? config.security.oauth.providers
      : [];
    const oauthProviders = oauthProviderConfigs
      .map((provider) => {
        if (!provider || typeof provider !== 'object') return null;
        const name = (provider as { provider?: unknown }).provider;
        return typeof name === 'string' && name.length > 0 ? name : null;
      })
      .filter((provider): provider is string => provider !== null);

    // auth_mode='none' = self-hosted single-user deployment. The WS channel
    // and /api preHandler already auto-authenticate as 'local-user' in this
    // mode; report the same to the front-end so it skips LoginPage.
    if (config.server.auth_mode === 'none') {
      ensureLocalUser(LOCAL_TENANT_ID);
      const status = getOnboardingStatus(LOCAL_USER_ID, LOCAL_TENANT_ID);
      return reply.send({
        authenticated: true,
        onboarding_done: status.completed,
        auth_mode: authMode,
        registration_policy: registrationPolicy,
        oauth_providers: oauthProviders,
      });
    }

    // Check JWT cookie for browser-authenticated sessions.
    const cookieToken = (request as { cookies?: Record<string, string | undefined> }).cookies?.[AUTH_COOKIE_NAME];
    if (cookieToken) {
      const payload = jwtVerify(cookieToken, jwtSecret);
      if (payload) {
        const userId = payload.sub;
        const tenantId = (payload.tenant_id as string | undefined) ?? 'default';
        const resolvedUser = getUserById(userId, tenantId);
        // A signature that still verifies is not an account that still exists.
        // Report the truth and drop the cookies, so the client shows LoginPage
        // instead of a workspace it cannot name an owner for.
        const subjectGone = !resolvedUser && !isAllowed(userId, tenantId);
        if (resolvedUser?.status === 'disabled' || subjectGone) {
          reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
          reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth/refresh' });
          return reply.send({
            authenticated: false,
            onboarding_done: false,
            auth_mode: authMode,
            registration_policy: registrationPolicy,
            bootstrap_available: authMode === 'local'
              ? canBootstrapLocalAdmin(getPublicTenantId(request))
              : undefined,
            oauth_providers: oauthProviders,
          });
        }
        const status = getOnboardingStatus(userId, tenantId);
        const legacyUser = getAllowedUsers(tenantId).find(user => user.user_id === userId);
        if (legacyUser && payload.legacy_pairing !== true) {
          setWebAuthCookie(reply, request, signWebAuthToken(legacyUser, jwtSecret, tenantId));
        }
        return reply.send({
          authenticated: true,
          onboarding_done: Boolean(legacyUser) || status.completed,
          auth_mode: authMode,
          registration_policy: registrationPolicy,
          oauth_providers: oauthProviders,
        });
      }
    }

    if (authMode === 'local') {
      return reply.send({
        authenticated: false,
        onboarding_done: false,
        auth_mode: authMode,
        registration_policy: registrationPolicy,
        // First registrant bootstraps as admin without an invite — the UI
        // needs to know so it doesn't demand an invite code from them.
        bootstrap_available: canBootstrapLocalAdmin(getPublicTenantId(request)),
        oauth_providers: oauthProviders,
      });
    }

    // Fallback: legacy pairing check for backward compat
    const tenantId = getPublicTenantId(request);
    const paired = hasAnyPairedUsers(tenantId);
    const users = paired ? getAllowedUsers(tenantId) : [];
    const user = users[0];
    return reply.send({
      authenticated: false,
      onboarding_done: paired,
      paired,
      username: user?.username ?? null,
      auth_mode: authMode,
      registration_policy: registrationPolicy,
      oauth_providers: oauthProviders,
    });
  });

  app.post('/api/auth/pair', {
    config: { rateLimit: { max: rlCfg.pair_rpm, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = (request.body || {}) as Record<string, string>;
    const code = body.code?.trim();
    if (!code) {
      return reply.code(400).send({ success: false, error: 'Missing pairing code' });
    }

    const tenantId = getPublicTenantId(request);
    const role = validatePairingToken(code, tenantId);
    if (role) {
      const userId = `web_${Date.now()}`;
      const username = 'web-user';
      addAllowedUser(userId, username, role, tenantId);
      logger.info({ tenantId, userId, username, role }, 'Web UI pairing successful');
      const token = signWebAuthToken({ user_id: userId, username, role }, jwtSecret, tenantId);
      logAudit({
        tenant_id: tenantId,
        user_id: userId,
        action: 'auth.pair',
        resource_type: 'user',
        resource_id: userId,
        details: { username, role },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });
      setWebAuthCookie(reply, request, token);
      return reply.send({ success: true });
    }

    logger.warn({ codePrefix: code.slice(0, 12) }, 'Web UI pairing failed: invalid or expired token');
    logAudit({
      tenant_id: tenantId,
      action: 'auth.pair',
      resource_type: 'user',
      details: { reason: 'invalid_or_expired_token' },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
      outcome: 'failure',
    });
    return reply.code(401).send({ success: false, error: 'Invalid or expired pairing token' });
  });

  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (config.server.auth_mode !== 'local') {
      return reply.code(404).send({ success: false, error: 'Not found' });
    }

    const parsed = LocalRegisterBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      logAudit({
        tenant_id: getPublicTenantId(request),
        action: 'auth.register',
        resource_type: 'user',
        details: { reason: 'invalid_request' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const tenantId = getPublicTenantId(request);
    const email = normalizeEmail(parsed.data.email);
    const passwordPolicyError = validatePasswordPolicy(parsed.data.password);
    if (passwordPolicyError) {
      logAudit({
        tenant_id: tenantId,
        action: 'auth.register',
        resource_type: 'user',
        details: { email, reason: 'password_policy' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(400).send({ success: false, error: passwordPolicyError });
    }

    if (getUserByEmail(email, tenantId)) {
      logAudit({
        tenant_id: tenantId,
        action: 'auth.register',
        resource_type: 'user',
        details: { email, reason: 'duplicate_email' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(409).send({ success: false, code: 'duplicate_email', error: 'Email is already registered' });
    }

    let role: Role;
    if (canBootstrapLocalAdmin(tenantId)) {
      role = 'admin';
    } else {
      const policy = getRegistrationPolicy(config);
      if (policy === 'closed') {
        logAudit({
          tenant_id: tenantId,
          action: 'auth.register',
          resource_type: 'user',
          details: { email, reason: 'registration_closed' },
          ip_address: request.ip,
          user_agent: request.headers['user-agent'],
          outcome: 'failure',
        });
        return reply.code(403).send({ success: false, error: 'Registration is closed' });
      }
      if (policy === 'open') {
        role = 'viewer';
      } else {
        const inviteCode = parsed.data.invite_code?.trim();
        if (!inviteCode) {
          logAudit({
            tenant_id: tenantId,
            action: 'auth.register',
            resource_type: 'user',
            details: { email, reason: 'missing_invite' },
            ip_address: request.ip,
            user_agent: request.headers['user-agent'],
            outcome: 'failure',
          });
          return reply.code(403).send({ success: false, error: 'Invite code required' });
        }
        const inviteRole = validatePairingToken(inviteCode, tenantId);
        const mappedRole = inviteRole ? registrationRoleFromPairingRole(inviteRole) : null;
        if (!mappedRole) {
          logAudit({
            tenant_id: tenantId,
            action: 'auth.register',
            resource_type: 'user',
            details: { email, reason: 'invalid_invite' },
            ip_address: request.ip,
            user_agent: request.headers['user-agent'],
            outcome: 'failure',
          });
          return reply.code(403).send({ success: false, error: 'Invalid or expired invite code' });
        }
        role = mappedRole;
      }
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const user = createLocalUser({
        tenant_id: tenantId,
        email,
        name: parsed.data.name ?? null,
        password_hash: passwordHash,
        role,
      });
      assignRole(tenantId, user.id, role, user.id);
      issueBrowserAuthSession(reply, request, {
        userId: user.id,
        tenantId,
        email: user.email,
        role,
        jwtSecret,
        refreshTtlSeconds,
      });
      logAudit({
        tenant_id: tenantId,
        user_id: user.id,
        action: 'auth.register',
        resource_type: 'user',
        resource_id: user.id,
        details: { email: user.email, role },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });
      return reply.send({ success: true, user });
    } catch (err) {
      if (err instanceof DuplicateUserError) {
        logAudit({
          tenant_id: tenantId,
          action: 'auth.register',
          resource_type: 'user',
          details: { email, reason: 'duplicate_email' },
          ip_address: request.ip,
          user_agent: request.headers['user-agent'],
          outcome: 'failure',
        });
        return reply.code(409).send({ success: false, code: 'duplicate_email', error: 'Email is already registered' });
      }
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Local registration failed');
      logAudit({
        tenant_id: tenantId,
        action: 'auth.register',
        resource_type: 'user',
        details: { email, reason: 'server_error' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(500).send({ success: false, error: 'Registration failed' });
    }
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (config.server.auth_mode !== 'local') {
      return reply.code(404).send({ success: false, error: 'Not found' });
    }

    const parsed = LocalLoginBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const tenantId = getPublicTenantId(request);
    const email = normalizeEmail(parsed.data.email);
    const user = getUserAuthByEmail(email, tenantId);

    if (user?.status === 'disabled') {
      logAudit({
        tenant_id: tenantId,
        user_id: user.id,
        action: 'auth.fail',
        resource_type: 'user',
        resource_id: user.id,
        details: { email, reason: 'user_disabled' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(403).send({ success: false, error: 'Account disabled' });
    }

    const storedHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(parsed.data.password, storedHash);
    if (!user || !user.password_hash || !passwordMatches) {
      logAudit({
        tenant_id: tenantId,
        user_id: user?.id,
        action: 'auth.fail',
        resource_type: 'user',
        resource_id: user?.id,
        details: { email, reason: 'invalid_credentials' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(401).send({ success: false, error: 'invalid credentials' });
    }

    const loggedIn = markUserLogin(user.id, tenantId) ?? user;
    const role = resolveRole(tenantId, user.id, [user.role]);
    issueBrowserAuthSession(reply, request, {
      userId: user.id,
      tenantId,
      email: user.email,
      role,
      jwtSecret,
      refreshTtlSeconds,
    });
    logAudit({
      tenant_id: tenantId,
      user_id: user.id,
      action: 'auth.login',
      resource_type: 'user',
      resource_id: user.id,
      details: { provider: 'local', email },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
      outcome: 'success',
    });
    return reply.send({ success: true, user: loggedIn });
  });

  app.post('/api/auth/password', async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = PasswordChangeBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const user = getUserAuthById(ctx.user_id, ctx.tenant_id);
    if (!user?.password_hash) {
      return reply.code(400).send({ success: false, error: 'Local password is not set for this user' });
    }

    const currentMatches = await verifyPassword(parsed.data.current_password, user.password_hash);
    if (!currentMatches) {
      logAudit({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        action: 'auth.fail',
        resource_type: 'user',
        resource_id: ctx.user_id,
        details: { reason: 'password_change_invalid_current' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(401).send({ success: false, error: 'invalid credentials' });
    }

    const passwordPolicyError = validatePasswordPolicy(parsed.data.new_password);
    if (passwordPolicyError) {
      return reply.code(400).send({ success: false, error: passwordPolicyError });
    }

    const passwordHash = await hashPassword(parsed.data.new_password);
    const updated = updateUserPasswordHash(ctx.user_id, ctx.tenant_id, passwordHash);
    if (!updated) return reply.code(404).send({ success: false, error: 'User not found' });
    const revoked = revokeAllUserRefreshTokens(ctx.user_id, ctx.tenant_id);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth/refresh' });
    logAudit({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      action: 'auth.password',
      resource_type: 'user',
      resource_id: ctx.user_id,
      details: { revoked_refresh_tokens: revoked },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
      outcome: 'success',
    });
    return reply.send({ success: true });
  });

  app.post('/api/auth/invites', async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = InviteCreateBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const expiresMinutes = parsed.data.expires_minutes ?? 30;
    const code = createPairingToken(parsed.data.role, expiresMinutes, ctx.tenant_id);
    logAudit({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      action: 'auth.pair',
      resource_type: 'invite',
      details: { role: parsed.data.role, expires_minutes: expiresMinutes },
      ip_address: request.ip,
      user_agent: request.headers['user-agent'],
      outcome: 'success',
    });
    return reply.send({ success: true, code, role: parsed.data.role, expires_minutes: expiresMinutes });
  });

  // ── REST API: token revocation ──

  /**
   * POST /api/auth/logout — revoke the caller's JWT and clear the httpOnly cookie.
   * Supports both Bearer token (Authorization header) and cookie-based auth.
   */
  app.post('/api/auth/logout', async (request, reply) => {
    // Always clear the httpOnly cookie
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });

    // Also revoke the JWT if one is present (Bearer header or cookie)
    const cookieToken = (request as { cookies?: Record<string, string | undefined> }).cookies?.[AUTH_COOKIE_NAME];
    const rawAuth = (request.headers.authorization ?? '') as string;
    const bearerToken = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7).trim() : '';
    const token = cookieToken || bearerToken;

    if (token) {
      const payload = jwtVerify(token, jwtSecret);
      if (payload?.jti) {
        const expiresAt = new Date(payload.exp * 1000).toISOString().replace('T', ' ').slice(0, 19);
        revokeToken(payload.jti, expiresAt, 'logout');
        logger.info({ sub: payload.sub, jti: payload.jti }, 'User logged out — token revoked');
      }
    }

    return reply.send({ success: true, message: 'Logged out' });
  });

  /**
   * POST /api/auth/revoke — admin-only endpoint to revoke any JWT by jti.
   * Body: { jti: string, reason?: string, expires_at: string }
   */
  app.post('/api/auth/revoke', async (request, reply) => {
    const body = (request.body || {}) as Record<string, string>;
    const jti = body.jti?.trim();
    const reason = body.reason?.trim();
    const expiresAt = body.expires_at?.trim();

    if (!jti) {
      return reply.code(400).send({ success: false, error: 'Missing required field: jti' });
    }
    if (!expiresAt) {
      return reply.code(400).send({ success: false, error: 'Missing required field: expires_at (ISO datetime)' });
    }

    revokeToken(jti, expiresAt, reason);
    logger.info({ jti, reason }, 'Admin revoked token');
    return reply.send({ success: true, message: `Token ${jti} revoked` });
  });

  // ── REST API: dashboard ──
  app.get('/api/health', async () => {
    const build = getBuildInfo();
    return {
      ok: true,
      pid: process.pid,
      mozi_home: getMoziHome(),
      config_path: getConfigPath(),
      version: build.version,
      commit: build.commit,
      surface: build.surface,
    };
  });

  app.get('/api/version', async () => getBuildInfo());

  app.get('/api/dashboard/overview', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    return reply.send(getSystemOverview(tenantId));
  });

  app.get('/api/dashboard/tasks', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const status = query.status || undefined;
    const limit = Number(query.limit) || 50;
    const offset = Number(query.offset) || 0;
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    return reply.send(getTaskHistory({ status, limit, offset, tenant_id: tenantId }));
  });

  app.get('/api/dashboard/costs', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const period = (query.period || 'day') as 'day' | 'week' | 'month';
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const model = query.model || undefined;
    return reply.send(getCostSummary(period, tenantId, model));
  });

  app.get('/api/dashboard/models', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    return reply.send({ models: listObservedModels(tenantId) });
  });

  app.get('/api/dashboard/slo', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const period = (query.period || 'day') as 'day' | 'week' | 'month';
    const limit = Number(query.limit) || 20;
    const model = query.model || undefined;
    return reply.send(getSloSummary({
      tenant_id: tenantId,
      model,
      period,
      limit,
    }));
  });

  // ── REST API: tenant ──
  app.get('/api/tenant/usage', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const period = query.period || 'day';
    return reply.send(getTenantUsage(tenantId, period));
  });

  app.get('/api/admin/usage', { preHandler: requireRole('admin') }, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const outcome: UsageAnalyticsFilters['outcome'] = query.outcome === 'success' || query.outcome === 'failure' || query.outcome === 'partial'
      ? query.outcome
      : undefined;
    return reply.send(getUsageAnalytics(tenantContext.tenant_id, {
      user_id: query.user_id,
      provider: query.provider,
      model: query.model,
      outcome,
      from: query.from,
      to: query.to,
      limit: Number(query.limit) || 50,
      offset: Number(query.offset) || 0,
    }));
  });

  app.post('/api/admin/usage/refresh-pricing', { preHandler: requireRole('admin') }, async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    try {
      const pricing = await refreshPricingAndReprice();
      logAudit({
        tenant_id: tenantContext.tenant_id,
        user_id: tenantContext.user_id,
        action: 'usage.pricing_refresh',
        resource_type: 'model_pricing',
        resource_id: pricing.registry_available ? 'litellm-live' : 'stored-snapshot',
        outcome: 'success',
      });
      return reply.send({ success: true, pricing });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logAudit({
        tenant_id: tenantContext.tenant_id,
        user_id: tenantContext.user_id,
        action: 'usage.pricing_refresh',
        resource_type: 'model_pricing',
        resource_id: 'litellm-live',
        outcome: 'failure',
        details: { error: message },
      });
      return reply.code(502).send({ success: false, error: message });
    }
  });

  app.get('/api/admin/usage/export', { preHandler: requireRole('admin') }, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    if (!tenantContext) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const outcome: UsageAnalyticsFilters['outcome'] = query.outcome === 'success' || query.outcome === 'failure' || query.outcome === 'partial'
      ? query.outcome
      : undefined;
    const filters = { user_id: query.user_id, provider: query.provider, model: query.model, outcome, from: query.from, to: query.to };
    const first = getUsageAnalytics(tenantContext.tenant_id, { ...filters, limit: 200, offset: 0 });
    const rows = [...first.rows];
    const exportLimit = Math.min(10_000, first.total);
    for (let offset = 200; offset < exportLimit; offset += 200) {
      rows.push(...getUsageAnalytics(tenantContext.tenant_id, { ...filters, limit: 200, offset }).rows);
    }
    const cell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const header = ['created_at', 'user_id', 'user_email', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'pricing_source', 'usage_status', 'price_version', 'currency', 'outcome', 'failure_category', 'duration_ms'];
    const csv = [header.map(cell).join(','), ...rows.slice(0, exportLimit).map(row => header.map(key => cell(row[key as keyof typeof row])).join(','))].join('\n');
    logAudit({
      tenant_id: tenantContext.tenant_id,
      user_id: tenantContext.user_id,
      action: 'usage.export',
      resource_type: 'billing_records',
      resource_id: String(rows.length),
      outcome: 'success',
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="mozi-usage-${first.filters.from}-${first.filters.to}.csv"`)
      .send(csv);
  });

  app.get('/api/tenant/quotas', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    return reply.send(getQuota(tenantId));
  });

  // ── REST API: event webhook -> proactive engine queue ──
  app.post('/api/webhook/:event_type', async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const params = request.params as Record<string, string>;
    const eventType = (params.event_type || 'external').trim().toLowerCase();
    const payload = ((request.body || {}) as Record<string, unknown>);
    const summary = typeof payload.summary === 'string' && payload.summary.trim().length > 0
      ? payload.summary.trim().slice(0, 240)
      : `Webhook event "${eventType}" received`;

    pushEvent({
      type: `webhook:${eventType}`,
      summary,
      data: payload,
    });

    const users = getAllowedUsers(tenantId);
    const owners = users.filter(user => user.role === 'owner');
    const owner = owners[0] ?? users[0];
    if (owner?.user_id) {
      void wakeProactiveEngine(owner.user_id, tenantId);
    }

    return reply.send({
      ok: true,
      queued: true,
      event_type: eventType,
    });
  });

  // ── REST API: audit log (admin only) ──
  app.get('/api/audit/export', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: Math.min(rlCfg.global_rpm, 10), timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: ApiTenantContext });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const parsed = AuditExportQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const query = parsed.data;
    try {
      const exported = exportAuditLog({
        tenant_id: tenantId,
        format: query.format,
        from: query.from,
        to: query.to,
        limit: query.limit,
        action: query.action,
        user_id: query.user_id,
        outcome: query.outcome,
      });
      logAudit({
        tenant_id: tenantId,
        user_id: tenantContext?.user_id,
        action: 'audit.export',
        resource_type: 'audit_log',
        resource_id: tenantId,
        details: {
          format: exported.format,
          record_count: exported.record_count,
          from: query.from ?? null,
          to: query.to ?? null,
          limit: query.limit ?? null,
          action: query.action ?? null,
          user_id: query.user_id ?? null,
          outcome: query.outcome ?? null,
        },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });

      const date = new Date().toISOString().slice(0, 10);
      const filename = `mozi-audit-${tenantId}-${date}.${exported.format}`;
      reply
        .type(exported.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
        .header('Content-Disposition', contentDispositionAttachment(filename));
      return reply.send(exported.data);
    } catch (err) {
      logAudit({
        tenant_id: tenantId,
        user_id: tenantContext?.user_id,
        action: 'audit.export',
        resource_type: 'audit_log',
        resource_id: tenantId,
        details: { error: err instanceof Error ? err.message : String(err) },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Audit export failed');
      return reply.code(500).send({ success: false, error: 'Audit export failed' });
    }
  });

  app.get('/api/audit', { preHandler: requireRole('admin') }, async (request, reply) => {
    const tenantContext = getRequestTenantContext(request as { tenantContext?: { tenant_id: string; user_id: string; roles: string[] } });
    const tenantId = tenantContext?.tenant_id ?? 'default';
    const query = request.query as Record<string, string>;
    const filters: AuditQueryFilters = {
      tenant_id: tenantId,
      user_id: query.user_id || undefined,
      action: query.action as AuditQueryFilters['action'] || undefined,
      resource_type: query.resource_type || undefined,
      outcome: (query.outcome as 'success' | 'failure') || undefined,
      from: query.from || undefined,
      to: query.to || undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    };
    const result = queryAuditLog(filters);
    return reply.send(result);
  });

  // ── REST API: skills ──
  app.get('/api/skills', async (_request, reply) => {
    try {
      const { listRuntimeSkills } = await import('../skills/workspace-manager.js');
      const records = await listRuntimeSkills();
      const skills = records.map(r => ({
        id: r.id,
        directory_name: r.directory_name,
        name: r.name,
        version: r.version ?? '1.0.0',
        category: r.category,
        description: r.description,
        status: r.enabled ? 'active' : 'disabled',
        eligible: r.eligible,
        missing_bins: r.missing_bins,
        missing_env: r.missing_env,
        user_invocable: r.user_invocable,
        origin: r.origin,
        sandbox_profile: r.sandbox_profile ?? null,
        trigger_pattern: undefined,
        source: r.source,
      }));
      return reply.send({ skills });
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to list skills');
      return reply.send({ skills: [] });
    }
  });

  app.get('/api/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { getRuntimeSkillDetail } = await import('../skills/workspace-manager.js');
      const skill = await getRuntimeSkillDetail(id);
      return reply.send({ skill: withSkillStatus(skill) });
    } catch (err) {
      return skillManagerErrorResponse(reply, err);
    }
  });

  app.put('/api/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SkillContentUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid skill content update body',
      });
    }

    try {
      const { updateWorkspaceSkillContent } = await import('../skills/workspace-manager.js');
      const skill = await updateWorkspaceSkillContent(id, parsed.data.content);
      return reply.send({ success: true, skill: withSkillStatus(skill) });
    } catch (err) {
      return skillManagerErrorResponse(reply, err);
    }
  });

  app.post('/api/skills/:id/state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SkillStateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid skill state body',
      });
    }

    try {
      const { setRuntimeSkillState } = await import('../skills/workspace-manager.js');
      const skill = await setRuntimeSkillState(id, parsed.data.enabled);
      return reply.send({ success: true, skill: withSkillStatus(skill) });
    } catch (err) {
      return skillManagerErrorResponse(reply, err);
    }
  });

  // ── REST API: commands ──
  app.get('/api/commands', async (_request, reply) => {
    const commands = [
      // Query
      { cmd: '/status', description: 'System status', category: 'query', args: null },
      { cmd: '/capabilities', description: 'Runtime capability manifest', category: 'query', args: null },
      { cmd: '/tasks', description: 'List active tasks', category: 'query', args: '[filter]' },
      { cmd: '/agents', description: 'List agents', category: 'query', args: null },
      { cmd: '/skills', description: 'List skills', category: 'query', args: null },
      { cmd: '/budget', description: 'Token usage', category: 'query', args: null },
      { cmd: '/users', description: 'List paired users', category: 'admin', args: null },
      // Action
      { cmd: '/cancel', description: 'Cancel running task', category: 'action', args: '<task_id>' },
      { cmd: '/approve', description: 'Approve hard-gate request', category: 'action', args: '<request_id>' },
      { cmd: '/reject', description: 'Reject hard-gate request', category: 'action', args: '<request_id>' },
      // Config
      { cmd: '/config', description: 'View or update config', category: 'config', args: '[key] [value]' },
      { cmd: '/pair', description: 'Generate pairing code', category: 'admin', args: null },
      { cmd: '/onboard', description: 'Re-run model setup', category: 'admin', args: null },
      { cmd: '/help', description: 'Show available commands', category: 'query', args: null },
      { cmd: '/start', description: 'Start session', category: 'action', args: null },
    ];
    return reply.send({ commands });
  });

  registerMemoryRoutes(app);

  registerSchedulerRoutes(app);

  registerTaskTemplateRoutes(app);

  // ── REST API: config hot-reload ──
  registerConfigRoutes(app);

  // ── #230 OAuth2/OIDC Routes ──────────────────────────────────────────────

  /**
   * GET /api/auth/oauth/authorize?provider=google
   * Initiates the OAuth2 authorization code flow; redirects to the provider.
   */
  app.get('/api/auth/oauth/authorize', {
    config: { rateLimit: { max: rlCfg.auth_rpm, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const query = request.query as Record<string, string>;
    const providerName = query.provider?.trim();
    if (!providerName) {
      return reply.code(400).send({ success: false, error: 'Missing query param: provider' });
    }

    const oauthCfg = config.security.oauth;
    if (!oauthCfg || !Array.isArray(oauthCfg.providers) || oauthCfg.providers.length === 0) {
      return reply.code(501).send({ success: false, error: 'OAuth providers not configured' });
    }

    try {
      const protocol = (request.headers['x-forwarded-proto'] as string) || 'http';
      const host = (request.headers['x-forwarded-host'] as string) || (request.headers.host as string) || request.hostname;
      const baseUrl = `${protocol}://${host}`;
      const tenantId = (request as { tenantContext?: { tenant_id: string } }).tenantContext?.tenant_id ?? 'default';

      const { authorizationUrl } = await initiateOAuthFlow(
        providerName,
        oauthCfg.providers as Parameters<typeof initiateOAuthFlow>[1],
        baseUrl,
        tenantId,
      );
      return reply.redirect(authorizationUrl);
    } catch (err) {
      logger.warn({ err: (err as Error).message, provider: providerName }, 'OAuth authorize failed');
      return reply.code(400).send({ success: false, error: (err as Error).message });
    }
  });

  /**
   * GET /api/auth/oauth/callback?code=...&state=...
   * Handles provider redirect: exchange code, provision user, issue tokens.
   */
  app.get('/api/auth/oauth/callback', {
    config: { rateLimit: { max: rlCfg.auth_rpm, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const query = request.query as Record<string, string>;
    const { code, state, error } = query;

    if (error) {
      logger.warn({ oauthError: error }, 'OAuth provider returned error');
      return reply.code(400).send({ success: false, error: `OAuth provider error: ${error}` });
    }
    if (!code || !state) {
      return reply.code(400).send({ success: false, error: 'Missing code or state' });
    }

    const oauthCfg = config.security.oauth;
    if (!oauthCfg || !Array.isArray(oauthCfg.providers)) {
      return reply.code(501).send({ success: false, error: 'OAuth providers not configured' });
    }

    try {
      const protocol = (request.headers['x-forwarded-proto'] as string) || 'http';
      const host = (request.headers['x-forwarded-host'] as string) || (request.headers.host as string) || request.hostname;
      const baseUrl = `${protocol}://${host}`;

      const { userInfo, tenantId } = await handleOAuthCallback(
        code,
        state,
        oauthCfg.providers as Parameters<typeof handleOAuthCallback>[2],
        baseUrl,
      );

      // JIT provision user
      const user = findOrCreateUser({
        tenant_id: tenantId,
        email: userInfo.email,
        name: userInfo.name,
        avatar_url: userInfo.avatar_url,
        auth_provider: userInfo.provider,
        provider_id: userInfo.provider_id,
      });

      // Issue token pair
      const pair = issueTokenPair(user.id, tenantId, jwtSecret, {
        email: user.email,
        role: user.role,
        tenant_id: tenantId,
      }, request.headers['user-agent'] as string, refreshTtlSeconds);

      logAudit({
        tenant_id: tenantId,
        user_id: user.id,
        action: 'auth.login',
        resource_type: 'user',
        resource_id: user.id,
        details: { provider: userInfo.provider, email: user.email },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'] as string,
        outcome: 'success',
      });

      setBrowserAuthCookies(reply, request, pair, refreshTtlSeconds);

      logger.info({ userId: user.id, provider: userInfo.provider }, 'OAuth login successful');
      // Redirect to UI root after successful login
      return reply.redirect('/');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'OAuth callback failed');
      logAudit({
        action: 'auth.fail',
        resource_type: 'api',
        resource_id: '/api/auth/oauth/callback',
        details: { error: (err as Error).message },
        ip_address: request.ip,
        outcome: 'failure',
      });
      return reply.code(400).send({ success: false, error: (err as Error).message });
    }
  });

  // ── #231 User Management Routes ──────────────────────────────────────────

  /**
   * GET /api/users/me — return the authenticated user's profile.
   */
  app.get('/api/users/me', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const user = getUserById(ctx.user_id, ctx.tenant_id);
    if (!user) {
      // Authenticated (local single-operator mode or a legacy token) but no
      // users-table row. Same {user} envelope as the normal branch so clients
      // parse a single shape.
      return reply.send({
        user: {
          id: ctx.user_id,
          tenant_id: ctx.tenant_id,
          email: null,
          name: null,
          avatar_url: null,
          auth_provider: 'local',
          role: ctx.user_id === 'local-user' ? 'admin' : 'viewer',
        },
      });
    }
    return reply.send({ user });
  });

  /**
   * PATCH /api/users/me — update name or avatar_url.
   */
  app.patch('/api/users/me', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const body = (request.body || {}) as Record<string, unknown>;
    const input: Parameters<typeof updateUser>[2] = {};
    if ('name' in body) input.name = body.name as string | null;
    if ('avatar_url' in body) input.avatar_url = body.avatar_url as string | null;

    const updated = updateUser(ctx.user_id, ctx.tenant_id, input);
    if (!updated) return reply.code(404).send({ success: false, error: 'User not found' });
    return reply.send({ user: updated });
  });

  /**
   * GET /api/users — list all users (admin only).
   */
  app.get('/api/users', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const query = request.query as Record<string, string>;
    const limit = Math.min(Number(query.limit) || 50, 500);
    const offset = Number(query.offset) || 0;
    const users = listUsers(tenantId, limit, offset);
    return reply.send({ users, limit, offset });
  });

  /**
   * POST /api/users — create a local user (admin only).
   */
  app.post('/api/users', async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = AdminCreateUserBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const email = normalizeEmail(parsed.data.email);
    const generatedPassword = parsed.data.password === undefined ? generateOneTimePassword() : null;
    const plainPassword = parsed.data.password ?? generatedPassword!;
    const passwordPolicyError = validatePasswordPolicy(plainPassword);
    if (passwordPolicyError) {
      return reply.code(400).send({ success: false, error: passwordPolicyError });
    }

    try {
      const passwordHash = await hashPassword(plainPassword);
      const user = createLocalUser({
        tenant_id: ctx.tenant_id,
        email,
        name: parsed.data.name,
        password_hash: passwordHash,
        role: parsed.data.role,
      });
      assignRole(ctx.tenant_id, user.id, parsed.data.role, ctx.user_id);
      logAudit({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        action: 'user.create',
        resource_type: 'user',
        resource_id: user.id,
        details: { email: user.email, role: parsed.data.role, generated_password: generatedPassword !== null },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });
      return reply.send({
        success: true,
        user,
        ...(generatedPassword ? { generated_password: generatedPassword } : {}),
      });
    } catch (err) {
      if (err instanceof DuplicateUserError) {
        return reply.code(409).send({ success: false, code: 'duplicate_email', error: 'Email is already registered' });
      }
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin user create failed');
      return reply.code(500).send({ success: false, error: 'User creation failed' });
    }
  });

  /**
   * PATCH /api/users/:id — update role, status, or password (admin only).
   */
  app.patch('/api/users/:id', async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };

    const parsed = AdminPatchUserBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }

    const existing = getUserById(id, ctx.tenant_id);
    if (!existing) return reply.code(404).send({ success: false, error: 'User not found' });

    if (parsed.data.role !== undefined) {
      assignRole(ctx.tenant_id, id, parsed.data.role, ctx.user_id);
      updateUserRoleColumn(id, ctx.tenant_id, parsed.data.role);
    }

    if (parsed.data.new_password !== undefined) {
      const passwordPolicyError = validatePasswordPolicy(parsed.data.new_password);
      if (passwordPolicyError) {
        return reply.code(400).send({ success: false, error: passwordPolicyError });
      }
      updateUserPasswordHash(id, ctx.tenant_id, await hashPassword(parsed.data.new_password));
      logAudit({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        action: 'auth.password',
        resource_type: 'user',
        resource_id: id,
        details: { admin_reset: true },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });
    }

    if (parsed.data.status !== undefined) {
      updateUserStatus(id, ctx.tenant_id, parsed.data.status);
      if (parsed.data.status === 'disabled') {
        const revoked = revokeAllUserRefreshTokens(id, ctx.tenant_id);
        logAudit({
          tenant_id: ctx.tenant_id,
          user_id: ctx.user_id,
          action: 'user.disable',
          resource_type: 'user',
          resource_id: id,
          details: { revoked_refresh_tokens: revoked },
          ip_address: request.ip,
          user_agent: request.headers['user-agent'],
          outcome: 'success',
        });
      } else {
        logAudit({
          tenant_id: ctx.tenant_id,
          user_id: ctx.user_id,
          action: 'user.update',
          resource_type: 'user',
          resource_id: id,
          details: { status: parsed.data.status },
          ip_address: request.ip,
          user_agent: request.headers['user-agent'],
          outcome: 'success',
        });
      }
    }

    if (parsed.data.allowed_models !== undefined) {
      let allowedModels: string[] | null;
      try {
        allowedModels = validateKnownModelGrant(parsed.data.allowed_models);
      } catch (err) {
        return reply.code(400).send({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
      updateUserAllowedModels(id, ctx.tenant_id, allowedModels);
      logAudit({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        action: 'entitlement.update',
        resource_type: 'user',
        resource_id: id,
        details: { allowed_models: allowedModels },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });
    }

    const user = getUserById(id, ctx.tenant_id);
    return reply.send({ success: true, user });
  });

  /**
   * DELETE /api/users/:id — delete a user (admin only).
   */
  app.delete('/api/users/:id', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };

    if (id === ctx.user_id) {
      return reply.code(400).send({ success: false, error: 'Cannot delete your own account' });
    }

    revokeAllUserRefreshTokens(id, ctx.tenant_id);
    const deleted = deleteUser(id, ctx.tenant_id, ctx.user_id);
    if (!deleted) return reply.code(404).send({ success: false, error: 'User not found' });
    return reply.send({ success: true });
  });

  // ── #232 Refresh Token Routes ────────────────────────────────────────────

  /**
   * POST /api/auth/refresh
   * Exchange a refresh token cookie for a fresh access + refresh token pair.
   * Public route (uses refresh cookie, not access token).
   */
  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: rlCfg.auth_rpm, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const cookies = (request as { cookies?: Record<string, string | undefined> }).cookies;
    const rawRefreshToken = cookies?.[REFRESH_COOKIE_NAME]?.trim();
    if (!rawRefreshToken) {
      return reply.code(401).send({ success: false, error: 'No refresh token cookie' });
    }

    const activeRefreshToken = getActiveRefreshToken(rawRefreshToken);
    if (!activeRefreshToken) {
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth/refresh' });
      return reply.code(401).send({ success: false, error: 'Invalid or expired refresh token' });
    }
    const refreshUser = getUserById(activeRefreshToken.user_id, activeRefreshToken.tenant_id);
    if (refreshUser?.status === 'disabled') {
      revokeRefreshToken(rawRefreshToken, activeRefreshToken.tenant_id);
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth/refresh' });
      reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
      logAudit({
        tenant_id: activeRefreshToken.tenant_id,
        user_id: activeRefreshToken.user_id,
        action: 'auth.fail',
        resource_type: 'refresh_token',
        resource_id: activeRefreshToken.id,
        details: { reason: 'user_disabled' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(403).send({ success: false, error: 'Account disabled' });
    }
    // Rotation mints a FRESH access token, so a refresh cookie outliving its
    // account is worse than a stale access cookie: it renews the ghost forever.
    // Revoke instead of rotating once nobody answers to the subject.
    if (!refreshUser && !subjectStillExists(activeRefreshToken.user_id, activeRefreshToken.tenant_id)) {
      revokeRefreshToken(rawRefreshToken, activeRefreshToken.tenant_id);
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth/refresh' });
      reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
      logAudit({
        tenant_id: activeRefreshToken.tenant_id,
        user_id: activeRefreshToken.user_id,
        action: 'auth.fail',
        resource_type: 'refresh_token',
        resource_id: activeRefreshToken.id,
        details: { reason: 'subject_gone' },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'failure',
      });
      return reply.code(401).send({ success: false, error: 'Invalid or expired refresh token' });
    }

    const pair = rotateRefreshToken(
      rawRefreshToken,
      jwtSecret,
      (userId, tenantId) => {
        const user = getUserById(userId, tenantId);
        const role = resolveRole(tenantId, userId, user ? [user.role] : []);
        return { tenant_id: tenantId, email: user?.email, role, roles: [role] };
      },
      request.headers['user-agent'] as string,
      refreshTtlSeconds,
    );

    if (!pair) {
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth/refresh' });
      return reply.code(401).send({ success: false, error: 'Invalid or expired refresh token' });
    }

    setBrowserAuthCookies(reply, request, pair, refreshTtlSeconds);

    return reply.send({ success: true, expires_in: ACCESS_TOKEN_TTL_SECONDS });
  });

  // ── #233 Onboarding Routes ───────────────────────────────────────────────

  /**
   * GET /api/onboarding/status — check if the authenticated user has completed onboarding.
   */
  app.get('/api/onboarding/status', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const status = getOnboardingStatus(ctx.user_id, ctx.tenant_id);
    return reply.send(status);
  });

  /**
   * POST /api/onboarding/complete — mark onboarding complete, initialize workspace.
   */
  app.post('/api/onboarding/complete', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const status = completeOnboarding(ctx.user_id, ctx.tenant_id);
    return reply.send({ success: true, status });
  });

  /**
   * GET /api/users/me/preferences — list user preferences.
   */
  app.get('/api/users/me/preferences', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const prefs = getUserPreferences(ctx.user_id, ctx.tenant_id);
    return reply.send({ preferences: prefs });
  });

  /**
   * PUT /api/users/me/preferences/:key — set a preference.
   */
  app.put('/api/users/me/preferences/:key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { key } = request.params as { key: string };
    const body = (request.body || {}) as Record<string, unknown>;
    const value = body.value;
    if (typeof value !== 'string') {
      return reply.code(400).send({ success: false, error: 'Body must have "value" string field' });
    }
    setUserPreference(ctx.user_id, ctx.tenant_id, key, value);
    return reply.send({ success: true, key, value });
  });

  /**
   * DELETE /api/users/me/preferences/:key — remove a preference.
   */
  app.delete('/api/users/me/preferences/:key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { key } = request.params as { key: string };
    const deleted = deleteUserPreference(ctx.user_id, ctx.tenant_id, key);
    return reply.send({ success: deleted });
  });

  // ── #234 SAML 2.0 Routes ─────────────────────────────────────────────────

  /**
   * GET /api/auth/saml/login — SP-initiated SSO, redirects to IdP.
   */
  app.get('/api/auth/saml/login', {
    config: { rateLimit: { max: rlCfg.auth_rpm, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const samlSpCfg = config.security.saml_sp as Parameters<typeof generateSpMetadata>[0] | undefined;
    if (!samlSpCfg?.idp_sso_url) {
      return reply.code(501).send({ success: false, error: 'SAML SP not configured' });
    }

    // Optionally auto-fetch IdP metadata if idp_metadata_url is set
    let effectiveCfg = samlSpCfg;
    if ((samlSpCfg as { idp_metadata_url?: string }).idp_metadata_url && !samlSpCfg.idp_sso_url) {
      try {
        const meta = await fetchIdpMetadata((samlSpCfg as { idp_metadata_url: string }).idp_metadata_url);
        effectiveCfg = { ...samlSpCfg, idp_entity_id: meta.entity_id, idp_sso_url: meta.sso_url, idp_certificate: meta.certificate };
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'SAML: failed to fetch IdP metadata');
      }
    }

    try {
      const query = request.query as Record<string, string>;
      const relayState = query.relay_state;
      const redirectUrl = generateAuthnRequestUrl(effectiveCfg, relayState);
      return reply.redirect(redirectUrl);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'SAML: login initiation failed');
      return reply.code(500).send({ success: false, error: (err as Error).message });
    }
  });

  /**
   * POST /api/auth/saml/acs — Assertion Consumer Service endpoint.
   * Receives POST from IdP with base64-encoded SAMLResponse.
   */
  app.post('/api/auth/saml/acs', {
    config: { rateLimit: { max: rlCfg.auth_rpm, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const samlSpCfg = config.security.saml_sp as Parameters<typeof validateSamlResponse>[1] | undefined;
    if (!samlSpCfg) {
      return reply.code(501).send({ success: false, error: 'SAML SP not configured' });
    }

    const body = (request.body || {}) as Record<string, string>;
    const samlResponse = body.SAMLResponse?.trim();
    if (!samlResponse) {
      return reply.code(400).send({ success: false, error: 'Missing SAMLResponse field' });
    }

    try {
      const result = validateSamlResponse(samlResponse, samlSpCfg);
      const { userInfo, issuer } = result;

      // JIT provision user from SAML assertion
      const tenantId = 'default'; // In multi-tenant setups, derive from IdP entity_id mapping
      const user = findOrCreateUser({
        tenant_id: tenantId,
        email: userInfo.email,
        name: userInfo.name,
        auth_provider: `saml:${issuer}`,
        provider_id: userInfo.name_id,
      });

      const pair = issueTokenPair(user.id, tenantId, jwtSecret, {
        email: user.email,
        role: user.role,
        tenant_id: tenantId,
      }, request.headers['user-agent'] as string, refreshTtlSeconds);

      logAudit({
        tenant_id: tenantId,
        user_id: user.id,
        action: 'auth.login',
        resource_type: 'user',
        resource_id: user.id,
        details: { provider: 'saml', issuer, name_id: hashAssertion(userInfo.name_id) },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'] as string,
        outcome: 'success',
      });

      setBrowserAuthCookies(reply, request, pair, refreshTtlSeconds);

      logger.info({ userId: user.id, issuer }, 'SAML login successful');

      // RelayState redirect if provided
      const relayState = body.RelayState;
      const redirectTo = (relayState && relayState.startsWith('/')) ? relayState : '/';
      return reply.redirect(redirectTo);
    } catch (err) {
      logger.warn({ err: (err as Error).message, responseHash: hashAssertion(samlResponse) }, 'SAML ACS validation failed');
      logAudit({
        action: 'auth.fail',
        resource_type: 'api',
        resource_id: '/api/auth/saml/acs',
        details: { error: (err as Error).message },
        ip_address: request.ip,
        outcome: 'failure',
      });
      return reply.code(400).send({ success: false, error: (err as Error).message });
    }
  });

  /**
   * GET /api/auth/saml/metadata — SP metadata XML (for IdP configuration).
   */
  app.get('/api/auth/saml/metadata', async (request, reply) => {
    const samlSpCfg = config.security.saml_sp as Parameters<typeof generateSpMetadata>[0] | undefined;
    if (!samlSpCfg?.entity_id) {
      return reply.code(501).send({ success: false, error: 'SAML SP not configured' });
    }

    const xml = generateSpMetadata(samlSpCfg);
    return reply.type('application/xml').send(xml);
  });

  // ── #236 Tenant Config Routes ─────────────────────────────────────────────

  /**
   * GET /api/config/tenant — list all config overrides for the authenticated tenant.
   */
  app.get('/api/config/tenant', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const overrides = listTenantOverrides(tenantId);
    return reply.send({ overrides });
  });

  /**
   * GET /api/config/tenant/:key — get a single tenant config override.
   */
  app.get('/api/config/tenant/:key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const { key } = request.params as { key: string };
    const value = getTenantConfig(tenantId, key);
    if (value === null) {
      return reply.code(404).send({ success: false, error: 'Config key not found' });
    }
    return reply.send({ key, value });
  });

  /**
   * PUT /api/config/tenant/:key — set a tenant config override.
   */
  app.put('/api/config/tenant/:key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const { key } = request.params as { key: string };
    const body = (request.body || {}) as Record<string, unknown>;
    if (typeof body.value !== 'string') {
      return reply.code(400).send({ success: false, error: 'Body must have "value" string field' });
    }
    setTenantConfig(tenantId, key, body.value, ctx?.user_id);
    return reply.send({ success: true, key, value: body.value });
  });

  /**
   * DELETE /api/config/tenant/:key — delete a tenant config override.
   */
  app.delete('/api/config/tenant/:key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const { key } = request.params as { key: string };
    const deleted = deleteTenantConfig(tenantId, key);
    return reply.send({ success: deleted });
  });

  app.get('/api/coding-workers', async (_request, reply) => {
    const registry = getDefaultWorkerAdapterRegistry();
    const workers = await Promise.all(detectCodingWorkers().map(async (probe) => {
      const adapter = registry.get(probe.id);
      if (!adapter) throw new Error(`Coding worker adapter is not registered: ${probe.id}`);
      const preflight = await inspectWorkerAdapterLaneReadiness(adapter, 'code');
      const installed = preflight.checks.find((check) => check.id === 'command')?.ok === true;
      const authed = preflight.checks.find((check) => check.id === 'auth')?.ok === true;
      const ready = preflight.status === 'ready';
      return {
        id: probe.id,
        installed,
        authed,
        ready,
        commandPath: preflight.command_path,
        remediation: ready ? null : !installed ? probe.installHint : !authed ? probe.authHint : preflight.summary,
      };
    }));
    const config = getConfig().coding_worker ?? { routing: 'auto' as const, available: [] as CodingWorkerId[] };
    return reply.send({ workers, config });
  });

  app.put('/api/coding-workers', async (request, reply) => {
    const parsed = CodingWorkerConfigBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }
    const raw = readConfigWithLegacyFallback(getConfigPath()).config;
    raw.coding_worker = parsed.data;
    writeConfigObject(getConfigPath(), raw);
    const config = loadConfig(getConfigPath()).coding_worker!;
    return reply.send({ config });
  });

  // ── #237 Tenant API Key Routes ────────────────────────────────────────────

  /**
   * GET /api/keys — list stored API key metadata (no secrets) for the authenticated tenant.
   */
  app.get('/api/keys', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const keys = listTenantApiKeys(tenantId);
    return reply.send({ keys });
  });

  /**
   * POST /api/keys/:provider — upsert an API key for a provider.
   */
  app.post('/api/keys/:provider', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string; user_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { provider } = request.params as { provider: string };
    const body = (request.body || {}) as Record<string, unknown>;
    if (typeof body.key !== 'string' || !body.key.trim()) {
      return reply.code(400).send({ success: false, error: 'Body must have "key" string field' });
    }
    const masterSecret = resolveTenantMasterSecret({ createIfMissing: true });
    if (!masterSecret) {
      return reply.code(500).send({ success: false, error: 'Unable to initialize tenant API key encryption' });
    }
    upsertTenantApiKey(ctx.tenant_id, provider, body.key, masterSecret, ctx.user_id);
    return reply.send({ success: true, provider });
  });

  /**
   * DELETE /api/keys/:provider — delete an API key for a provider.
   */
  app.delete('/api/keys/:provider', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const { provider } = request.params as { provider: string };
    const deleted = deleteTenantApiKey(tenantId, provider);
    return reply.send({ success: deleted });
  });

  /**
   * GET /api/models/roles — current model role slots for Settings.
   */
  app.get('/api/models/roles', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    return reply.send(getModelRolesForTenant(tenantId));
  });

  /**
   * PATCH /api/models/roles — update one or more model role slots.
   *
   * Admin-only, enforced centrally: `requiredRoleForApiRoute` (api-auth.ts) maps
   * every non-GET on this path to 'admin', so the preHandler rejects before the
   * handler runs. Do not add a second gate here — see the test that pins it.
   */
  app.patch('/api/models/roles', async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });

    const parsed = ModelRolesPatchBodySchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.message });
    }

    try {
      if (parsed.data.brain) {
        validateChatModelRole('brain', parsed.data.brain);
        validateRequestedModelAllowed(ctx, parsed.data.brain.model);
      }
      if (parsed.data.light) {
        validateChatModelRole('light', parsed.data.light);
        validateRequestedModelAllowed(ctx, parsed.data.light.model);
      }
      if (parsed.data.step) {
        validateChatModelRole('step', parsed.data.step);
        validateRequestedModelAllowed(ctx, parsed.data.step.model);
      }
      if (parsed.data.plan_summary) {
        validateChatModelRole('plan_summary', parsed.data.plan_summary);
        validateRequestedModelAllowed(ctx, parsed.data.plan_summary.model);
      }
      // Embedding has a separate capability catalog. Chat model discovery and
      // entitlements must never leak GPT/MiniMax chat models into memory search.

      const raw = readConfigWithLegacyFallback(getConfigPath()).config;

      if (parsed.data.brain) {
        const brain = ensureRawConfigRecord(raw, 'brain');
        brain.model = parsed.data.brain.model;
        const modelRouter = ensureRawConfigRecord(raw, 'model_router');
        modelRouter.brain_provider = parsed.data.brain.provider;
      }

      if (parsed.data.light) {
        const models = ensureRawConfigRecord(raw, 'models');
        models.light = {
          provider: parsed.data.light.provider,
          model: parsed.data.light.model,
        };
      }

      if (parsed.data.step !== undefined || parsed.data.plan_summary !== undefined) {
        const modelRouter = ensureRawConfigRecord(raw, 'model_router');
        const roles = ensureRawConfigRecord(modelRouter, 'roles');
        for (const roleName of ['step', 'plan_summary'] as const) {
          const role = parsed.data[roleName];
          if (role === undefined) continue;
          if (role === null) delete roles[roleName];
          else roles[roleName] = { provider: role.provider, model: role.model };
        }
      }

      if (parsed.data.embedding) {
        const memory = ensureRawConfigRecord(raw, 'memory');
        const embedding = ensureRawConfigRecord(memory, 'embedding');
        const previousProvider = typeof embedding.provider === 'string' ? embedding.provider : 'auto';
        embedding.provider = parsed.data.embedding.provider;
        if (previousProvider !== parsed.data.embedding.provider) {
          // These values describe a provider-specific embedding space. Keeping
          // an Ollama URL/dimension after switching to OpenAI (or auto) silently
          // routes requests to the wrong endpoint and corrupts the index.
          delete embedding.base_url;
          delete embedding.api_key;
          delete embedding.dimensions;
        }
        if (parsed.data.embedding.model !== undefined) {
          embedding.model = parsed.data.embedding.model;
        } else if (parsed.data.embedding.provider === 'auto' || parsed.data.embedding.provider === 'none') {
          delete embedding.model;
        }
      }

      writeConfigObject(getConfigPath(), raw);
      loadConfig(getConfigPath());
      clearModelRouterCache();
      if (parsed.data.embedding) resetMemoryEmbeddingProviderCache();

      return reply.send({
        success: true,
        roles: getModelRolesForTenant(ctx.tenant_id),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ error: message }, 'Model roles update rejected');
      if (err instanceof ModelNotAllowedError) {
        return reply.code(403).send({ success: false, code: err.code, error: message });
      }
      return reply.code(400).send({ success: false, error: message });
    }
  });

  /**
   * GET /api/providers — provider + model catalog for the Settings UI, plus the
   * current brain selection. Reuses the native provider registry (providers.ts).
   */
  app.get('/api/providers', async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const allowedModels = ctx ? resolveAllowedModels(ctx.tenant_id, ctx.user_id).models : null;
    const storedKeys = new Set(listTenantApiKeys(tenantId).map((entry) => entry.provider));
    const raw = readConfigWithLegacyFallback(getConfigPath()).config;
    const rawProviders = raw.providers as Record<string, { apikey?: string; baseurl?: string }> | undefined;
    const manualModels = ((raw.model_discovery as Record<string, unknown> | undefined)?.manual_models ?? {}) as Record<string, string[]>;
    const persistedModels = ((raw.model_discovery as Record<string, unknown> | undefined)?.models ?? {}) as Record<string, string[]>;
    const persistedFetchedAt = ((raw.model_discovery as Record<string, unknown> | undefined)?.fetched_at ?? {}) as Record<string, string>;
    const configuredBrainProvider = String((raw.model_router as Record<string, unknown> | undefined)?.brain_provider ?? '');
    const masterSecret = resolveTenantMasterSecret();
    const cliProbes = detectCodingWorkers();
    const readyCliProviders = detectReadyCliProviderIds(cliProbes);
    const cliProbeByProvider = new Map(cliProbes.map(probe => [
      probe.id === 'claude_code' ? 'claude-cli' : 'codex-cli',
      probe,
    ]));
    const providers = await Promise.all(getChatRoleEligibleProviders().map(async (provider) => {
      const apiKey = resolveRuntimeApiKey(provider.id, {
        configProviders: rawProviders,
        tenantId,
        ...(masterSecret ? { masterSecret } : {}),
      });
      const hasKey = provider.apiMode === 'cli-pipe'
        ? readyCliProviders.has(provider.id)
        : storedKeys.has(provider.id) || !!apiKey || !!resolveApiKey(provider.id, rawProviders);
      const codexProbe = provider.id === 'codex-cli' ? cliProbeByProvider.get(provider.id) : undefined;
      const codexModels = codexProbe?.installed && codexProbe.authorized && codexProbe.commandPath
        ? await discoverCodexCliModels(codexProbe.commandPath)
        : null;
      let discovery: ModelDiscoveryResult = codexModels
        ? {
            supported: true,
            source: 'live',
            fetchedAt: new Date().toISOString(),
            capabilityConfidence: 'provider',
            models: codexModels.map(model => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              supportsTools: false,
              supportsVision: model.supportsVision,
            })),
          }
        : provider.apiMode === 'cli-pipe'
        ? {
            supported: true,
            source: 'catalog',
            fetchedAt: null,
            capabilityConfidence: 'catalog',
            models: provider.models.map((model) => ({ id: model.id })),
          }
        : hasKey || provider.id === configuredBrainProvider
        ? await discoverProviderModels({
            provider,
            baseUrl: resolveBaseUrl(provider.id, process.env, rawProviders),
            apiKey,
            tenantId,
            timeoutMs: provider.apiMode === 'ollama-native' ? 500 : 3_000,
          })
        : {
            supported: provider.apiMode !== 'bedrock-converse-stream',
            source: 'catalog',
            fetchedAt: null,
            capabilityConfidence: 'catalog',
            fallbackReason: 'provider_not_configured',
            models: [],
          };
      if (discovery.models.length === 0 && (persistedModels[provider.id]?.length ?? 0) > 0) {
        const manualIds = new Set(manualModels[provider.id] ?? []);
        discovery = {
          supported: discovery.supported,
          source: 'cache',
          fetchedAt: persistedFetchedAt[provider.id] ?? null,
          capabilityConfidence: 'conservative',
          fallbackReason: discovery.fallbackReason,
          models: persistedModels[provider.id].filter(id => !manualIds.has(id)).map(id => ({ id })),
        };
      }
      return {
        id: provider.id,
        name: provider.name,
        apiMode: provider.apiMode,
        apiType: provider.apiMode,
        defaultModel: provider.defaultModel,
        hint: provider.apiMode === 'cli-pipe'
          ? (() => {
            const probe = cliProbeByProvider.get(provider.id);
            if (!probe?.installed) return `${provider.name} is not installed. ${probe?.installHint ?? ''}`.trim();
            if (!probe.authorized) return `${provider.name} is installed but not authenticated. ${probe.authHint}`.trim();
            return provider.hint ?? null;
          })()
          : provider.hint ?? null,
        brainEligible: isChatRoleEligibleProvider(provider),
        lightEligible: isChatRoleEligibleProvider(provider),
        embeddingEligible: ['openai', 'ollama'].includes(provider.id),
        hasKey,
        discovery: {
          supported: discovery.supported,
          source: discovery.source,
          fetched_at: discovery.fetchedAt,
          capability_confidence: discovery.capabilityConfidence,
          fallback_reason: discovery.fallbackReason ?? null,
        },
        models: await buildProviderModels(provider, allowedModels, discovery, manualModels[provider.id] ?? []),
      };
    }));
    const discoveryConfig = ensureRawConfigRecord(raw, 'model_discovery');
    const registeredModels = ensureRawConfigRecord(discoveryConfig, 'models');
    const fetchedAtByProvider = ensureRawConfigRecord(discoveryConfig, 'fetched_at');
    let discoveryConfigChanged = false;
    for (const provider of providers) {
      const existing = Array.isArray(registeredModels[provider.id]) ? registeredModels[provider.id] as string[] : [];
      const discovered = provider.models
        .filter(model => model.source === 'live' || model.source === 'cache')
        .map(model => model.id);
      const merged = provider.apiMode === 'cli-pipe'
        ? discovered
        : Array.from(new Set([...existing, ...discovered]));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        registeredModels[provider.id] = merged;
        discoveryConfigChanged = true;
      }
      if (provider.discovery.source === 'live' && provider.discovery.fetched_at && fetchedAtByProvider[provider.id] !== provider.discovery.fetched_at) {
        fetchedAtByProvider[provider.id] = provider.discovery.fetched_at;
        discoveryConfigChanged = true;
      }
    }
    if (discoveryConfigChanged) writeConfigObject(getConfigPath(), raw);
    const current = {
      provider: (raw.model_router as Record<string, unknown> | undefined)?.brain_provider ?? null,
      model: (raw.brain as Record<string, unknown> | undefined)?.model ?? null,
    };
    return reply.send({ providers, current });
  });

  /**
   * POST /api/brain — set the brain provider + model. Mirrors the CLI wizard's
   * native `runBrainUpdate`: write brain.model + model_router.brain_provider to
   * the config file. brain.model is NOT hot-updatable, so it applies on restart.
   */
  app.post('/api/brain', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const body = (request.body || {}) as { provider?: string; model?: string };
    const provider = getProvider(String(body.provider ?? ''));
    if (!provider) return reply.code(400).send({ success: false, error: 'Unknown provider' });
    if (!isChatRoleEligibleProvider(provider)) {
      return reply.code(400).send({ success: false, error: 'Provider is not eligible for the brain role' });
    }
    if (provider.apiMode === 'cli-pipe' && !detectReadyCliProviderIds().has(provider.id)) {
      return reply.code(400).send({ success: false, error: 'Provider CLI is not installed and authenticated' });
    }
    const existing = readConfigWithLegacyFallback(getConfigPath()).config;
    const registered = ((existing.model_discovery as Record<string, unknown> | undefined)?.models ?? {}) as Record<string, string[]>;
    const requestedModel = String(body.model ?? '');
    const cliModelAllowed = provider.apiMode !== 'cli-pipe'
      || provider.models.some(model => model.id === requestedModel)
      || registered[provider.id]?.includes(requestedModel);
    const model = cliModelAllowed
      ? resolveRuntimeModel(provider.id, requestedModel, { allowUnknown: registered[provider.id]?.includes(requestedModel) })
      : undefined;
    if (!model) return reply.code(400).send({ success: false, error: 'Invalid model for provider' });

    if (!existing.brain) existing.brain = {};
    (existing.brain as Record<string, unknown>).model = model.id;
    if (!existing.model_router) existing.model_router = {};
    (existing.model_router as Record<string, unknown>).brain_provider = provider.id;
    writeConfigObject(getConfigPath(), existing);

    return reply.send({
      success: true,
      current: { provider: provider.id, model: model.id },
      restart_required: true,
    });
  });

  /**
   * GET /api/providers/:id/models/live — query OpenAI-compatible provider model
   * listings with the tenant-resolved key and enrich usable chat model IDs.
   */
  app.get('/api/providers/:id/models/live', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const provider = getProvider(id);
    if (!provider) {
      return reply.code(404).send({ success: false, reason: 'unknown_provider', error: 'Unknown provider' });
    }
    if (provider.id === 'codex-cli') {
      const probe = detectCodingWorkers().find(candidate => candidate.id === 'codex_cli');
      if (!probe?.installed || !probe.authorized || !probe.commandPath) {
        return reply.code(400).send({ success: false, reason: 'cli_not_ready', error: 'Codex CLI is not installed and authenticated' });
      }
      const models = await discoverCodexCliModels(probe.commandPath);
      const raw = readConfigWithLegacyFallback(getConfigPath()).config;
      const discoveryConfig = ensureRawConfigRecord(raw, 'model_discovery');
      const registeredModels = ensureRawConfigRecord(discoveryConfig, 'models');
      const fetchedAtByProvider = ensureRawConfigRecord(discoveryConfig, 'fetched_at');
      const fetchedAt = new Date().toISOString();
      registeredModels[provider.id] = models.map(model => model.id);
      fetchedAtByProvider[provider.id] = fetchedAt;
      writeConfigObject(getConfigPath(), raw);
      return reply.send({
        success: true,
        provider: provider.id,
        source: 'live',
        fetched_at: fetchedAt,
        fallback_reason: null,
        models: models.map(model => ({
          id: model.id,
          name: model.name,
          bundled: false,
          resolvable: true,
          capability_confidence: 'provider',
          metadata: {
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            supportsTools: false,
            supportsVision: model.supportsVision,
          },
        })),
      });
    }
    if (provider.apiMode === 'cli-pipe') {
      return reply.code(404).send({ success: false, reason: 'live_discovery_unsupported', error: 'Provider does not expose live model discovery' });
    }
    const raw = readConfigWithLegacyFallback(getConfigPath()).config;
    const rawProviders = raw.providers as Record<string, { apikey?: string; baseurl?: string }> | undefined;
    const masterSecret = resolveTenantMasterSecret();
    const apiKey = resolveRuntimeApiKey(id, {
      configProviders: rawProviders,
      tenantId: ctx.tenant_id,
      ...(masterSecret ? { masterSecret } : {}),
    });
    if (!apiKey && provider.apiMode !== 'ollama-native') {
      return reply.code(400).send({ success: false, reason: 'missing_api_key', error: 'No API key configured for this provider' });
    }
    const discovery = await discoverProviderModels({
      provider,
      baseUrl: resolveBaseUrl(id, process.env, rawProviders),
      apiKey,
      tenantId: ctx.tenant_id,
      force: true,
      timeoutMs: 10_000,
    });
    if (!discovery.supported) {
      return reply.code(404).send({ success: false, reason: discovery.fallbackReason, error: 'Provider does not expose a supported model-list API' });
    }
    if (discovery.source === 'catalog' && discovery.models.length === 0) {
      return reply.code(502).send({ success: false, reason: 'provider_models_request_failed', error: discovery.fallbackReason ?? 'Provider model discovery failed' });
    }
    const bundledIds = new Set(provider.models.map(model => model.id));
    const models = await Promise.all(discovery.models.map(async (model) => ({
      id: model.id,
      name: model.name ?? model.id,
      bundled: bundledIds.has(model.id),
      resolvable: Boolean(resolveRuntimeModel(provider.id, model.id, { allowUnknown: true })),
      capability_confidence: getModel(provider.id, model.id) ? 'catalog' : discovery.capabilityConfidence,
      metadata: { ...(await enrich(provider.id, model.id) ?? {}), ...model },
    })));
    return reply.send({
      success: true,
      provider: provider.id,
      source: discovery.source,
      fetched_at: discovery.fetchedAt,
      fallback_reason: discovery.fallbackReason ?? null,
      models,
    });
  });

  /** Persist a provider-scoped manual model ID for APIs that cannot enumerate models. */
  app.post('/api/providers/:id/models/manual', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const provider = getProvider(id);
    if (!provider || !isChatRoleEligibleProvider(provider)) {
      return reply.code(400).send({ success: false, error: 'Unknown or ineligible provider' });
    }
    if (provider.apiMode === 'cli-pipe') {
      return reply.code(400).send({ success: false, error: 'CLI provider models are owned by the installed CLI' });
    }
    const modelId = String((request.body as { model?: unknown } | null)?.model ?? '').trim();
    if (!isSafeCustomModelId(modelId)) {
      return reply.code(400).send({ success: false, error: 'Invalid model ID' });
    }
    const raw = readConfigWithLegacyFallback(getConfigPath()).config;
    const discoveryConfig = ensureRawConfigRecord(raw, 'model_discovery');
    const registeredModels = ensureRawConfigRecord(discoveryConfig, 'models');
    const manualModels = ensureRawConfigRecord(discoveryConfig, 'manual_models');
    const registered = Array.isArray(registeredModels[id]) ? registeredModels[id] as string[] : [];
    const existing = Array.isArray(manualModels[id]) ? manualModels[id] as string[] : [];
    registeredModels[id] = Array.from(new Set([...registered, modelId]));
    manualModels[id] = Array.from(new Set([...existing, modelId]));
    writeConfigObject(getConfigPath(), raw);
    return reply.send({
      success: true,
      provider: id,
      model: serializeCatalogModel(resolveRuntimeModel(id, modelId, { allowUnknown: true })!, true, true, null, 'manual', 'conservative'),
    });
  });

  /**
   * POST /api/providers/:id/check — live connection test for a provider, using
   * the native health checker (a tiny real request). Answers "is this key
   * actually working?" rather than merely "is a key present?".
   */
  app.post('/api/providers/:id/check', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ ok: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const provider = getProvider(id);
    if (!provider) return reply.code(400).send({ ok: false, error: 'Unknown provider' });

    const raw = readConfigWithLegacyFallback(getConfigPath()).config;
    const rawProviders = raw.providers as Record<string, { apikey?: string; baseurl?: string }> | undefined;
    const masterSecret = resolveTenantMasterSecret();
    const apiKey = resolveRuntimeApiKey(id, {
      configProviders: rawProviders,
      tenantId: ctx.tenant_id,
      ...(masterSecret ? { masterSecret } : {}),
    }) ?? '';
    if (!apiKey && provider.apiMode !== 'cli-pipe') {
      return reply.send({ ok: false, error: 'No API key configured for this provider' });
    }

    const body = (request.body || {}) as { model?: string };
    const registered = ((raw.model_discovery as Record<string, unknown> | undefined)?.models ?? {}) as Record<string, string[]>;
    const modelId = (body.model && resolveRuntimeModel(id, body.model, { allowUnknown: registered[id]?.includes(body.model) }) ? body.model : null) ?? provider.defaultModel;

    try {
      const { checkProviderHealth } = await import('../onboarding/index.js');
      const ok = await checkProviderHealth({
        id: provider.id,
        name: provider.name,
        apiKey,
        baseUrl: resolveBaseUrl(id, process.env, rawProviders),
        models: [{ id: modelId, name: modelId, provider: provider.id }],
        healthy: false,
      });
      return reply.send({ ok, model: modelId });
    } catch (err) {
      return reply.send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Web search key (SEARCH1API_KEY) — powers the runtime web_search and
   * web_fetch tools. Stored in the encrypted secret store; previously only
   * settable via CLI onboarding.
   */
  app.get('/api/search-key', async (_request, reply) => {
    const masterKey = resolveMasterKey();
    let stored: string | null = null;
    if (masterKey) {
      try {
        stored = getSecret('SEARCH1API_KEY', masterKey);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Unable to read stored SEARCH1API_KEY');
      }
    }
    const configured = !!(process.env.SEARCH1API_KEY?.trim() || stored?.trim());
    return reply.send({ configured });
  });

  app.post('/api/search-key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const body = (request.body || {}) as { key?: string };
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) return reply.code(400).send({ success: false, error: 'Body must have a non-empty "key"' });
    const masterKey = resolveMasterKey() ?? generateMasterKey();
    try {
      setSecret('SEARCH1API_KEY', key, masterKey);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Unable to store SEARCH1API_KEY');
      return reply.code(500).send({ success: false, error: 'Unable to store SEARCH1API_KEY' });
    }
    // Apply live so web_search / web_fetch work without a restart.
    process.env.SEARCH1API_KEY = key;
    return reply.send({ success: true, configured: true });
  });

  // ── API Services — non-model service credentials (web search, future MCP) ──

  /**
   * GET /api/services — list non-model service providers grouped by category,
   * each with a `configured` flag (no secrets returned). For the search
   * category, also reports the resolved active provider.
   */
  app.get('/api/services', async (_request, reply) => {
    const masterKey = resolveMasterKey();
    const isConfigured = (envVar: string): boolean => {
      if (process.env[envVar]?.trim()) return true;
      if (!masterKey) return false;
      try {
        return !!getSecret(envVar, masterKey)?.trim();
      } catch {
        return false;
      }
    };
    const providers = SERVICE_PROVIDERS.map((p) => ({
      id: p.id,
      category: p.category,
      name: p.name,
      hint: p.hint,
      docsUrl: p.docsUrl,
      supportsFetch: p.supportsFetch,
      configured: isConfigured(p.envVar),
    }));
    const active = resolveActiveSearchProvider();
    return reply.send({ providers, activeSearchProvider: active?.id ?? null });
  });

  /**
   * POST /api/services/:id/key — store an API key for a service provider.
   */
  app.post('/api/services/:id/key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const provider = getServiceProvider(id);
    if (!provider) return reply.code(404).send({ success: false, error: `Unknown service provider: ${id}` });
    const body = (request.body || {}) as { key?: string };
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) return reply.code(400).send({ success: false, error: 'Body must have a non-empty "key"' });
    const masterKey = resolveMasterKey() ?? generateMasterKey();
    try {
      setSecret(provider.envVar, key, masterKey);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), provider: id }, 'Unable to store service key');
      return reply.code(500).send({ success: false, error: `Unable to store ${provider.envVar}` });
    }
    // Apply live so the capability works without a restart.
    process.env[provider.envVar] = key;
    // First search provider configured becomes active automatically.
    if (provider.category === 'search' && !resolveActiveSearchProvider()) {
      process.env.MOZI_SEARCH_PROVIDER = provider.id;
      setSecret('MOZI_SEARCH_PROVIDER', provider.id, masterKey);
    }
    return reply.send({ success: true, id, configured: true });
  });

  /**
   * DELETE /api/services/:id/key — remove a service provider's API key.
   */
  app.delete('/api/services/:id/key', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const { id } = request.params as { id: string };
    const provider = getServiceProvider(id);
    if (!provider) return reply.code(404).send({ success: false, error: `Unknown service provider: ${id}` });
    const masterKey = resolveMasterKey();
    let deleted = false;
    if (masterKey) {
      try {
        deleted = deleteSecret(provider.envVar, masterKey);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), provider: id }, 'Unable to delete service key');
      }
    }
    delete process.env[provider.envVar];
    // If the active search provider was removed, fall back to the next configured one.
    if (provider.category === 'search' && process.env.MOZI_SEARCH_PROVIDER === provider.id) {
      const next = resolveActiveSearchProvider();
      if (next) {
        process.env.MOZI_SEARCH_PROVIDER = next.id;
        if (masterKey) setSecret('MOZI_SEARCH_PROVIDER', next.id, masterKey);
      } else {
        delete process.env.MOZI_SEARCH_PROVIDER;
        if (masterKey) { try { deleteSecret('MOZI_SEARCH_PROVIDER', masterKey); } catch { /* ignore */ } }
      }
    }
    return reply.send({ success: deleted });
  });

  /**
   * POST /api/services/search/active — set the active search provider.
   */
  app.post('/api/services/search/active', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    if (!ctx) return reply.code(401).send({ success: false, error: 'Not authenticated' });
    const body = (request.body || {}) as { id?: string };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const provider = SEARCH_PROVIDERS.find((p) => p.id === id);
    if (!provider) return reply.code(404).send({ success: false, error: `Unknown search provider: ${id}` });
    if (!process.env[provider.envVar]?.trim()) {
      return reply.code(400).send({ success: false, error: `${provider.name} has no key configured` });
    }
    process.env.MOZI_SEARCH_PROVIDER = provider.id;
    const masterKey = resolveMasterKey() ?? generateMasterKey();
    try {
      setSecret('MOZI_SEARCH_PROVIDER', provider.id, masterKey);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Unable to persist active search provider');
    }
    return reply.send({ success: true, activeSearchProvider: provider.id });
  });

  // ── #238 Quota Routes ─────────────────────────────────────────────────────

  /**
   * GET /api/quotas — get quota status for the authenticated tenant.
   */
  app.get('/api/quotas', async (request, reply) => {
    const ctx = (request as { tenantContext?: { tenant_id: string } }).tenantContext;
    const tenantId = ctx?.tenant_id ?? 'default';
    const status = getQuotaStatus(tenantId);
    return reply.send({ quotas: status });
  });

  /**
   * PUT /api/quotas/:tenantId — set a quota limit for a tenant (admin only).
   */
  app.put('/api/quotas/:tenantId', {
    preHandler: [requireRole('admin')],
  }, async (request, reply) => {
    const ctx = (request as { tenantContext?: ApiTenantContext }).tenantContext;
    const { tenantId: targetTenantId } = request.params as { tenantId: string };
    const body = (request.body || {}) as Record<string, unknown>;

    if ('resource' in body || 'limit' in body) {
      if (typeof body.resource !== 'string' || typeof body.limit !== 'number') {
        return reply.code(400).send({ success: false, error: 'Body must have "resource" (string) and "limit" (number) fields' });
      }
      setQuotaLimit(targetTenantId, body.resource, body.limit);
      return reply.send({ success: true, tenantId: targetTenantId, resource: body.resource, limit: body.limit });
    }

    const parsed = TenantQuotaUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: validationErrorMessage(parsed.error) });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ success: false, error: 'At least one quota field must be provided' });
    }

    const current = getQuota(targetTenantId);
    let allowedModels = current.allowed_models;
    if (parsed.data.allowed_models !== undefined) {
      try {
        allowedModels = validateKnownModelGrant(parsed.data.allowed_models) ?? [];
      } catch (err) {
        return reply.code(400).send({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const quota = setQuota({
      ...current,
      ...parsed.data,
      allowed_models: allowedModels,
      tenant_id: targetTenantId,
    });
    if (parsed.data.allowed_models !== undefined) {
      logAudit({
        tenant_id: targetTenantId,
        user_id: ctx?.user_id,
        action: 'entitlement.update',
        resource_type: 'tenant',
        resource_id: targetTenantId,
        details: { allowed_models: parsed.data.allowed_models },
        ip_address: request.ip,
        user_agent: request.headers['user-agent'],
        outcome: 'success',
      });
    }
    return reply.send({ success: true, quota });
  });
}

// ---------------------------------------------------------------------------
// Static file serving for Web UI
// ---------------------------------------------------------------------------

export async function registerStaticServing(
  app: FastifyInstance,
  uiDistPath: string,
): Promise<void> {
  await app.register(fastifyStatic, {
    root: uiDistPath,
    prefix: '/',
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/ws') || req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const urlPath = req.url.split('?')[0];
    if (/\.\w+$/.test(urlPath)) {
      let relativePath: string;
      try {
        relativePath = decodeURIComponent(urlPath).replace(/^\/+/, '');
      } catch {
        return reply.code(400).send({ error: 'Invalid path' });
      }
      const absolutePath = resolve(uiDistPath, relativePath);
      const inRoot = absolutePath === uiDistPath || absolutePath.startsWith(uiDistPath + sep);
      if (!inRoot) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        return reply.code(404).type('text/plain').send('Not found');
      }
      return reply.sendFile(relativePath);
    }
    return reply.sendFile('index.html');
  });
  logger.info({ path: uiDistPath }, 'Web UI enabled');
}
