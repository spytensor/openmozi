import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  getQuota,
  setQuota,
  deleteQuota,
  listQuotas,
  checkDailyTokenQuota,
  checkMonthlyTokenQuota,
  checkTaskTokenQuota,
  checkParallelAgentsQuota,
  checkActiveTasksQuota,
  checkSkillsQuota,
  isModelAllowed,
  getTenantBrainModel,
} from './quotas.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('tenants/quotas', () => {
  describe('getQuota', () => {
    it('returns defaults for unknown tenant', () => {
      const quota = getQuota('nonexistent-tenant');
      expect(quota.tenant_id).toBe('nonexistent-tenant');
      expect(quota.daily_token_limit).toBe(0); // 0 = unlimited (self-hosted default)
      expect(quota.max_parallel_agents).toBe(5);
      expect(quota.max_skills).toBe(50);
    });
  });

  describe('setQuota', () => {
    it('creates a new quota', () => {
      const quota = setQuota({
        tenant_id: 'tenant-a',
        daily_token_limit: 500_000,
        max_parallel_agents: 3,
        allowed_models: ['gpt-4', 'claude-sonnet'],
        brain_model: 'gpt-4',
      });

      expect(quota.tenant_id).toBe('tenant-a');
      expect(quota.daily_token_limit).toBe(500_000);
      expect(quota.max_parallel_agents).toBe(3);
      expect(quota.allowed_models).toEqual(['gpt-4', 'claude-sonnet']);
      expect(quota.brain_model).toBe('gpt-4');
    });

    it('updates existing quota', () => {
      setQuota({ tenant_id: 'tenant-b', daily_token_limit: 100_000 });
      const updated = setQuota({ tenant_id: 'tenant-b', daily_token_limit: 200_000 });
      expect(updated.daily_token_limit).toBe(200_000);
    });
  });

  describe('deleteQuota', () => {
    it('deletes existing quota', () => {
      setQuota({ tenant_id: 'tenant-del', daily_token_limit: 100 });
      expect(deleteQuota('tenant-del')).toBe(true);
    });

    it('returns false for nonexistent', () => {
      expect(deleteQuota('no-such-tenant')).toBe(false);
    });
  });

  describe('listQuotas', () => {
    it('lists all configured quotas', () => {
      const quotas = listQuotas();
      expect(Array.isArray(quotas)).toBe(true);
    });
  });

  describe('checkDailyTokenQuota', () => {
    it('returns ok when limit is 0 (unlimited)', () => {
      const result = checkDailyTokenQuota('nonexistent-unlimited', 999_999_999, 999_999_999);
      expect(result).toBe('ok');
    });

    it('returns ok when under 80%', () => {
      setQuota({ tenant_id: 'quota-daily', daily_token_limit: 1000 });
      expect(checkDailyTokenQuota('quota-daily', 500, 100)).toBe('ok');
    });

    it('returns soft_limit at 80%', () => {
      setQuota({ tenant_id: 'quota-daily-soft', daily_token_limit: 1000 });
      expect(checkDailyTokenQuota('quota-daily-soft', 800, 0)).toBe('soft_limit');
    });

    it('returns hard_limit at 100%', () => {
      setQuota({ tenant_id: 'quota-daily-hard', daily_token_limit: 1000 });
      expect(checkDailyTokenQuota('quota-daily-hard', 1000, 0)).toBe('hard_limit');
    });

    it('returns hard_limit when exceeding', () => {
      setQuota({ tenant_id: 'quota-daily-over', daily_token_limit: 1000 });
      expect(checkDailyTokenQuota('quota-daily-over', 900, 200)).toBe('hard_limit');
    });
  });

  describe('checkMonthlyTokenQuota', () => {
    it('returns ok when under limit', () => {
      setQuota({ tenant_id: 'quota-monthly', monthly_token_limit: 10000 });
      expect(checkMonthlyTokenQuota('quota-monthly', 5000, 1000)).toBe('ok');
    });
  });

  describe('checkTaskTokenQuota', () => {
    it('returns ok for small task', () => {
      setQuota({ tenant_id: 'quota-task', max_tokens_per_task: 50000 });
      expect(checkTaskTokenQuota('quota-task', 10000)).toBe('ok');
    });

    it('returns hard_limit when task exceeds limit', () => {
      setQuota({ tenant_id: 'quota-task-over', max_tokens_per_task: 50000 });
      expect(checkTaskTokenQuota('quota-task-over', 60000)).toBe('hard_limit');
    });
  });

  describe('checkParallelAgentsQuota', () => {
    it('returns ok when under limit', () => {
      setQuota({ tenant_id: 'quota-agents', max_parallel_agents: 5 });
      expect(checkParallelAgentsQuota('quota-agents', 3)).toBe('ok');
    });

    it('returns hard_limit at max', () => {
      setQuota({ tenant_id: 'quota-agents-max', max_parallel_agents: 5 });
      expect(checkParallelAgentsQuota('quota-agents-max', 5)).toBe('hard_limit');
    });
  });

  describe('checkActiveTasksQuota', () => {
    it('returns ok when under limit', () => {
      setQuota({ tenant_id: 'quota-tasks', max_active_tasks: 20 });
      expect(checkActiveTasksQuota('quota-tasks', 10)).toBe('ok');
    });
  });

  describe('checkSkillsQuota', () => {
    it('returns ok when under limit', () => {
      setQuota({ tenant_id: 'quota-skills', max_skills: 10 });
      expect(checkSkillsQuota('quota-skills', 5)).toBe('ok');
    });

    it('returns soft_limit at 80%', () => {
      setQuota({ tenant_id: 'quota-skills-soft', max_skills: 10 });
      expect(checkSkillsQuota('quota-skills-soft', 8)).toBe('soft_limit');
    });
  });

  describe('isModelAllowed', () => {
    it('allows all models when allowed_models is empty', () => {
      setQuota({ tenant_id: 'quota-models-empty', allowed_models: [] });
      expect(isModelAllowed('quota-models-empty', 'gpt-4')).toBe(true);
      expect(isModelAllowed('quota-models-empty', 'anything')).toBe(true);
    });

    it('restricts to allowed models', () => {
      setQuota({ tenant_id: 'quota-models', allowed_models: ['gpt-4', 'claude-sonnet'] });
      expect(isModelAllowed('quota-models', 'gpt-4')).toBe(true);
      expect(isModelAllowed('quota-models', 'claude-opus')).toBe(false);
    });
  });

  describe('getTenantBrainModel', () => {
    it('returns configured brain model', () => {
      setQuota({ tenant_id: 'quota-brain', brain_model: 'claude-opus' });
      expect(getTenantBrainModel('quota-brain')).toBe('claude-opus');
    });

    it('returns empty string when not set', () => {
      expect(getTenantBrainModel('unknown-tenant')).toBe('');
    });
  });
});
