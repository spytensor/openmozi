import { getDb } from '../store/db.js';
import { calculateCatalogCost, resolveModelPricing } from '../core/model-pricing.js';
import { refreshModelRegistry } from '../core/model-registry-enrichment.js';
import { getById } from '../store/task-dag.js';
import { loadTaskMetadata } from '../tasks/workspace.js';

export interface BillingRepriceResult {
  examined: number;
  repriced: number;
  exact: number;
  upper_bound: number;
  provider_inferred: number;
  attributed: number;
  unavailable: number;
}

interface RepriceRow {
  id: number;
  tenant_id: string;
  provider: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number;
  pricing_source: string;
  usage_status: string;
  user_id: string | null;
  task_id: string | null;
}

function taskOwnerUserId(taskId: string | null, tenantId: string): string | null {
  if (!taskId) return null;
  let currentId: string | null = taskId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const task = getById(currentId, tenantId);
    if (!task) return null;
    if (!task.parent_task_id) return loadTaskMetadata(task.id)?.user_id?.trim() || null;
    currentId = task.parent_task_id;
  }
  return null;
}

/**
 * Repair the historical wiring gap using the downloaded model cost map.
 * Old rows contain provider-reported input/output tokens, but pre-#556 rows did
 * not persist cache-token detail. Those rows receive a useful non-cached upper
 * bound instead of being discarded or presented as an exact billed amount.
 */
export function repriceBillingRecords(): BillingRepriceResult {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, tenant_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
      pricing_source, usage_status, user_id, task_id
    FROM billing_records WHERE record_type = 'llm_call' AND model IS NOT NULL
  `).all() as RepriceRow[];
  const result: BillingRepriceResult = { examined: rows.length, repriced: 0, exact: 0, upper_bound: 0, provider_inferred: 0, attributed: 0, unavailable: 0 };
  const update = db.prepare(`
    UPDATE billing_records SET provider = ?, cost_usd = ?, input_cost_per_million = ?,
      output_cost_per_million = ?, cache_read_cost_per_million = ?, cache_write_cost_per_million = ?, pricing_source = ?,
      usage_status = ?, price_version = ?, currency = 'usd' WHERE id = ?
  `);
  const attribute = db.prepare('UPDATE billing_records SET user_id = ? WHERE id = ? AND (user_id IS NULL OR user_id = \'\')');

  const transaction = db.transaction(() => {
    for (const row of rows) {
      if (!row.user_id) {
        const userId = taskOwnerUserId(row.task_id, row.tenant_id);
        if (userId && attribute.run(userId, row.id).changes > 0) result.attributed += 1;
      }
      const pricing = resolveModelPricing(row.provider ?? undefined, row.model);
      const provider = row.provider ?? pricing.provider ?? null;
      if (!row.provider && provider) result.provider_inferred += 1;
      const hasObservedUsage = row.input_tokens > 0 || row.output_tokens > 0;
      const usageStatus = row.usage_status === 'legacy_unverified'
        ? (hasObservedUsage ? 'legacy_provider_reported' : 'unavailable')
        : row.usage_status;

      if (pricing.source === 'unknown') {
        result.unavailable += 1;
        update.run(provider, row.pricing_source === 'provider_reported' ? row.cost_usd : 0, null, null, null, null,
          row.pricing_source === 'provider_reported' ? row.pricing_source : 'unknown', usageStatus, null, row.id);
        continue;
      }

      // These rows already carry a persisted price snapshot. Never rewrite
      // historical spend merely because the live catalog changes later.
      if (['catalog_calculated', 'catalog_upper_bound', 'provider_reported', 'provider_reconciled'].includes(row.pricing_source)) continue;
      const cacheDetailKnown = (row.cache_read_tokens !== null || pricing.cacheReadCost === undefined)
        && (row.cache_write_tokens !== null || pricing.cacheWriteCost === undefined || pricing.cacheWriteCost === 0);
      const cost = calculateCatalogCost({
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens ?? 0,
        cache_write_tokens: row.cache_write_tokens ?? 0,
      }, pricing);
      if (cost === null) {
        result.unavailable += 1;
        continue;
      }
      const source = cacheDetailKnown ? 'catalog_calculated' : 'catalog_upper_bound';
      update.run(provider, cost, pricing.inputCost, pricing.outputCost, pricing.cacheReadCost ?? null, pricing.cacheWriteCost ?? null,
        source, usageStatus, pricing.version ?? null, row.id);
      result.repriced += 1;
      if (cacheDetailKnown) result.exact += 1;
      else result.upper_bound += 1;
    }
  });
  transaction();
  return result;
}

export async function refreshPricingAndReprice(): Promise<BillingRepriceResult & { registry_available: boolean }> {
  const registry_available = await refreshModelRegistry();
  return { registry_available, ...repriceBillingRecords() };
}
