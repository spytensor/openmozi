/**
 * Alert Evaluator — evaluates alert contexts against registered rules,
 * respects cooldowns, records alert history, and executes actions.
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import {
  type AlertContext,
  type Alert,
  type AlertSeverity,
  type AlertAction,
  type AlertEnforcementStatus,
  listRules,
  getCondition,
  ensureTables,
} from './alerts.js';
import { requestTurnCancellation } from '../core/turn-cancellation.js';
import { requestTaskCancellation } from '../core/task-cancellation.js';
import { getById as getTaskById } from '../store/task-dag.js';
import { getProcess, getProcessByAgentId, kill as killSubAgentProcess } from '../agents/process-manager.js';
import { update as updateAgent } from '../agents/registry.js';

const logger = pino({ name: 'mozi:observer:evaluator' });

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface AlertHistoryRow {
  id: string;
  tenant_id: string;
  rule_id: string;
  rule_name: string;
  severity: string;
  actions: string;
  context: string;
  message: string;
  enforcement_status?: string;
  enforcement_error?: string | null;
  enforcement_results?: string | null;
  created_at: string;
}

export interface EvaluateOptions {
  executeActions?: boolean;
}

interface ActionExecutionResult {
  action: AlertAction;
  enforced: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate an alert context against all enabled rules.
 * Respects cooldown periods — will not fire the same rule if the last alert
 * for that rule was within its cooldown_seconds window.
 * @returns Array of fired alerts
 */
export function evaluate(
  context: AlertContext,
  tenantId = 'default',
  options: EvaluateOptions = {},
): Alert[] {
  return evaluateWithOptions(context, tenantId, options);
}

