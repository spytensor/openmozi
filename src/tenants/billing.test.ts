import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { create } from '../core/llm.js';
import {
  recordLlmCall,
  recordToolCall,
  getTenantUsage,
  getAllTenantsUsage,
  getDailyTokenCount,
  getMonthlyTokenCount,
  getUsageAnalytics,
  resetTableFlag,
} from './billing.js';

let tmpDir: string;

function isSkippableLiveLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /credit balance|billing|quota|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|fetch failed|Could not resolve authentication method|API key/i.test(msg);
}

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  resetTableFlag();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('tenants/billing', () => {
  describe('recordLlmCall', () => {
    it('records an LLM call', () => {
      const result = recordLlmCall({
        tenant_id: 'billing-t1',
        model: 'gpt-4',
        input_tokens: 500,
        output_tokens: 200,
        cost_usd: 0.025,
        pricing_source: 'catalog_estimate',
        task_id: 'task-1',
        agent_id: 'agent-1',
      });
      expect(result.id).toBeGreaterThan(0);
    });

    it('persists user, provider, cache, outcome, latency, and pricing snapshots', () => {
      const result = recordLlmCall({
        tenant_id: 'billing-detail',
        user_id: 'user-1',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 750,
        cache_write_tokens: 125,
        cost_usd: 0.0012,
        input_cost_per_million: 0.4,
        output_cost_per_million: 1.6,
        cache_read_cost_per_million: 0.1,
        cache_write_cost_per_million: 0.5,
        pricing_source: 'catalog_estimate',
        usage_status: 'provider_reported',
        price_version: 'test-catalog:v1',
        outcome: 'partial',
        failure_category: 'AbortError',
        duration_ms: 321,
      });
      const row = getDb().prepare('SELECT * FROM billing_records WHERE id = ?').get(result.id) as Record<string, unknown>;
      expect(row).toMatchObject({
        user_id: 'user-1', provider: 'openai', model: 'gpt-4.1-mini',
        cache_read_tokens: 750, cache_write_tokens: 125, cache_write_cost_per_million: 0.5, pricing_source: 'catalog_estimate', usage_status: 'provider_reported',
        price_version: 'test-catalog:v1', currency: 'usd', outcome: 'partial',
        failure_category: 'AbortError', duration_ms: 321,
      });
    });

    it('records without optional fields', () => {
      const result = recordLlmCall({
        tenant_id: 'billing-t1',
        model: 'claude-sonnet',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.005,
      });
      expect(result.id).toBeGreaterThan(0);
    });

    it('records usage from a real cheap OpenAI model call when credentials are available', async (ctx) => {
      if (!process.env.OPENAI_API_KEY) {
        ctx.skip();
        return;
      }

      const tenantId = `billing-live-${Date.now()}`;
      const client = create('openai', { model: 'gpt-4.1-mini' });
      try {
        await client.chat(
          [{ role: 'user', content: 'Reply with ok.' }],
          { max_tokens: 50, billing: { tenantId } },
        );
      } catch (err) {
        if (isSkippableLiveLlmError(err)) {
          ctx.skip();
          return;
        }
        throw err;
      }

      const row = getDb().prepare(`
        SELECT input_tokens, output_tokens, cost_usd
        FROM billing_records
        WHERE tenant_id = ? AND model = 'gpt-4.1-mini'
        ORDER BY id DESC
        LIMIT 1
      `).get(tenantId) as { input_tokens: number; output_tokens: number; cost_usd: number } | undefined;
      expect(row).toBeTruthy();
      expect((row?.input_tokens ?? 0) + (row?.output_tokens ?? 0)).toBeGreaterThan(0);
      expect(row?.cost_usd ?? 0).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getUsageAnalytics', () => {
    it('uses one filtered slice for user, model, cache, outcome, and cost aggregates', () => {
      recordLlmCall({ tenant_id: 'analytics', user_id: 'u1', provider: 'openai', model: 'gpt-4.1', input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cost_usd: 0.01, pricing_source: 'catalog_estimate', outcome: 'success', duration_ms: 100 });
      recordLlmCall({ tenant_id: 'analytics', user_id: 'u1', provider: 'openai', model: 'gpt-4.1', input_tokens: 50, output_tokens: 10, cache_read_tokens: 0, cost_usd: 0.005, pricing_source: 'catalog_estimate', outcome: 'failure', duration_ms: 300 });
      recordLlmCall({ tenant_id: 'analytics', user_id: 'u2', provider: 'anthropic', model: 'claude', input_tokens: 200, output_tokens: 40, cost_usd: 0.03, pricing_source: 'catalog_estimate', outcome: 'success', duration_ms: 200 });

      const all = getUsageAnalytics('analytics', { from: '2000-01-01', to: '2999-12-31' });
      expect(all.summary).toMatchObject({ calls: 3, input_tokens: 350, output_tokens: 70, cache_read_tokens: 60, cache_reported_calls: 2, failed_calls: 1, cost_usd: 0.045 });
      expect(all.summary.cache_hit_rate).toBeCloseTo(60 / 150);
      expect(all.by_user).toHaveLength(2);
      expect(all.by_model).toHaveLength(2);

      const filtered = getUsageAnalytics('analytics', { user_id: 'u1', provider: 'openai', model: 'gpt-4.1', outcome: 'success', from: '2000-01-01', to: '2999-12-31' });
      expect(filtered.summary).toMatchObject({ calls: 1, success_calls: 1, input_tokens: 100, cache_read_tokens: 60, cost_usd: 0.01 });
      expect(filtered.rows).toHaveLength(1);
    });

    it('filters explicit unattributed user and provider records without assigning ownership', () => {
      recordLlmCall({ tenant_id: 'analytics', provider: 'openai', model: 'gpt-4.1', input_tokens: 10, output_tokens: 2, outcome: 'success' });
      recordLlmCall({ tenant_id: 'analytics', user_id: 'u1', model: 'legacy-model', input_tokens: 10, output_tokens: 2, outcome: 'success' });

      const unattributedUser = getUsageAnalytics('analytics', { user_id: '__unattributed__', from: '2000-01-01', to: '2999-12-31' });
      const unattributedProvider = getUsageAnalytics('analytics', { provider: '__unattributed__', from: '2000-01-01', to: '2999-12-31' });

      expect(unattributedUser.rows.every((row) => row.user_id === null)).toBe(true);
      expect(unattributedProvider.rows.every((row) => row.provider === null)).toBe(true);
    });

    it('keeps legacy placeholders out of verified outcomes, cost, cache, and latency', () => {
      const result = recordLlmCall({
        tenant_id: 'legacy-analytics', model: 'legacy-model', input_tokens: 100,
        output_tokens: 20, cache_read_tokens: 80, cost_usd: 9, pricing_source: 'unknown',
        outcome: 'success', duration_ms: 0,
      });
      getDb().prepare("UPDATE billing_records SET usage_status = 'legacy_unverified' WHERE id = ?").run(result.id);

      const all = getUsageAnalytics('legacy-analytics', { from: '2000-01-01', to: '2999-12-31' });
      expect(all.summary).toMatchObject({
        calls: 1, success_calls: 0, legacy_calls: 1, priced_calls: 0,
        cache_reported_calls: 0, cost_usd: 0, average_latency_ms: 0,
      });
      expect(all.summary.cache_hit_rate).toBeNull();

      const successOnly = getUsageAnalytics('legacy-analytics', {
        outcome: 'success', from: '2000-01-01', to: '2999-12-31',
      });
      expect(successOnly.summary.calls).toBe(0);
      expect(successOnly.rows).toHaveLength(0);
    });

    it('uses persisted legacy provider cache telemetry and counts real failed attempts without token usage', () => {
      const cached = recordLlmCall({
        tenant_id: 'historical-telemetry', model: 'gpt-cache', input_tokens: 100,
        output_tokens: 20, cache_read_tokens: 75, cache_write_tokens: 0, cost_usd: 0.01,
        pricing_source: 'catalog_calculated', usage_status: 'legacy_provider_reported', outcome: 'success',
      });
      expect(cached.id).toBeGreaterThan(0);
      recordLlmCall({
        tenant_id: 'historical-telemetry', model: 'gpt-cache', input_tokens: 0,
        output_tokens: 0, cost_usd: 0, pricing_source: 'catalog_calculated',
        usage_status: 'unavailable', outcome: 'failure', failure_category: 'AI_APICallError',
      });

      const all = getUsageAnalytics('historical-telemetry', { from: '2000-01-01', to: '2999-12-31' });
      expect(all.summary).toMatchObject({
        calls: 2,
        failed_calls: 1,
        cache_reported_calls: 1,
        cache_read_tokens: 75,
        cache_write_tokens: 0,
      });
      expect(all.summary.cache_hit_rate).toBeCloseTo(0.75);
    });
  });

  describe('recordToolCall', () => {
    it('records a tool call', () => {
      const result = recordToolCall({
        tenant_id: 'billing-t1',
        tool: 'shell',
        duration_ms: 1500,
        task_id: 'task-1',
      });
      expect(result.id).toBeGreaterThan(0);
    });
  });

  describe('getDailyTokenCount', () => {
    it('returns total tokens for today', () => {
      // Record some tokens
      recordLlmCall({
        tenant_id: 'billing-daily',
        model: 'gpt-4',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.01,
      });
      recordLlmCall({
        tenant_id: 'billing-daily',
        model: 'gpt-4',
        input_tokens: 200,
        output_tokens: 100,
        cost_usd: 0.02,
      });

      const count = getDailyTokenCount('billing-daily');
      expect(count).toBe(450); // 100+50+200+100
    });

    it('returns 0 for tenant with no records', () => {
      expect(getDailyTokenCount('no-records')).toBe(0);
    });
  });

  describe('getMonthlyTokenCount', () => {
    it('returns total tokens for current month', () => {
      recordLlmCall({
        tenant_id: 'billing-monthly',
        model: 'claude-sonnet',
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.05,
      });

      const count = getMonthlyTokenCount('billing-monthly');
      expect(count).toBe(1500);
    });
  });

  describe('getTenantUsage', () => {
    it('aggregates usage for a tenant', () => {
      // Record multiple calls
      recordLlmCall({
        tenant_id: 'billing-usage',
        model: 'gpt-4',
        input_tokens: 500,
        output_tokens: 200,
        cost_usd: 0.025,
        pricing_source: 'catalog_estimate',
      });
      recordLlmCall({
        tenant_id: 'billing-usage',
        model: 'claude-sonnet',
        input_tokens: 300,
        output_tokens: 100,
        cost_usd: 0.010,
        pricing_source: 'catalog_estimate',
      });
      recordToolCall({
        tenant_id: 'billing-usage',
        tool: 'shell',
        duration_ms: 500,
      });

      const usage = getTenantUsage('billing-usage', 'daily');
      expect(usage.tenant_id).toBe('billing-usage');
      expect(usage.total_input_tokens).toBe(800);
      expect(usage.total_output_tokens).toBe(300);
      expect(usage.total_tokens).toBe(1100);
      expect(usage.llm_calls).toBe(2);
      expect(usage.tool_calls).toBe(1);
      expect(usage.total_cost_usd).toBeCloseTo(0.035);
      expect(Object.keys(usage.cost_by_model).length).toBe(2);
    });

    it('returns zeros for empty tenant', () => {
      const usage = getTenantUsage('empty-tenant', 'daily');
      expect(usage.total_tokens).toBe(0);
      expect(usage.llm_calls).toBe(0);
    });
  });

  describe('getAllTenantsUsage', () => {
    it('aggregates across all tenants', () => {
      const usage = getAllTenantsUsage('daily');
      expect(usage.period).toContain('daily');
      expect(Array.isArray(usage.tenants)).toBe(true);
      expect(usage.totals.total_tokens).toBeGreaterThan(0);
    });
  });
});
