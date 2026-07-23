/**
 * Model entitlements and token quota preflight.
 *
 * Model access is the tenant ceiling intersected with the user's grant. A
 * null model set means unrestricted at that level. Tenant empty arrays are
 * also unrestricted; user empty arrays are an explicit empty grant.
 */

import { getConfig } from '../config/index.js';
import { getDb } from '../store/db.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:security:entitlements' });

export type AllowedModelsSource =
  | 'personal_mode'
  | 'unrestricted'
  | 'tenant_ceiling'
  | 'user_grant'
  | 'intersection';

export interface AllowedModelsResolution {
  /** Null means all models are allowed. An empty array means no models are allowed. */
  models: string[] | null;
  source: AllowedModelsSource;
}

export class ModelNotAllowedError extends Error {
  public readonly code = 'model_not_allowed';
  public readonly tenantId: string;
  public readonly userId: string;
  public readonly modelId: string;
  public readonly allowedModels: string[] | null;

  constructor(tenantId: string, userId: string, modelId: string, allowedModels: string[] | null) {
    super(
      `Model "${modelId}" is not allowed for user "${userId}" in tenant "${tenantId}". Allowed models: ${formatAllowedModels(allowedModels)}.`,
    );
    this.name = 'ModelNotAllowedError';
    this.tenantId = tenantId;
    this.userId = userId;
    this.modelId = modelId;
    this.allowedModels = allowedModels;
  }
}

export type TokenQuotaLimit = 'daily' | 'monthly';

export class QuotaExceededError extends Error {
  public readonly code = 'quota_exceeded';
  public readonly tenantId: string;
  public readonly limit: TokenQuotaLimit;
  public readonly limitTokens: number;
  public readonly usedTokens: number;
  public readonly resetAt: string;

  constructor(input: {
    tenantId: string;
    limit: TokenQuotaLimit;
    limitTokens: number;
    usedTokens: number;
    resetAt: string;
  }) {
    super(
      `Token quota exceeded for tenant "${input.tenantId}": ${input.limit} limit ${input.limitTokens} tokens, already used ${input.usedTokens}. Resets at ${input.resetAt}.`,
    );
    this.name = 'QuotaExceededError';
    this.tenantId = input.tenantId;
    this.limit = input.limit;
    this.limitTokens = input.limitTokens;
    this.usedTokens = input.usedTokens;
    this.resetAt = input.resetAt;
  }
}

export interface TokenQuotaPrecheckResult {
  checked: boolean;
  dailyTokens: number;
  monthlyTokens: number;
}

/**
 * Resolve the effective model set for a tenant/user pair.
 *
 * Rules:
 * - tenant_quotas.allowed_models null or [] means all models at tenant level
 * - users.allowed_models null means inherit the tenant ceiling
 * - both unrestricted resolves to null, meaning all models are allowed
 * - two concrete sets resolve to their intersection, which may be empty
 */
export function resolveAllowedModels(tenantId: string, userId: string): AllowedModelsResolution {
  const normalizedTenantId = normalizeId(tenantId, 'default');
  const normalizedUserId = normalizeId(userId, '');
  const db = getDb();

  const tenantRow = db.prepare('SELECT allowed_models FROM tenant_quotas WHERE tenant_id = ?')
    .get(normalizedTenantId) as { allowed_models: string | null } | undefined;
  const tenantCeiling = parseModelArray(tenantRow?.allowed_models, { emptyMeansUnrestricted: true });

  if (isPersonalMode()) {
    return tenantCeiling === null
      ? { models: null, source: 'personal_mode' }
      : { models: tenantCeiling, source: 'tenant_ceiling' };
  }

  const userRow = normalizedUserId
    ? db.prepare('SELECT allowed_models FROM users WHERE tenant_id = ? AND id = ?')
      .get(normalizedTenantId, normalizedUserId) as { allowed_models: string | null } | undefined
    : undefined;
  const userGrant = parseModelArray(userRow?.allowed_models, { emptyMeansUnrestricted: false });

  if (tenantCeiling === null && userGrant === null) {
    return { models: null, source: 'unrestricted' };
  }
  if (tenantCeiling !== null && userGrant === null) {
    return { models: tenantCeiling, source: 'tenant_ceiling' };
  }
  if (tenantCeiling === null && userGrant !== null) {
    return { models: userGrant, source: 'user_grant' };
  }

  return {
    models: intersectModels(tenantCeiling ?? [], userGrant ?? []),
    source: 'intersection',
  };
}

