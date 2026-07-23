/**
 * Tenant Resource Quotas — enforce per-tenant limits on tokens,
 * agents, tasks, storage, and skills.
 *
 * Quota data is stored in the SQLite tenant_quotas table (already in schema).
 * Soft limit at 80%, hard limit at 100%.
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { z } from 'zod';
import pino from 'pino';

const logger = pino({ name: 'mozi:tenants:quotas' });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TenantQuotaSchema = z.object({
  tenant_id: z.string(),
  // 0 = unlimited (self-hosted default). Set positive values for multi-tenant SaaS.
  daily_token_limit: z.number().int().nonnegative().default(0),
  monthly_token_limit: z.number().int().nonnegative().default(0),
  max_tokens_per_task: z.number().int().nonnegative().default(0),
  max_parallel_agents: z.number().int().positive().default(5),
  max_active_tasks: z.number().int().positive().default(20),
  max_storage_mb: z.number().int().positive().default(1024),
  max_skills: z.number().int().positive().default(50),
  allowed_models: z.array(z.string()).default([]),
  brain_model: z.string().default(''),
});

export type TenantQuota = z.infer<typeof TenantQuotaSchema>;

export type QuotaCheckResult = 'ok' | 'soft_limit' | 'hard_limit';

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Get the quota for a tenant. Returns defaults if no explicit quota is set.
 */
export function getQuota(tenantId: string): TenantQuota {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tenant_quotas WHERE tenant_id = ?').get(tenantId) as Record<string, unknown> | undefined;
  if (!row) {
    return TenantQuotaSchema.parse({ tenant_id: tenantId });
  }
  return deserializeQuota(row);
}

/**
 * Set or update the quota for a tenant.
 */
export function setQuota(input: Partial<TenantQuota> & { tenant_id: string }): TenantQuota {
  const quota = TenantQuotaSchema.parse(input);
  const db = getDb();

  db.prepare(`
    INSERT INTO tenant_quotas (
      tenant_id, daily_token_limit, monthly_token_limit, max_tokens_per_task,
      max_parallel_agents, max_active_tasks, max_storage_mb, max_skills, allowed_models, brain_model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      daily_token_limit = excluded.daily_token_limit,
      monthly_token_limit = excluded.monthly_token_limit,
      max_tokens_per_task = excluded.max_tokens_per_task,
      max_parallel_agents = excluded.max_parallel_agents,
      max_active_tasks = excluded.max_active_tasks,
      max_storage_mb = excluded.max_storage_mb,
      max_skills = excluded.max_skills,
      allowed_models = excluded.allowed_models,
      brain_model = excluded.brain_model
  `).run(
    quota.tenant_id,
    quota.daily_token_limit,
    quota.monthly_token_limit,
    quota.max_tokens_per_task,
    quota.max_parallel_agents,
    quota.max_active_tasks,
    quota.max_storage_mb,
    quota.max_skills,
    JSON.stringify(quota.allowed_models),
    quota.brain_model,
  );

  logEvent('quota_updated', 'tenant', quota.tenant_id, { quota }, quota.tenant_id);
  logger.info({ tenant_id: quota.tenant_id }, 'Tenant quota updated');
  return quota;
}

/**
 * Delete the quota for a tenant (reverts to defaults).
 */
export function deleteQuota(tenantId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tenant_quotas WHERE tenant_id = ?').run(tenantId);
  return result.changes > 0;
}

/**
 * List all configured quotas.
 */
export function listQuotas(): TenantQuota[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM tenant_quotas').all() as Record<string, unknown>[];
  return rows.map(deserializeQuota);
}

// ---------------------------------------------------------------------------
// Quota enforcement
// ---------------------------------------------------------------------------

/**
 * Check daily token quota for a tenant.
 * Compares current daily usage against the limit.
 *
 * @param tenantId - Tenant to check
 * @param currentDailyTokens - Tokens already consumed today
 * @param additionalTokens - Tokens about to be consumed
 */
export function checkDailyTokenQuota(
  tenantId: string,
  currentDailyTokens: number,
  additionalTokens: number,
): QuotaCheckResult {
  const quota = getQuota(tenantId);
  const projected = currentDailyTokens + additionalTokens;
  return checkThreshold(projected, quota.daily_token_limit);
}

/**
 * Check monthly token quota for a tenant.
 */
export function checkMonthlyTokenQuota(
  tenantId: string,
  currentMonthlyTokens: number,
  additionalTokens: number,
): QuotaCheckResult {
  const quota = getQuota(tenantId);
  const projected = currentMonthlyTokens + additionalTokens;
  return checkThreshold(projected, quota.monthly_token_limit);
}

/**
 * Check per-task token quota.
 */
export function checkTaskTokenQuota(
  tenantId: string,
  taskTokens: number,
): QuotaCheckResult {
  const quota = getQuota(tenantId);
  return checkThreshold(taskTokens, quota.max_tokens_per_task);
}

/**
 * Check parallel agent quota.
 */
export function checkParallelAgentsQuota(
  tenantId: string,
  currentAgentCount: number,
): QuotaCheckResult {
  const quota = getQuota(tenantId);
  return checkThreshold(currentAgentCount, quota.max_parallel_agents);
}

/**
 * Check active tasks quota.
 */
export function checkActiveTasksQuota(
  tenantId: string,
  currentTaskCount: number,
): QuotaCheckResult {
  const quota = getQuota(tenantId);
  return checkThreshold(currentTaskCount, quota.max_active_tasks);
}

/**
 * Check skills count quota.
 */
export function checkSkillsQuota(
  tenantId: string,
  currentSkillCount: number,
): QuotaCheckResult {
  const quota = getQuota(tenantId);
  return checkThreshold(currentSkillCount, quota.max_skills);
}

/**
 * Check if a model is allowed for a tenant.
 * Empty allowed_models list means all models are allowed.
 */
export function isModelAllowed(tenantId: string, model: string): boolean {
  const quota = getQuota(tenantId);
  if (quota.allowed_models.length === 0) return true;
  return quota.allowed_models.includes(model);
}

/**
 * Get the brain model for a tenant (empty string = use system default).
 */
export function getTenantBrainModel(tenantId: string): string {
  const quota = getQuota(tenantId);
  return quota.brain_model;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Threshold check: ok (< 80%), soft_limit (80-99%), hard_limit (>= 100%).
 */
function checkThreshold(current: number, limit: number): QuotaCheckResult {
  if (limit <= 0) return 'ok'; // Unlimited
  const ratio = current / limit;
  if (ratio >= 1.0) return 'hard_limit';
  if (ratio >= 0.8) return 'soft_limit';
  return 'ok';
}

function deserializeQuota(row: Record<string, unknown>): TenantQuota {
  let allowedModels: string[] = [];
  if (row.allowed_models) {
    try {
      allowedModels = JSON.parse(row.allowed_models as string);
    } catch {
      allowedModels = [];
    }
  }

  // Ensure max_skills column exists (migration-safe)
  const maxSkills = (row.max_skills as number) ?? 50;

  return {
    tenant_id: row.tenant_id as string,
    daily_token_limit: (row.daily_token_limit as number) ?? 0,
    monthly_token_limit: (row.monthly_token_limit as number) ?? 0,
    max_tokens_per_task: (row.max_tokens_per_task as number) ?? 0,
    max_parallel_agents: (row.max_parallel_agents as number) ?? 5,
    max_active_tasks: (row.max_active_tasks as number) ?? 20,
    max_storage_mb: (row.max_storage_mb as number) ?? 1024,
    max_skills: maxSkills,
    allowed_models: allowedModels,
    brain_model: (row.brain_model as string) ?? '',
  };
}
