import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { getMoziHome } from '../paths.js';
import { clearModelRegistryEnrichmentCache } from '../core/model-registry-enrichment.js';
import { recordLlmCall, resetTableFlag } from './billing.js';
import { repriceBillingRecords } from './billing-reconciliation.js';
import { create } from '../store/task-dag.js';
import { persistTaskMetadata } from '../tasks/workspace.js';

let tmpDir: string;
let savedMoziHome: string | undefined;

beforeAll(() => {
  ({ tmpDir } = setupTestDb());
  savedMoziHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = tmpDir;
  resetTableFlag();
  const cacheDir = join(getMoziHome(), 'data', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'litellm-registry.json'), JSON.stringify({
    'gpt-test': {
      litellm_provider: 'openai',
      input_cost_per_token: 0.000001,
      cache_read_input_token_cost: 0.0000001,
      output_cost_per_token: 0.000002,
    },
  }));
  clearModelRegistryEnrichmentCache();
});

afterAll(() => {
  clearModelRegistryEnrichmentCache();
  teardownTestDb(tmpDir);
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
});

describe('billing reconciliation', () => {
  it('recovers provider and price while separating exact cost from an uncached upper bound', () => {
    const upper = recordLlmCall({ tenant_id: 't1', model: 'gpt-test', input_tokens: 1_000_000, output_tokens: 100_000, cost_usd: 99 });
    getDb().prepare("UPDATE billing_records SET usage_status = 'legacy_unverified', cache_read_tokens = NULL WHERE id = ?").run(upper.id);
    const exact = recordLlmCall({ tenant_id: 't1', provider: 'openai', model: 'gpt-test', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 800_000, cost_usd: 99 });

    const result = repriceBillingRecords();
    expect(result).toMatchObject({ repriced: 2, exact: 1, upper_bound: 1, provider_inferred: 1 });
    const rows = getDb().prepare('SELECT * FROM billing_records WHERE id IN (?, ?) ORDER BY id').all(upper.id, exact.id) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ provider: 'openai', pricing_source: 'catalog_upper_bound', usage_status: 'legacy_provider_reported', cost_usd: 1.2 });
    expect(rows[1]).toMatchObject({ pricing_source: 'catalog_calculated' });
    expect(Number(rows[1].cost_usd)).toBeCloseTo(0.48);
    expect(Number(rows[1].cache_read_cost_per_million)).toBeCloseTo(0.1);
  });

  it('repairs deterministic DAG usage attribution from the persisted plan owner', () => {
    const root = create({ tenant_id: 't1', title: 'Plan root' });
    const child = create({ tenant_id: 't1', parent_task_id: root.id, title: 'Plan step' });
    persistTaskMetadata(root.id, {
      task_id: root.id,
      title: root.title,
      objective: root.objective,
      status: root.status,
      created_at: root.created_at,
      workspace_path: '',
      user_id: 'owner-1',
    });
    const call = recordLlmCall({
      tenant_id: 't1', model: 'gpt-test', input_tokens: 10, output_tokens: 2,
      cost_usd: 0, task_id: child.id,
    });

    const result = repriceBillingRecords();
    expect(result.attributed).toBe(1);
    expect(getDb().prepare('SELECT user_id FROM billing_records WHERE id = ?').get(call.id)).toEqual({ user_id: 'owner-1' });
  });
});