export function isModelAllowed(tenantId: string, userId: string, modelId: string): boolean {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return true;
  const { models } = resolveAllowedModels(tenantId, userId);
  return models === null || models.includes(normalizedModelId);
}

export function assertModelAllowed(tenantId: string, userId: string, modelId: string): AllowedModelsResolution {
  const resolution = resolveAllowedModels(tenantId, userId);
  const normalizedModelId = modelId.trim();
  if (normalizedModelId && resolution.models !== null && !resolution.models.includes(normalizedModelId)) {
    throw new ModelNotAllowedError(tenantId, userId, normalizedModelId, resolution.models);
  }
  return resolution;
}

/**
 * Check tenant token quotas once at user-turn start.
 *
 * auth_mode=none and tenants without positive token limits are fast no-ops.
 * The caller should reuse this single result for the whole turn instead of
 * checking again for each tool-loop LLM iteration.
 */
export function precheckTenantTokenQuota(tenantId: string): TokenQuotaPrecheckResult {
  if (isPersonalMode()) {
    return { checked: false, dailyTokens: 0, monthlyTokens: 0 };
  }

  const normalizedTenantId = normalizeId(tenantId, 'default');
  const db = getDb();
  const quota = db.prepare(`
    SELECT daily_token_limit, monthly_token_limit
    FROM tenant_quotas
    WHERE tenant_id = ?
  `).get(normalizedTenantId) as {
    daily_token_limit: number | null;
    monthly_token_limit: number | null;
  } | undefined;

  if (!quota) {
    return { checked: false, dailyTokens: 0, monthlyTokens: 0 };
  }

  const dailyLimit = Math.max(0, Number(quota.daily_token_limit ?? 0));
  const monthlyLimit = Math.max(0, Number(quota.monthly_token_limit ?? 0));
  if (dailyLimit <= 0 && monthlyLimit <= 0) {
    return { checked: false, dailyTokens: 0, monthlyTokens: 0 };
  }

  const windows = quotaWindows(new Date());
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN created_at >= ? THEN input_tokens + output_tokens ELSE 0 END), 0) AS daily_tokens,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN input_tokens + output_tokens ELSE 0 END), 0) AS monthly_tokens
    FROM billing_records
    WHERE tenant_id = ?
      AND record_type = 'llm_call'
      AND created_at >= ?
  `).get(windows.dayStart, windows.monthStart, normalizedTenantId, windows.monthStart) as {
    daily_tokens: number;
    monthly_tokens: number;
  };

  const dailyTokens = Number(usage.daily_tokens ?? 0);
  const monthlyTokens = Number(usage.monthly_tokens ?? 0);
  if (dailyLimit > 0 && dailyTokens >= dailyLimit) {
    throw new QuotaExceededError({
      tenantId: normalizedTenantId,
      limit: 'daily',
      limitTokens: dailyLimit,
      usedTokens: dailyTokens,
      resetAt: windows.nextDayStart,
    });
  }
  if (monthlyLimit > 0 && monthlyTokens >= monthlyLimit) {
    throw new QuotaExceededError({
      tenantId: normalizedTenantId,
      limit: 'monthly',
      limitTokens: monthlyLimit,
      usedTokens: monthlyTokens,
      resetAt: windows.nextMonthStart,
    });
  }

  return { checked: true, dailyTokens, monthlyTokens };
}

function isPersonalMode(): boolean {
  try {
    return getConfig().server.auth_mode === 'none';
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Unable to resolve auth_mode for entitlements');
    return false;
  }
}

function normalizeId(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function parseModelArray(value: unknown, options: { emptyMeansUnrestricted: boolean }): string[] | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = uniqueStrings(parsed);
    if (models.length === 0 && options.emptyMeansUnrestricted) return null;
    return models;
  } catch {
    return null;
  }
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function intersectModels(ceiling: string[], grant: string[]): string[] {
  const grantSet = new Set(grant);
  return ceiling.filter(model => grantSet.has(model));
}

function formatAllowedModels(models: string[] | null): string {
  if (models === null) return 'all';
  if (models.length === 0) return 'none';
  return models.join(', ');
}

function quotaWindows(now: Date): {
  dayStart: string;
  monthStart: string;
  nextDayStart: string;
  nextMonthStart: string;
} {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    dayStart: toSqlDateTime(dayStart),
    monthStart: toSqlDateTime(monthStart),
    nextDayStart: nextDayStart.toISOString(),
    nextMonthStart: nextMonthStart.toISOString(),
  };
}

function toSqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
