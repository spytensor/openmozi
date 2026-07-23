/**
 * Alert Rule Engine — defines, stores, and manages alert rules for the MOZI observer.
 *
 * Rules have two parts:
 * - A DB record (id, name, severity, actions, cooldown, enabled) persisted in alert_rules
 * - A runtime condition function kept in an in-memory Map (functions can't be stored in SQL)
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { z } from 'zod';

const logger = pino({ name: 'mozi:observer:alerts' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertAction = 'log' | 'notify' | 'pause' | 'kill';
export type AlertEnforcementStatus = 'not_attempted' | 'enforced' | 'partial' | 'unenforced';

export interface AlertContext {
  agent_id?: string;
  task_id?: string;
  metric_name: string;
  metric_value: number;
  historical_average?: number;
  timestamp: number;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: (context: AlertContext) => boolean;
  severity: AlertSeverity;
  actions: AlertAction[];
  cooldown_seconds: number;
  enabled: boolean;
}

export interface Alert {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: AlertSeverity;
  actions: AlertAction[];
  context: AlertContext;
  message: string;
  created_at: string;
  enforcement_status?: AlertEnforcementStatus;
  enforcement_error?: string | null;
  enforcement_results?: Array<{
    action: AlertAction;
    enforced: boolean;
    detail: string;
  }>;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const AlertActionSchema = z.enum(['log', 'notify', 'pause', 'kill']);

export const AlertRuleInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  severity: AlertSeveritySchema.default('info'),
  actions: z.array(AlertActionSchema).default(['log']),
  cooldown_seconds: z.number().int().min(0).default(300),
  enabled: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Runtime condition store (conditions can't be persisted to SQL)
// ---------------------------------------------------------------------------

const conditionMap = new Map<string, (context: AlertContext) => boolean>();
const builtinRulesBootstrappedByDb = new WeakMap<object, Set<string>>();

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

/** Ensure alert_rules and alert_history tables exist */
export function ensureTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      actions TEXT NOT NULL DEFAULT '["log"]',
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_history (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      severity TEXT NOT NULL,
      actions TEXT NOT NULL,
      context JSON NOT NULL,
      message TEXT NOT NULL,
      enforcement_status TEXT NOT NULL DEFAULT 'not_attempted',
      enforcement_error TEXT,
      enforcement_results JSON,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  try { db.exec(`ALTER TABLE alert_history ADD COLUMN enforcement_status TEXT NOT NULL DEFAULT 'not_attempted'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE alert_history ADD COLUMN enforcement_error TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE alert_history ADD COLUMN enforcement_results JSON`); } catch { /* exists */ }

  ensureBuiltinRulesRegisteredOnce('default');
}