export function evaluateWithOptions(
  context: AlertContext,
  tenantId = 'default',
  options: EvaluateOptions = {},
): Alert[] {
  ensureTables();
  const rules = listRules(tenantId);
  const firedAlerts: Alert[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const condition = rule.condition ?? getCondition(rule.id);
    if (!condition) continue;

    // Check if condition matches
    let matches = false;
    try {
      matches = condition(context);
    } catch (err) {
      logger.warn({ rule_id: rule.id, error: err }, 'Alert condition threw an error');
      continue;
    }

    if (!matches) continue;

    // Check cooldown
    const lastAlertTime = getLastAlertTime(rule.id, tenantId);
    if (lastAlertTime !== null) {
      const elapsedMs = context.timestamp - lastAlertTime;
      const cooldownMs = rule.cooldown_seconds * 1000;
      if (elapsedMs < cooldownMs) {
        logger.debug(
          { rule_id: rule.id, elapsed_ms: elapsedMs, cooldown_ms: cooldownMs },
          'Alert suppressed by cooldown'
        );
        continue;
      }
    }

    // Build and record the alert
    const alert: Alert = {
      id: randomUUID(),
      rule_id: rule.id,
      rule_name: rule.name,
      severity: rule.severity,
      actions: rule.actions,
      context,
      message: `[${rule.severity.toUpperCase()}] ${rule.name}: ${context.metric_name}=${context.metric_value}`,
      created_at: new Date(context.timestamp).toISOString(),
      enforcement_status: 'not_attempted',
      enforcement_error: null,
      enforcement_results: [],
    };

    // Persist to alert_history
    const db = getDb();
    db.prepare(`
      INSERT INTO alert_history (id, tenant_id, rule_id, rule_name, severity, actions, context, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      alert.id,
      tenantId,
      alert.rule_id,
      alert.rule_name,
      alert.severity,
      JSON.stringify(alert.actions),
      JSON.stringify(alert.context),
      alert.message,
      alert.created_at
    );

    logger.info({ alert_id: alert.id, rule_id: rule.id, severity: rule.severity }, 'Alert fired');
    if (options.executeActions !== false) {
      executeActions(alert, tenantId);
    }
    firedAlerts.push(alert);
  }

  return firedAlerts;
}

/**
 * Execute the actions associated with an alert.
 * - 'log': logs to event_log via events module
 * - 'notify': formats message with [SYSTEM ALERT] prefix and returns it
 * - 'pause': marks a targeted agent inactive when a real target exists
 * - 'kill': cancels a targeted turn/task or kills a live SubAgent process
 *
 * @returns Array of notification messages (from 'notify' actions)
 */
export function executeActions(alert: Alert, tenantId = 'default'): string[] {
  ensureTables();
  const notifications: string[] = [];
  const results: ActionExecutionResult[] = [];

  for (const action of alert.actions) {
    switch (action) {
      case 'log':
        logEvent('alert_fired', 'alert', alert.id, {
          rule_id: alert.rule_id,
          rule_name: alert.rule_name,
          severity: alert.severity,
          context: alert.context,
          message: alert.message,
        }, tenantId);
        logger.info({ alert_id: alert.id, action: 'log' }, 'Alert logged to event_log');
        results.push({ action, enforced: true, detail: 'logged to event_log' });
        break;

      case 'notify': {
        const msg = `[SYSTEM ALERT] [${alert.severity.toUpperCase()}] ${alert.rule_name}: ${alert.context.metric_name}=${alert.context.metric_value}`;
        notifications.push(msg);
        logEvent('alert_notification', 'alert', alert.id, {
          rule_id: alert.rule_id,
          message: msg,
        }, tenantId);
        logger.info({ alert_id: alert.id, action: 'notify' }, 'Alert notification generated');
        results.push({ action, enforced: true, detail: 'notification generated' });
        break;
      }

      case 'pause': {
        const result = enforcePause(alert, tenantId);
        results.push(result);
        break;
      }

      case 'kill': {
        const result = enforceKill(alert, tenantId);
        results.push(result);
        break;
      }

      default:
        logger.warn({ alert_id: alert.id, action }, 'Unknown alert action');
    }
  }

  persistEnforcementResult(alert, results, tenantId);
  return notifications;
}

/**
 * Query alert history with optional filters.
 */
export function getAlertHistory(filters?: {
  rule_id?: string;
  severity?: string;
  tenant_id?: string;
  limit?: number;
}): Alert[] {
  ensureTables();
  const db = getDb();
  const tenantId = filters?.tenant_id ?? 'default';
  const limit = filters?.limit ?? 100;

  const conditions: string[] = ['tenant_id = ?'];
  const params: (string | number)[] = [tenantId];

  if (filters?.rule_id) {
    conditions.push('rule_id = ?');
    params.push(filters.rule_id);
  }
  if (filters?.severity) {
    conditions.push('severity = ?');
    params.push(filters.severity);
  }

  const where = conditions.join(' AND ');
  params.push(limit);

  const rows = db.prepare(`
    SELECT * FROM alert_history
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as AlertHistoryRow[];

  return rows.map((row) => ({
    id: row.id,
    rule_id: row.rule_id,
    rule_name: row.rule_name,
    severity: row.severity as AlertSeverity,
    actions: JSON.parse(row.actions) as AlertAction[],
    context: JSON.parse(row.context) as AlertContext,
    message: row.message,
    created_at: row.created_at,
    enforcement_status: (row.enforcement_status ?? 'not_attempted') as AlertEnforcementStatus,
    enforcement_error: row.enforcement_error ?? null,
    enforcement_results: row.enforcement_results
      ? JSON.parse(row.enforcement_results) as Alert['enforcement_results']
      : [],
  }));
}

/**
 * Get the timestamp (epoch ms) of the last alert for a given rule.
 * Returns null if no previous alert exists.
 */
export function getLastAlertTime(ruleId: string, tenantId = 'default'): number | null {
  ensureTables();
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at FROM alert_history
    WHERE rule_id = ? AND tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(ruleId, tenantId) as { created_at: string } | undefined;

  if (!row) return null;
  return new Date(row.created_at).getTime();
}

function persistEnforcementResult(
  alert: Alert,
  results: ActionExecutionResult[],
  tenantId: string,
): void {
  const failed = results.filter(result => !result.enforced);
  const status: AlertEnforcementStatus = failed.length === 0
    ? 'enforced'
    : failed.length === results.length
      ? 'unenforced'
      : 'partial';
  const error = failed.length > 0
    ? failed.map(result => `${result.action}: ${result.detail}`).join('; ')
    : null;

  alert.enforcement_status = status;
  alert.enforcement_error = error;
  alert.enforcement_results = results;

  getDb().prepare(`
    UPDATE alert_history
    SET enforcement_status = ?,
        enforcement_error = ?,
        enforcement_results = ?
    WHERE id = ? AND tenant_id = ?
  `).run(status, error, JSON.stringify(results), alert.id, tenantId);

  if (status === 'partial' || status === 'unenforced') {
    logger.error({
      alert_id: alert.id,
      rule_id: alert.rule_id,
      tenantId,
      enforcement_status: status,
      error,
    }, 'Alert action enforcement failed');
  }
}

function resolveAgentTarget(alert: Alert, tenantId: string): string | null {
  const directAgentId = alert.context.agent_id?.trim();
  if (directAgentId) return directAgentId;

  const taskId = alert.context.task_id?.trim();
  if (!taskId) return null;

  try {
    return getTaskById(taskId, tenantId)?.assigned_agent ?? null;
  } catch (err) {
    logger.warn({
      alert_id: alert.id,
      task_id: taskId,
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to resolve agent target from task');
    return null;
  }
}

function enforcePause(alert: Alert, tenantId: string): ActionExecutionResult {
  const agentId = resolveAgentTarget(alert, tenantId);
  if (!agentId) {
    return {
      action: 'pause',
      enforced: false,
      detail: 'pause requires alert.context.agent_id or a task with assigned_agent',
    };
  }

  const updated = updateAgent(agentId, { status: 'inactive' }, tenantId);
  if (!updated) {
    return {
      action: 'pause',
      enforced: false,
      detail: `agent not found: ${agentId}`,
    };
  }

  logEvent('alert_pause_enforced', 'alert', alert.id, {
    rule_id: alert.rule_id,
    agent_id: agentId,
    task_id: alert.context.task_id,
    message: alert.message,
    enforcement: 'agent_status_inactive',
  }, tenantId);
  logger.warn({
    alert_id: alert.id,
    action: 'pause',
    agent_id: agentId,
    tenantId,
  }, 'Alert pause enforced by marking agent inactive');
  return {
    action: 'pause',
    enforced: true,
    detail: `agent ${agentId} marked inactive`,
  };
}

function enforceKill(alert: Alert, tenantId: string): ActionExecutionResult {
  const reason = `Observer alert ${alert.rule_id}: ${alert.message}`;
  const taskOrTurnId = alert.context.task_id?.trim();
  if (taskOrTurnId) {
    const turnResult = requestTurnCancellation({
      tenantId,
      turnId: taskOrTurnId,
      requestedBy: 'observer',
      reason,
    });
    if (turnResult.ok) {
      logEvent('alert_kill_enforced', 'alert', alert.id, {
        rule_id: alert.rule_id,
        control: 'turn_cancellation',
        turn_id: turnResult.turnId,
        chat_id: turnResult.chatId,
        task_id: taskOrTurnId,
        message: alert.message,
      }, tenantId);
      logger.warn({
        alert_id: alert.id,
        action: 'kill',
        control: 'turn_cancellation',
        turn_id: turnResult.turnId,
        tenantId,
      }, 'Alert kill enforced by cancelling running turn');
      return {
        action: 'kill',
        enforced: true,
        detail: `turn cancellation requested for ${turnResult.turnId}`,
      };
    }

    try {
      const task = getTaskById(taskOrTurnId, tenantId);
      if (task) {
        void requestTaskCancellation(taskOrTurnId, {
          tenantId,
          requestedBy: 'observer',
          reason,
        }).catch((err: unknown) => {
          logger.error({
            alert_id: alert.id,
            action: 'kill',
            task_id: taskOrTurnId,
            tenantId,
            err: err instanceof Error ? err.message : String(err),
          }, 'Async task cancellation request failed after alert kill action');
        });
        logEvent('alert_kill_enforced', 'alert', alert.id, {
          rule_id: alert.rule_id,
          control: 'task_cancellation',
          task_id: taskOrTurnId,
          message: alert.message,
        }, tenantId);
        logger.warn({
          alert_id: alert.id,
          action: 'kill',
          control: 'task_cancellation',
          task_id: taskOrTurnId,
          tenantId,
        }, 'Alert kill enforced by requesting task cancellation');
        return {
          action: 'kill',
          enforced: true,
          detail: `task cancellation requested for ${taskOrTurnId}`,
        };
      }
    } catch (err) {
      logger.warn({
        alert_id: alert.id,
        task_id: taskOrTurnId,
        tenantId,
        err: err instanceof Error ? err.message : String(err),
      }, 'Failed to inspect task before alert kill enforcement');
    }
  }

  const agentId = alert.context.agent_id?.trim();
  if (agentId) {
    const proc = getProcess(agentId) ?? getProcessByAgentId(agentId) ?? null;
    if (proc) {
      void killSubAgentProcess(proc.id).catch((err: unknown) => {
        logger.error({
          alert_id: alert.id,
          action: 'kill',
          process_id: proc.id,
          agent_id: agentId,
          tenantId,
          err: err instanceof Error ? err.message : String(err),
        }, 'Async process kill failed after alert kill action');
      });
      logEvent('alert_kill_enforced', 'alert', alert.id, {
        rule_id: alert.rule_id,
        control: 'subagent_process_kill',
        agent_id: agentId,
        process_id: proc.id,
        message: alert.message,
      }, tenantId);
      logger.warn({
        alert_id: alert.id,
        action: 'kill',
        control: 'subagent_process_kill',
        agent_id: agentId,
        process_id: proc.id,
        tenantId,
      }, 'Alert kill enforced by killing subagent process');
      return {
        action: 'kill',
        enforced: true,
        detail: `subagent process kill requested for ${proc.id}`,
      };
    }
  }

  return {
    action: 'kill',
    enforced: false,
    detail: 'kill requires an active turn/task id or live subagent process target',
  };
}
