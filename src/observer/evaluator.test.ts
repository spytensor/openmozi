import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  registerRule,
  clearConditions,
  ensureTables,
  type AlertRule,
  type AlertContext,
} from './alerts.js';
import {
  evaluate,
  executeActions,
  getAlertHistory,
  getLastAlertTime,
} from './evaluator.js';
import { getDb } from '../store/db.js';
import {
  clearRunningTurnsForTests,
  registerRunningTurn,
} from '../core/turn-cancellation.js';

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
  db.prepare('DELETE FROM event_log').run();
  db.prepare('DELETE FROM agent_registry').run();
  clearConditions();
  clearRunningTurnsForTests();
});

describe('evaluator', () => {
  const makeRule = (overrides?: Partial<AlertRule>): AlertRule => ({
    id: 'test-rule',
    name: 'Test Rule',
    condition: (ctx) => ctx.metric_value > 100,
    severity: 'warning',
    actions: ['log'],
    cooldown_seconds: 60,
    enabled: true,
    ...overrides,
  });

  describe('evaluate', () => {
    it('should fire matching rule and return alert', () => {
      registerRule(makeRule());

      const context: AlertContext = {
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
      };

      const alerts = evaluate(context);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].rule_id).toBe('test-rule');
      expect(alerts[0].rule_name).toBe('Test Rule');
      expect(alerts[0].severity).toBe('warning');
      expect(alerts[0].message).toContain('Test Rule');
      expect(alerts[0].message).toContain('cpu_usage');
    });

    it('should execute actions when a rule fires', () => {
      registerRule(makeRule({ actions: ['log'] }));

      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].enforcement_status).toBe('enforced');

      const db = getDb();
      const event = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'alert_fired' AND entity_id = ?"
      ).get(alerts[0].id);
      expect(event).toBeDefined();

      const history = getAlertHistory({ rule_id: 'test-rule' });
      expect(history[0].enforcement_status).toBe('enforced');
    });

    it('should mark untargeted kill actions as unenforced', () => {
      registerRule(makeRule({ actions: ['kill'], severity: 'critical' }));

      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].enforcement_status).toBe('unenforced');
      expect(alerts[0].enforcement_error).toContain('kill requires');

      const history = getAlertHistory({ rule_id: 'test-rule' });
      expect(history[0].enforcement_status).toBe('unenforced');
      expect(history[0].enforcement_error).toContain('kill requires');
    });

    it('should not fire when no rules match', () => {
      registerRule(makeRule());

      const context: AlertContext = {
        metric_name: 'cpu_usage',
        metric_value: 50, // below threshold
        timestamp: Date.now(),
      };

      const alerts = evaluate(context);
      expect(alerts).toHaveLength(0);
    });

    it('should respect cooldown — suppress repeated alerts', () => {
      registerRule(makeRule({ cooldown_seconds: 60 }));

      const now = Date.now();

      // First evaluation should fire
      const alerts1 = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: now,
      });
      expect(alerts1).toHaveLength(1);

      // Second evaluation within cooldown should be suppressed
      const alerts2 = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 200,
        timestamp: now + 10_000, // 10 seconds later — within 60s cooldown
      });
      expect(alerts2).toHaveLength(0);

      // Third evaluation after cooldown should fire
      const alerts3 = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 300,
        timestamp: now + 61_000, // 61 seconds later — past cooldown
      });
      expect(alerts3).toHaveLength(1);
    });

    it('should not fire disabled rules', () => {
      registerRule(makeRule({ enabled: false }));

      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 999,
        timestamp: Date.now(),
      });
      expect(alerts).toHaveLength(0);
    });

    it('should fire multiple matching rules', () => {
      registerRule(makeRule({ id: 'rule-1', name: 'Rule 1' }));
      registerRule(makeRule({
        id: 'rule-2',
        name: 'Rule 2',
        condition: (ctx) => ctx.metric_value > 50,
        severity: 'critical',
      }));

      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
      }, 'default', { executeActions: false });
      expect(alerts).toHaveLength(2);
    });
  });

  describe('executeActions', () => {
    it('should log to event_log for "log" action', () => {
      registerRule(makeRule({ actions: ['log'] }));
      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
      }, 'default', { executeActions: false });
      expect(alerts).toHaveLength(1);

      const notifications = executeActions(alerts[0]);
      expect(notifications).toHaveLength(0); // 'log' action doesn't produce notifications

      const db = getDb();
      const events = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'alert_fired'"
      ).all();
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('should return formatted message for "notify" action', () => {
      registerRule(makeRule({ actions: ['notify'] }));
      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
      });

      const notifications = executeActions(alerts[0]);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('[SYSTEM ALERT]');
      expect(notifications[0]).toContain('[WARNING]');
      expect(notifications[0]).toContain('Test Rule');
      expect(notifications[0]).toContain('cpu_usage=150');
    });

    it('should enforce pause by marking the target agent inactive', () => {
      getDb().prepare(`
        INSERT INTO agent_registry (id, tenant_id, name, type, status)
        VALUES ('agent-1', 'default', 'Agent 1', 'preset', 'active')
      `).run();
      registerRule(makeRule({ actions: ['pause'], severity: 'critical' }));
      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
        agent_id: 'agent-1',
      }, 'default', { executeActions: false });

      executeActions(alerts[0]);

      const db = getDb();
      const agent = db.prepare(
        "SELECT status FROM agent_registry WHERE id = 'agent-1'"
      ).get() as { status: string };
      expect(agent.status).toBe('inactive');
      const events = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'alert_pause_enforced'"
      ).all();
      expect(events.length).toBe(1);
    });

    it('should enforce kill by cancelling the targeted running turn', () => {
      const running = registerRunningTurn({
        turnId: 'turn-kill',
        tenantId: 'default',
        chatId: 'chat-1',
        userId: 'user-1',
      });
      registerRule(makeRule({ actions: ['kill'], severity: 'critical' }));
      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
        task_id: 'turn-kill',
      }, 'default', { executeActions: false });

      executeActions(alerts[0]);

      expect(running.signal.aborted).toBe(true);
      const db = getDb();
      const events = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'alert_kill_enforced'"
      ).all();
      expect(events.length).toBe(1);
    });

    it('should handle multiple actions at once', () => {
      getDb().prepare(`
        INSERT INTO agent_registry (id, tenant_id, name, type, status)
        VALUES ('agent-1', 'default', 'Agent 1', 'preset', 'active')
      `).run();
      registerRule(makeRule({ actions: ['log', 'notify', 'pause'] }));
      const alerts = evaluate({
        metric_name: 'cpu_usage',
        metric_value: 150,
        timestamp: Date.now(),
        agent_id: 'agent-1',
      }, 'default', { executeActions: false });

      const notifications = executeActions(alerts[0]);
      expect(notifications).toHaveLength(1); // only 'notify' produces notifications

      const db = getDb();
      const allEvents = db.prepare('SELECT * FROM event_log').all();
      // Should have: alert_rule_registered (from registerRule), alert_fired (log action),
      // alert_notification, alert_pause_enforced
      expect(allEvents.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('getAlertHistory', () => {
    it('should return empty array when no alerts exist', () => {
      const history = getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should return alerts ordered by created_at DESC', () => {
      registerRule(makeRule({ cooldown_seconds: 0 }));

      const now = Date.now();
      evaluate({ metric_name: 'x', metric_value: 200, timestamp: now });
      evaluate({ metric_name: 'y', metric_value: 300, timestamp: now + 1000 });

      const history = getAlertHistory();
      expect(history).toHaveLength(2);
      // Most recent first
      expect(new Date(history[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(history[1].created_at).getTime()
      );
    });

    it('should filter by rule_id', () => {
      registerRule(makeRule({ id: 'rule-a', name: 'A', cooldown_seconds: 0 }));
      registerRule(makeRule({ id: 'rule-b', name: 'B', cooldown_seconds: 0, condition: (ctx) => ctx.metric_value > 50 }));

      evaluate({ metric_name: 'x', metric_value: 200, timestamp: Date.now() });

      const historyA = getAlertHistory({ rule_id: 'rule-a' });
      expect(historyA).toHaveLength(1);
      expect(historyA[0].rule_id).toBe('rule-a');

      const historyB = getAlertHistory({ rule_id: 'rule-b' });
      expect(historyB).toHaveLength(1);
      expect(historyB[0].rule_id).toBe('rule-b');
    });

    it('should filter by severity', () => {
      registerRule(makeRule({ id: 'r1', severity: 'warning', cooldown_seconds: 0 }));
      registerRule(makeRule({ id: 'r2', severity: 'critical', cooldown_seconds: 0 }));

      evaluate({ metric_name: 'x', metric_value: 200, timestamp: Date.now() });

      const warnings = getAlertHistory({ severity: 'warning' });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].severity).toBe('warning');
    });

    it('should respect limit', () => {
      registerRule(makeRule({ cooldown_seconds: 0 }));

      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        evaluate({ metric_name: 'x', metric_value: 200 + i, timestamp: now + i * 1000 });
      }

      const limited = getAlertHistory({ limit: 3 });
      expect(limited).toHaveLength(3);
    });
  });

  describe('getLastAlertTime', () => {
    it('should return null when no alerts exist for the rule', () => {
      const time = getLastAlertTime('non-existent');
      expect(time).toBeNull();
    });

    it('should return timestamp of most recent alert for the rule', () => {
      registerRule(makeRule({ cooldown_seconds: 0 }));

      const now = Date.now();
      evaluate({ metric_name: 'x', metric_value: 200, timestamp: now });
      evaluate({ metric_name: 'x', metric_value: 300, timestamp: now + 5000 });

      const lastTime = getLastAlertTime('test-rule');
      expect(lastTime).not.toBeNull();
      // Should be close to now + 5000 (the more recent alert)
      expect(lastTime!).toBeGreaterThanOrEqual(now + 4000);
    });
  });
});
