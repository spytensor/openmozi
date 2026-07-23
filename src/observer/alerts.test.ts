import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  registerRule,
  removeRule,
  getRule,
  listRules,
  registerBuiltinRules,
  clearConditions,
  ensureTables,
  type AlertRule,
  type AlertContext,
} from './alerts.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  ensureTables();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM alert_rules').run();
  db.prepare('DELETE FROM alert_history').run();
  clearConditions();
});

describe('alerts', () => {
  describe('registerRule and listRules', () => {
    it('should register a rule and list it', () => {
      const rule: AlertRule = {
        id: 'test-rule-1',
        name: 'Test Rule',
        condition: (ctx) => ctx.metric_value > 100,
        severity: 'warning',
        actions: ['log', 'notify'],
        cooldown_seconds: 60,
        enabled: true,
      };

      const id = registerRule(rule);
      expect(id).toBe('test-rule-1');

      const rules = listRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe('test-rule-1');
      expect(rules[0].name).toBe('Test Rule');
      expect(rules[0].severity).toBe('warning');
      expect(rules[0].actions).toEqual(['log', 'notify']);
      expect(rules[0].cooldown_seconds).toBe(60);
      expect(rules[0].enabled).toBe(true);
      expect(rules[0].condition).toBeDefined();
    });

    it('should register multiple rules and list them in order', () => {
      registerRule({
        id: 'rule-a',
        name: 'Rule A',
        condition: () => true,
        severity: 'info',
        actions: ['log'],
        cooldown_seconds: 100,
        enabled: true,
      });
      registerRule({
        id: 'rule-b',
        name: 'Rule B',
        condition: () => false,
        severity: 'critical',
        actions: ['kill'],
        cooldown_seconds: 200,
        enabled: false,
      });

      const rules = listRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].name).toBe('Rule A');
      expect(rules[1].name).toBe('Rule B');
      expect(rules[1].enabled).toBe(false);
    });
  });

  describe('getRule', () => {
    it('should return a specific rule by id', () => {
      registerRule({
        id: 'get-me',
        name: 'Get Me',
        condition: (ctx) => ctx.metric_value > 50,
        severity: 'critical',
        actions: ['pause'],
        cooldown_seconds: 120,
        enabled: true,
      });

      const rule = getRule('get-me');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('get-me');
      expect(rule!.name).toBe('Get Me');
      expect(rule!.condition).toBeDefined();
    });

    it('should return null for non-existent rule', () => {
      const rule = getRule('non-existent');
      expect(rule).toBeNull();
    });
  });

  describe('removeRule', () => {
    it('should remove a rule and return true', () => {
      registerRule({
        id: 'remove-me',
        name: 'Remove Me',
        condition: () => true,
        severity: 'info',
        actions: ['log'],
        cooldown_seconds: 60,
        enabled: true,
      });

      expect(listRules()).toHaveLength(1);
      const removed = removeRule('remove-me');
      expect(removed).toBe(true);
      expect(listRules()).toHaveLength(0);
      expect(getRule('remove-me')).toBeNull();
    });

    it('should return false when removing non-existent rule', () => {
      const removed = removeRule('does-not-exist');
      expect(removed).toBe(false);
    });
  });

  describe('registerBuiltinRules', () => {
    it('should register 5 built-in rules', () => {
      const ids = registerBuiltinRules();
      expect(ids).toHaveLength(5);

      const rules = listRules();
      expect(rules).toHaveLength(5);

      const names = rules.map((r) => r.name);
      expect(names).toContain('Cost Spike');
      expect(names).toContain('Stuck Agent');
      expect(names).toContain('Retry Storm');
      expect(names).toContain('Budget Exceeded');
      expect(names).toContain('Success Rate Drop');
    });

    it('Cost Spike: fires when metric_value > 3 * historical_average', () => {
      registerBuiltinRules();
      const rule = getRule('builtin-cost-spike');
      expect(rule).not.toBeNull();
      expect(rule!.condition).toBeDefined();

      const ctx: AlertContext = {
        metric_name: 'token_cost',
        metric_value: 400,
        historical_average: 100,
        timestamp: Date.now(),
      };
      expect(rule!.condition!(ctx)).toBe(true);

      // Should NOT fire when value is under threshold
      const ctxLow: AlertContext = {
        metric_name: 'token_cost',
        metric_value: 200,
        historical_average: 100,
        timestamp: Date.now(),
      };
      expect(rule!.condition!(ctxLow)).toBe(false);

      // Should NOT fire when historical_average is 0
      const ctxZero: AlertContext = {
        metric_name: 'token_cost',
        metric_value: 400,
        historical_average: 0,
        timestamp: Date.now(),
      };
      expect(rule!.condition!(ctxZero)).toBe(false);
    });

    it('Stuck Agent: fires when agent_idle_seconds > 300', () => {
      registerBuiltinRules();
      const rule = getRule('builtin-stuck-agent');
      expect(rule!.condition).toBeDefined();

      expect(rule!.condition!({
        metric_name: 'agent_idle_seconds',
        metric_value: 400,
        timestamp: Date.now(),
      })).toBe(true);

      expect(rule!.condition!({
        metric_name: 'agent_idle_seconds',
        metric_value: 200,
        timestamp: Date.now(),
      })).toBe(false);

      // Wrong metric name should not fire
      expect(rule!.condition!({
        metric_name: 'other_metric',
        metric_value: 999,
        timestamp: Date.now(),
      })).toBe(false);
    });

    it('Retry Storm: fires when consecutive_failures > 5', () => {
      registerBuiltinRules();
      const rule = getRule('builtin-retry-storm');
      expect(rule!.condition).toBeDefined();

      expect(rule!.condition!({
        metric_name: 'consecutive_failures',
        metric_value: 6,
        timestamp: Date.now(),
      })).toBe(true);

      expect(rule!.condition!({
        metric_name: 'consecutive_failures',
        metric_value: 3,
        timestamp: Date.now(),
      })).toBe(false);
    });

    it('Budget Exceeded: fires when token_usage_ratio > 1.2', () => {
      registerBuiltinRules();
      const rule = getRule('builtin-budget-exceeded');
      expect(rule!.condition).toBeDefined();

      expect(rule!.condition!({
        metric_name: 'token_usage_ratio',
        metric_value: 1.5,
        timestamp: Date.now(),
      })).toBe(true);

      expect(rule!.condition!({
        metric_name: 'token_usage_ratio',
        metric_value: 1.0,
        timestamp: Date.now(),
      })).toBe(false);
    });

    it('Success Rate Drop: fires when success_rate < 0.4', () => {
      registerBuiltinRules();
      const rule = getRule('builtin-success-rate-drop');
      expect(rule!.condition).toBeDefined();

      expect(rule!.condition!({
        metric_name: 'success_rate',
        metric_value: 0.2,
        timestamp: Date.now(),
      })).toBe(true);

      expect(rule!.condition!({
        metric_name: 'success_rate',
        metric_value: 0.8,
        timestamp: Date.now(),
      })).toBe(false);
    });
  });
});