function ensureBuiltinRulesRegisteredOnce(tenantId = 'default'): void {
  const db = getDb();
  let registeredTenants = builtinRulesBootstrappedByDb.get(db);
  if (!registeredTenants) {
    registeredTenants = new Set<string>();
    builtinRulesBootstrappedByDb.set(db, registeredTenants);
  }
  if (registeredTenants.has(tenantId)) return;

  registeredTenants.add(tenantId);
  try {
    registerBuiltinRules(tenantId);
  } catch (err) {
    registeredTenants.delete(tenantId);
    logger.warn({
      tenant_id: tenantId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Built-in alert rule bootstrap failed');
  }
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface AlertRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  severity: string;
  actions: string;
  cooldown_seconds: number;
  enabled: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register an alert rule. Persists metadata to DB, keeps condition in memory.
 * @returns The registered rule's id
 */
export function registerRule(rule: AlertRule, tenantId = 'default'): string {
  ensureTables();
  const db = getDb();
  const id = rule.id || randomUUID();

  db.prepare(`
    INSERT OR REPLACE INTO alert_rules (id, tenant_id, name, severity, actions, cooldown_seconds, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, rule.name, rule.severity, JSON.stringify(rule.actions), rule.cooldown_seconds, rule.enabled ? 1 : 0);

  conditionMap.set(id, rule.condition);

  logger.info({ rule_id: id, rule_name: rule.name, tenant_id: tenantId }, 'Alert rule registered');
  logEvent('alert_rule_registered', 'alert_rule', id, { name: rule.name, severity: rule.severity }, tenantId);

  return id;
}

/**
 * Remove an alert rule by id.
 */
export function removeRule(ruleId: string, tenantId = 'default'): boolean {
  ensureTables();
  const db = getDb();
  const result = db.prepare(`DELETE FROM alert_rules WHERE id = ? AND tenant_id = ?`).run(ruleId, tenantId);
  conditionMap.delete(ruleId);

  if (result.changes > 0) {
    logger.info({ rule_id: ruleId, tenant_id: tenantId }, 'Alert rule removed');
    logEvent('alert_rule_removed', 'alert_rule', ruleId, {}, tenantId);
    return true;
  }
  return false;
}

/**
 * Get a single rule's config (DB data + runtime condition if available).
 */
export function getRule(ruleId: string, tenantId = 'default'): (Omit<AlertRule, 'condition'> & { condition?: (ctx: AlertContext) => boolean }) | null {
  ensureTables();
  ensureBuiltinRulesRegisteredOnce(tenantId);
  const db = getDb();
  const row = db.prepare(`SELECT * FROM alert_rules WHERE id = ? AND tenant_id = ?`).get(ruleId, tenantId) as AlertRuleRow | undefined;
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    severity: row.severity as AlertSeverity,
    actions: JSON.parse(row.actions) as AlertAction[],
    cooldown_seconds: row.cooldown_seconds,
    enabled: row.enabled === 1,
    condition: conditionMap.get(row.id),
  };
}

/**
 * List all alert rules for a tenant.
 */
export function listRules(tenantId = 'default'): Array<Omit<AlertRule, 'condition'> & { condition?: (ctx: AlertContext) => boolean }> {
  ensureTables();
  ensureBuiltinRulesRegisteredOnce(tenantId);
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM alert_rules WHERE tenant_id = ? ORDER BY created_at ASC`).all(tenantId) as AlertRuleRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    severity: row.severity as AlertSeverity,
    actions: JSON.parse(row.actions) as AlertAction[],
    cooldown_seconds: row.cooldown_seconds,
    enabled: row.enabled === 1,
    condition: conditionMap.get(row.id),
  }));
}

/**
 * Get the runtime condition function for a rule (if registered).
 */
export function getCondition(ruleId: string): ((ctx: AlertContext) => boolean) | undefined {
  return conditionMap.get(ruleId);
}

/**
 * Clear all runtime conditions (useful for testing).
 */
export function clearConditions(): void {
  conditionMap.clear();
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

/**
 * Register the 5 built-in alert rules.
 * Returns the list of rule IDs that were registered.
 */
export function registerBuiltinRules(tenantId = 'default'): string[] {
  const rules: AlertRule[] = [
    {
      id: 'builtin-cost-spike',
      name: 'Cost Spike',
      condition: (ctx) =>
        ctx.historical_average !== undefined &&
        ctx.historical_average > 0 &&
        ctx.metric_value > 3 * ctx.historical_average,
      severity: 'warning',
      actions: ['notify'],
      cooldown_seconds: 300,
      enabled: true,
    },
    {
      id: 'builtin-stuck-agent',
      name: 'Stuck Agent',
      condition: (ctx) =>
        ctx.metric_name === 'agent_idle_seconds' && ctx.metric_value > 300,
      severity: 'warning',
      actions: ['notify'],
      cooldown_seconds: 300,
      enabled: true,
    },
    {
      id: 'builtin-retry-storm',
      name: 'Retry Storm',
      condition: (ctx) =>
        ctx.metric_name === 'consecutive_failures' && ctx.metric_value > 5,
      severity: 'critical',
      actions: ['pause'],
      cooldown_seconds: 300,
      enabled: true,
    },
    {
      id: 'builtin-budget-exceeded',
      name: 'Budget Exceeded',
      condition: (ctx) =>
        ctx.metric_name === 'token_usage_ratio' && ctx.metric_value > 1.2,
      severity: 'critical',
      actions: ['kill'],
      cooldown_seconds: 300,
      enabled: true,
    },
    {
      id: 'builtin-success-rate-drop',
      name: 'Success Rate Drop',
      condition: (ctx) =>
        ctx.metric_name === 'success_rate' && ctx.metric_value < 0.4,
      severity: 'warning',
      actions: ['notify'],
      cooldown_seconds: 300,
      enabled: true,
    },
  ];

  const ids: string[] = [];
  for (const rule of rules) {
    ids.push(registerRule(rule, tenantId));
  }

  logger.info({ count: ids.length, tenant_id: tenantId }, 'Built-in alert rules registered');
  return ids;
}
