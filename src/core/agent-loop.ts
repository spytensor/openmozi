import pino from 'pino';
import { getDb } from '../store/db.js';
import { list as listScheduledTasks } from '../scheduler/index.js';
import { getPendingTasks, getBackgroundTaskStats } from './background-tasks.js';
import { checkDailyTokenQuota, type QuotaCheckResult } from '../tenants/quotas.js';
import { log as logEvent, queryByEventType } from '../store/events.js';

const logger = pino({ name: 'mozi:agent-loop' });

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_TENANT_ID = 'default';
const DEFAULT_REMINDER_TASK_ID = 'reminder_dispatch';
const DEFAULT_LESSON_LOOKBACK_MINUTES = 60;
const BACKGROUND_TASK_PREVIEW_LIMIT = 3;
const TURN_LOOKBACK_HOURS = 24;

export interface AgentLoopConfig {
  ownerChatId: string;
  sendFn: (chatId: string, message: string) => void | Promise<void>;
  intervalMinutes?: number;
  tenantId?: string;
  reminderTaskId?: string;
  lessonsLookbackMinutes?: number;
}

export interface AgentLoopDecisionAction {
  code:
    | 'missing_reminder_scheduler'
    | 'pending_background_tasks'
    | 'stalled_goals_detected'
    | 'high_turn_failure_rate'
    | 'token_quota_pressure'
    | 'task_failure_backlog'
    | 'healthy';
  severity: 'info' | 'warn' | 'critical';
  reason: string;
  message: string;
  notify_owner: boolean;
}

export interface AgentLoopSignalSnapshot {
  tenant_id: string;
  owner_chat_id: string;
  reminder_task_found: boolean;
  background_tasks: {
    pending: number;
    failed: number;
    completed: number;
  };
  recent_lessons_count: number;
  goals: {
    pending: number;
    in_progress: number;
    stalled: number;
    completed: number;
    failed: number;
  };
  tasks: {
    pending: number;
    running: number;
    failed: number;
    completed: number;
  };
  recent_turns: {
    total: number;
    failed: number;
    failure_rate: number;
    cost_usd: number;
    failure_categories: Array<{ category: string; count: number }>;
  };
  quota: {
    daily_tokens_used: number;
    daily_token_limit: number;
    daily_token_state: QuotaCheckResult;
  };
}

export interface AgentLoopDecisionLog {
  id: string;
  tenant_id: string;
  owner_chat_id: string;
  cycle_started_at: number;
  cycle_completed_at: number;
  signals: AgentLoopSignalSnapshot;
  actions: AgentLoopDecisionAction[];
  summary: string;
}

export interface AgentLoopStatus {
  running: boolean;
  interval_minutes: number;
  tenant_id: string;
  owner_chat_id: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  last_noteworthy_at: number | null;
  last_error: string | null;
  last_summary: string | null;
  last_check: {
    reminder_task_found: boolean;
    pending_background_tasks: number;
    failed_background_tasks: number;
    recent_lessons_count: number;
    running_tasks: number;
    failed_tasks: number;
    recent_turn_failure_rate: number;
    daily_token_quota_state: QuotaCheckResult;
  } | null;
  goals: Goal[];
  self_evaluation: SelfEvaluation | null;
  last_decision: AgentLoopDecisionLog | null;
}

export interface Goal {
  id: string;
  tenant_id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'abandoned';
  created_at: number;
  updated_at: number;
  completed_at?: number;
  progress: number;
  priority: number;
  autonomy_budget: number;
  success_count: number;
  failure_count: number;
  evidence: string[];
}

export interface SelfEvaluation {
  timestamp: number;
  goals_achieved: number;
  goals_pending: number;
  goals_failed: number;
  success_rate: number;
  adjustments_made: string[];
  new_insights: string[];
}

export interface InternalAgentLoopConfig {
  ownerChatId: string;
  sendFn: (chatId: string, message: string) => void | Promise<void>;
  intervalMinutes: number;
  tenantId: string;
  reminderTaskId: string;
  lessonsLookbackMinutes: number;
}

interface GoalRow {
  id: string;
  tenant_id: string;
  chat_id: string | null;
  description: string;
  status: string;
  priority: number;
  progress: number;
  autonomy_budget: number;
  success_count: number;
  failure_count: number;
  evidence: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Thought {
  type: 'reflection' | 'insight' | 'learning';
  content: string;
  timestamp: number;
}

let intervalRef: ReturnType<typeof setInterval> | null = null;
let currentConfig: InternalAgentLoopConfig | null = null;
let cycleRunning = false;
let cycleCount = 0;

const goals: Goal[] = [];
const selfEvaluations: SelfEvaluation[] = [];
const thoughtHistory: Thought[] = [];
const MAX_GOALS = 20;
const MAX_EVALUATIONS = 50;
const MAX_THOUGHTS = 50;

const status: AgentLoopStatus = {
  running: false,
  interval_minutes: DEFAULT_INTERVAL_MINUTES,
  tenant_id: DEFAULT_TENANT_ID,
  owner_chat_id: null,
  last_run_at: null,
  next_run_at: null,
  last_noteworthy_at: null,
  last_error: null,
  last_summary: null,
  last_check: null,
  goals,
  self_evaluation: null,
  last_decision: null,
};

function goalRowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    description: row.description,
    status: row.status as Goal['status'],
    created_at: new Date(`${row.created_at}Z`).getTime(),
    updated_at: new Date(`${row.updated_at}Z`).getTime(),
    completed_at: row.completed_at ? new Date(`${row.completed_at}Z`).getTime() : undefined,
    progress: row.progress,
    priority: row.priority,
    autonomy_budget: row.autonomy_budget,
    success_count: row.success_count,
    failure_count: row.failure_count,
    evidence: JSON.parse(row.evidence || '[]'),
  };
}

function dbSaveGoal(goal: Goal, tenantId: string, chatId?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO goals (id, tenant_id, chat_id, description, status, priority, progress,
      autonomy_budget, success_count, failure_count, evidence, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'))
    ON CONFLICT(tenant_id, id) DO UPDATE SET
      description = excluded.description,
      status = excluded.status,
      priority = excluded.priority,
      progress = excluded.progress,
      autonomy_budget = excluded.autonomy_budget,
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      evidence = excluded.evidence,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(
    goal.id,
    tenantId,
    chatId ?? null,
    goal.description,
    goal.status,
    goal.priority,
    goal.progress,
    goal.autonomy_budget,
    goal.success_count,
    goal.failure_count,
    JSON.stringify(goal.evidence),
    goal.completed_at ? new Date(goal.completed_at).toISOString().replace('T', ' ').replace('Z', '') : null,
    goal.created_at,
    goal.updated_at,
  );
}

function dbUpdateGoal(goal: Goal, tenantId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE goals SET
      status = ?, progress = ?, priority = ?,
      autonomy_budget = ?, success_count = ?, failure_count = ?,
      evidence = ?,
      completed_at = ?,
      updated_at = datetime(? / 1000, 'unixepoch')
    WHERE tenant_id = ? AND id = ?
  `).run(
    goal.status,
    goal.progress,
    goal.priority,
    goal.autonomy_budget,
    goal.success_count,
    goal.failure_count,
    JSON.stringify(goal.evidence),
    goal.completed_at ? new Date(goal.completed_at).toISOString().replace('T', ' ').replace('Z', '') : null,
    goal.updated_at,
    tenantId,
    goal.id,
  );
}

function dbLoadGoals(tenantId: string): Goal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM goals
    WHERE tenant_id = ? AND status IN ('pending', 'in_progress')
  `).all(tenantId) as GoalRow[];
  return rows.map(goalRowToGoal);
}

function getRecentLessonsCount(tenantId: string, lookbackMinutes: number): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM lessons
    WHERE tenant_id = ?
      AND created_at >= datetime('now', '-' || ? || ' minutes')
  `).get(tenantId, lookbackMinutes) as { count: number };

  return row.count;
}

function getTaskStatusCounts(tenantId: string): AgentLoopSignalSnapshot['tasks'] {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM tasks
    WHERE tenant_id = ?
  `).get(tenantId) as {
    pending: number | null;
    running: number | null;
    failed: number | null;
    completed: number | null;
  };

  return {
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    failed: Number(row?.failed ?? 0),
    completed: Number(row?.completed ?? 0),
  };
}

function getRecentTurnSignals(tenantId: string): AgentLoopSignalSnapshot['recent_turns'] {
  const db = getDb();
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failed,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM turn_traces
    WHERE tenant_id = ?
      AND started_at >= datetime('now', '-' || ? || ' hours')
  `).get(tenantId, TURN_LOOKBACK_HOURS) as {
    total: number | null;
    failed: number | null;
    cost_usd: number | null;
  };

  const categories = db.prepare(`
    SELECT COALESCE(failure_category, 'unknown') AS category, COUNT(*) AS count
    FROM turn_traces
    WHERE tenant_id = ?
      AND status != 'success'
      AND started_at >= datetime('now', '-' || ? || ' hours')
    GROUP BY COALESCE(failure_category, 'unknown')
    ORDER BY count DESC, category ASC
  `).all(tenantId, TURN_LOOKBACK_HOURS) as Array<{ category: string; count: number }>;

  const total = Number(summary?.total ?? 0);
  const failed = Number(summary?.failed ?? 0);

  return {
    total,
    failed,
    failure_rate: total > 0 ? failed / total : 0,
    cost_usd: Number(summary?.cost_usd ?? 0),
    failure_categories: categories.map((entry) => ({
      category: entry.category || 'unknown',
      count: Number(entry.count ?? 0),
    })),
  };
}

function getQuotaSignal(tenantId: string): AgentLoopSignalSnapshot['quota'] {
  const db = getDb();
  const usageRow = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
    FROM billing_records
    WHERE tenant_id = ?
      AND record_type = 'llm_call'
      AND created_at >= datetime('now', 'start of day')
  `).get(tenantId) as { total_tokens: number | null };
  const dailyTokensUsed = Number(usageRow?.total_tokens ?? 0);
  const state = checkDailyTokenQuota(tenantId, dailyTokensUsed, 0);
  const row = db.prepare('SELECT daily_token_limit FROM tenant_quotas WHERE tenant_id = ?').get(tenantId) as
    | { daily_token_limit: number | null }
    | undefined;
  const fallbackLimit = 1_000_000;

  return {
    daily_tokens_used: dailyTokensUsed,
    daily_token_limit: Number(row?.daily_token_limit ?? fallbackLimit),
    daily_token_state: state,
  };
}

function buildGoalSignal(tenantId: string): AgentLoopSignalSnapshot['goals'] {
  const tenantGoals = goals.filter((goal) => goal.tenant_id === tenantId);
  const stalled = detectStalledGoals(tenantId).length;
  return {
    pending: tenantGoals.filter((goal) => goal.status === 'pending').length,
    in_progress: tenantGoals.filter((goal) => goal.status === 'in_progress').length,
    stalled,
    completed: tenantGoals.filter((goal) => goal.status === 'completed').length,
    failed: tenantGoals.filter((goal) => goal.status === 'failed').length,
  };
}

function buildDecisionSummary(actions: AgentLoopDecisionAction[]): string {
  if (actions.length === 0) return 'No decision actions generated.';
  if (actions.length === 1 && actions[0]?.code === 'healthy') {
    return actions[0].message;
  }
  return actions.map((action) => `${action.code}:${action.severity}`).join(', ');
}

function buildOwnerMessage(snapshot: AgentLoopSignalSnapshot, actions: AgentLoopDecisionAction[]): string | null {
  const notifiable = actions.filter((action) => action.notify_owner && action.code !== 'healthy');
  if (notifiable.length === 0) return null;

  const lines = [
    'Autonomous cycle update:',
    `tenant=${snapshot.tenant_id}`,
    `turns_24h=${snapshot.recent_turns.total}, failures=${snapshot.recent_turns.failed}, failure_rate=${snapshot.recent_turns.failure_rate.toFixed(2)}`,
    `daily_tokens=${snapshot.quota.daily_tokens_used}/${snapshot.quota.daily_token_limit} (${snapshot.quota.daily_token_state})`,
  ];

  for (const action of notifiable) {
    lines.push(`[${action.severity}] ${action.message}`);
  }

  return lines.join('\n');
}

function appendThought(type: Thought['type'], content: string): void {
  thoughtHistory.push({
    type,
    content,
    timestamp: Date.now(),
  });
  if (thoughtHistory.length > MAX_THOUGHTS) {
    thoughtHistory.splice(0, thoughtHistory.length - MAX_THOUGHTS);
  }
}

function buildSelfEvaluation(tenantId: string, snapshot: AgentLoopSignalSnapshot, actions: AgentLoopDecisionAction[]): SelfEvaluation {
  const tenantGoals = goals.filter((goal) => goal.tenant_id === tenantId);
  const goalsAchieved = tenantGoals.filter((goal) => goal.status === 'completed').length;
  const goalsPending = tenantGoals.filter((goal) => goal.status === 'pending' || goal.status === 'in_progress').length;
  const goalsFailed = tenantGoals.filter((goal) => goal.status === 'failed').length;
  const totalClosed = goalsAchieved + goalsFailed;
  const successRate = totalClosed > 0 ? goalsAchieved / totalClosed : 0;

  const adjustments: string[] = [];
  if (snapshot.recent_turns.failure_rate >= 0.4 && snapshot.recent_turns.failed >= 3) {
    adjustments.push('Increase caution: repeated runtime failures detected.');
  }
  if (snapshot.quota.daily_token_state !== 'ok') {
    adjustments.push(`Apply token guardrails: state=${snapshot.quota.daily_token_state}.`);
  }
  if (snapshot.goals.stalled > 0) {
    adjustments.push(`Escalate stalled goals: count=${snapshot.goals.stalled}.`);
  }
  if (actions.some((action) => action.severity === 'critical')) {
    adjustments.push('Critical action emitted; prioritize operational stability.');
  }

  const insights: string[] = [];
  if (snapshot.recent_turns.failure_categories.length > 0) {
    const top = snapshot.recent_turns.failure_categories[0];
    if (top) {
      insights.push(`Top failure category in last ${TURN_LOOKBACK_HOURS}h: ${top.category} (${top.count}).`);
    }
  }
  insights.push(`Task backlog snapshot: pending=${snapshot.tasks.pending}, running=${snapshot.tasks.running}, failed=${snapshot.tasks.failed}.`);

  const evaluation: SelfEvaluation = {
    timestamp: Date.now(),
    goals_achieved: goalsAchieved,
    goals_pending: goalsPending,
    goals_failed: goalsFailed,
    success_rate: successRate,
    adjustments_made: adjustments,
    new_insights: insights,
  };

  selfEvaluations.push(evaluation);
  if (selfEvaluations.length > MAX_EVALUATIONS) {
    selfEvaluations.shift();
  }

  return evaluation;
}

export async function collectSignalSnapshot(cfg: InternalAgentLoopConfig): Promise<AgentLoopSignalSnapshot> {
  const reminderTask = listScheduledTasks().find((task) => task.id === cfg.reminderTaskId);
  const pendingTasks = getPendingTasks(cfg.tenantId);
  const backgroundStats = getBackgroundTaskStats(cfg.tenantId);

  const snapshot: AgentLoopSignalSnapshot = {
    tenant_id: cfg.tenantId,
    owner_chat_id: cfg.ownerChatId,
    reminder_task_found: Boolean(reminderTask),
    background_tasks: {
      pending: pendingTasks.length,
      failed: backgroundStats.failed,
      completed: backgroundStats.completed,
    },
    recent_lessons_count: getRecentLessonsCount(cfg.tenantId, cfg.lessonsLookbackMinutes),
    goals: buildGoalSignal(cfg.tenantId),
    tasks: getTaskStatusCounts(cfg.tenantId),
    recent_turns: getRecentTurnSignals(cfg.tenantId),
    quota: getQuotaSignal(cfg.tenantId),
  };

  const topFailure = snapshot.recent_turns.failure_categories[0];
  appendThought(
    'reflection',
    `snapshot pending_bg=${snapshot.background_tasks.pending}, failed_turns=${snapshot.recent_turns.failed}, top_failure=${topFailure?.category ?? 'none'}`,
  );

  return snapshot;
}

export function evaluateLoopDecisions(snapshot: AgentLoopSignalSnapshot): AgentLoopDecisionAction[] {
  const actions: AgentLoopDecisionAction[] = [];

  if (!snapshot.reminder_task_found) {
    actions.push({
      code: 'missing_reminder_scheduler',
      severity: 'warn',
      reason: 'reminder_scheduler_not_registered',
      message: 'Reminder scheduler task is missing; periodic reminder dispatch may be broken.',
      notify_owner: true,
    });
  }

  if (snapshot.background_tasks.pending > 0) {
    actions.push({
      code: 'pending_background_tasks',
      severity: 'info',
      reason: `pending_background_tasks=${snapshot.background_tasks.pending}`,
      message: `Background backlog detected with ${snapshot.background_tasks.pending} pending task(s).`,
      notify_owner: true,
    });
  }

  if (snapshot.goals.stalled > 0) {
    actions.push({
      code: 'stalled_goals_detected',
      severity: 'warn',
      reason: `stalled_goals=${snapshot.goals.stalled}`,
      message: `Detected ${snapshot.goals.stalled} stalled goal(s) requiring manual progress updates.`,
      notify_owner: true,
    });
  }

  if (snapshot.recent_turns.failed >= 3 && snapshot.recent_turns.failure_rate >= 0.4) {
    const topFailure = snapshot.recent_turns.failure_categories[0]?.category ?? 'unknown';
    actions.push({
      code: 'high_turn_failure_rate',
      severity: 'warn',
      reason: `failed_turns=${snapshot.recent_turns.failed}, failure_rate=${snapshot.recent_turns.failure_rate.toFixed(2)}`,
      message: `Turn failure rate is elevated (${snapshot.recent_turns.failure_rate.toFixed(2)}), dominant category: ${topFailure}.`,
      notify_owner: true,
    });
  }

  if (snapshot.quota.daily_token_state === 'hard_limit' || snapshot.quota.daily_token_state === 'soft_limit') {
    actions.push({
      code: 'token_quota_pressure',
      severity: snapshot.quota.daily_token_state === 'hard_limit' ? 'critical' : 'warn',
      reason: `daily_token_state=${snapshot.quota.daily_token_state}`,
      message: `Daily token quota pressure is ${snapshot.quota.daily_token_state} (${snapshot.quota.daily_tokens_used}/${snapshot.quota.daily_token_limit}).`,
      notify_owner: true,
    });
  }

  if (snapshot.tasks.failed > 0 && snapshot.tasks.pending > 0) {
    actions.push({
      code: 'task_failure_backlog',
      severity: 'warn',
      reason: `failed_tasks=${snapshot.tasks.failed}, pending_tasks=${snapshot.tasks.pending}`,
      message: `Task queue has both failures (${snapshot.tasks.failed}) and pending work (${snapshot.tasks.pending}); recovery triage is recommended.`,
      notify_owner: true,
    });
  }

  if (actions.length === 0) {
    actions.push({
      code: 'healthy',
      severity: 'info',
      reason: 'all_signals_within_threshold',
      message: 'All monitored loop signals are within configured thresholds.',
      notify_owner: false,
    });
  }

  return actions;
}

export function replayDecisionLog(decisionLog: AgentLoopDecisionLog): AgentLoopDecisionAction[] {
  return evaluateLoopDecisions(decisionLog.signals);
}

export function getRecentDecisionLogs(tenantId = DEFAULT_TENANT_ID, limit = 20): AgentLoopDecisionLog[] {
  const events = queryByEventType('agent_loop_decision', tenantId, limit);
  const logs: AgentLoopDecisionLog[] = [];

  for (const event of events) {
    if (typeof event.payload !== 'object' || event.payload === null) continue;
    const payload = event.payload as Partial<AgentLoopDecisionLog>;
    if (
      typeof payload.id === 'string'
      && typeof payload.tenant_id === 'string'
      && typeof payload.owner_chat_id === 'string'
      && typeof payload.cycle_started_at === 'number'
      && typeof payload.cycle_completed_at === 'number'
      && Array.isArray(payload.actions)
      && payload.signals
    ) {
      logs.push(payload as AgentLoopDecisionLog);
    }
  }

  return logs;
}

async function runCycle(cfg: InternalAgentLoopConfig): Promise<void> {
  if (cycleRunning) {
    logger.warn('Agent loop cycle skipped because previous cycle is still running');
    return;
  }

  cycleRunning = true;
  const cycleStartedAt = Date.now();
  status.last_run_at = cycleStartedAt;
  status.next_run_at = cycleStartedAt + (cfg.intervalMinutes * 60_000);

  try {
    const snapshot = await collectSignalSnapshot(cfg);
    const actions = evaluateLoopDecisions(snapshot);

    cycleCount += 1;
    const cycleCompletedAt = Date.now();
    const decisionLog: AgentLoopDecisionLog = {
      id: `loop_${cycleStartedAt}_${cycleCount}`,
      tenant_id: cfg.tenantId,
      owner_chat_id: cfg.ownerChatId,
      cycle_started_at: cycleStartedAt,
      cycle_completed_at: cycleCompletedAt,
      signals: snapshot,
      actions,
      summary: buildDecisionSummary(actions),
    };

    logEvent('agent_loop_decision', 'agent_loop', decisionLog.id, decisionLog, cfg.tenantId);

    status.last_check = {
      reminder_task_found: snapshot.reminder_task_found,
      pending_background_tasks: snapshot.background_tasks.pending,
      failed_background_tasks: snapshot.background_tasks.failed,
      recent_lessons_count: snapshot.recent_lessons_count,
      running_tasks: snapshot.tasks.running,
      failed_tasks: snapshot.tasks.failed,
      recent_turn_failure_rate: snapshot.recent_turns.failure_rate,
      daily_token_quota_state: snapshot.quota.daily_token_state,
    };

    status.self_evaluation = buildSelfEvaluation(cfg.tenantId, snapshot, actions);
    status.last_decision = decisionLog;

    const message = buildOwnerMessage(snapshot, actions);
    if (message) {
      await Promise.resolve(cfg.sendFn(cfg.ownerChatId, message));
      status.last_noteworthy_at = Date.now();
      status.last_summary = message;
    } else {
      status.last_summary = decisionLog.summary;
    }

    status.last_error = null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    status.last_error = error;
    logger.error({ err: error }, 'Agent loop cycle failed');
  } finally {
    cycleRunning = false;
  }
}

export function startAgentLoop(config: AgentLoopConfig): void {
  if (intervalRef) {
    logger.warn('Agent loop already running');
    return;
  }

  if (!config.ownerChatId || typeof config.ownerChatId !== 'string') {
    throw new Error('"ownerChatId" is required');
  }
  if (typeof config.sendFn !== 'function') {
    throw new Error('"sendFn" is required');
  }

  const intervalMinutes = config.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('"intervalMinutes" must be a positive number');
  }

  currentConfig = {
    ownerChatId: config.ownerChatId,
    sendFn: config.sendFn,
    intervalMinutes,
    tenantId: config.tenantId ?? DEFAULT_TENANT_ID,
    reminderTaskId: config.reminderTaskId ?? DEFAULT_REMINDER_TASK_ID,
    lessonsLookbackMinutes: config.lessonsLookbackMinutes ?? DEFAULT_LESSON_LOOKBACK_MINUTES,
  };

  status.running = true;
  status.interval_minutes = currentConfig.intervalMinutes;
  status.tenant_id = currentConfig.tenantId;
  status.owner_chat_id = currentConfig.ownerChatId;
  status.next_run_at = Date.now() + (currentConfig.intervalMinutes * 60_000);

  try {
    loadPersistedGoals(currentConfig.tenantId);
  } catch (err) {
    logger.error({ err }, 'Failed to load persisted goals on startup');
  }

  intervalRef = setInterval(() => {
    if (!currentConfig) return;
    void runCycle(currentConfig);
  }, currentConfig.intervalMinutes * 60_000);

  logger.info({ intervalMinutes: currentConfig.intervalMinutes }, 'Agent loop started with deterministic decision engine');
}

export function stopAgentLoop(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }

  currentConfig = null;
  cycleRunning = false;
  status.running = false;
  status.next_run_at = null;

  logger.info('Agent loop stopped');
}

export function getAgentLoopStatus(): AgentLoopStatus {
  return {
    ...status,
    last_check: status.last_check ? { ...status.last_check } : null,
    goals: [...goals],
    self_evaluation: status.self_evaluation ? { ...status.self_evaluation } : null,
    last_decision: status.last_decision ? {
      ...status.last_decision,
      signals: { ...status.last_decision.signals },
      actions: status.last_decision.actions.map((action) => ({ ...action })),
    } : null,
  };
}

export async function autonomousThink(ownerChatId: string, sendFn: (chatId: string, msg: string) => void | Promise<void>): Promise<void> {
  void sendFn;
  const tenantId = currentConfig?.tenantId ?? DEFAULT_TENANT_ID;
  const activeGoalCount = getActiveGoals(tenantId).length;
  appendThought('insight', `deterministic_think owner=${ownerChatId}, active_goals=${activeGoalCount}`);
}

export function getThoughts(): Thought[] {
  return [...thoughtHistory];
}

export function createGoal(id: string, description: string, tenantId: string = DEFAULT_TENANT_ID, chatId?: string): Goal {
  const goal: Goal = {
    id,
    tenant_id: tenantId,
    description,
    status: 'pending',
    created_at: Date.now(),
    updated_at: Date.now(),
    progress: 0,
    priority: 0,
    autonomy_budget: 1,
    success_count: 0,
    failure_count: 0,
    evidence: [],
  };

  goals.push(goal);
  if (goals.length > MAX_GOALS) {
    goals.shift();
  }

  try {
    dbSaveGoal(goal, tenantId, chatId);
  } catch (err) {
    logger.error({ err, goalId: id }, 'Failed to persist goal to DB');
  }

  logger.info({ goalId: id, description }, 'Goal created');
  return goal;
}

export function updateGoalProgress(id: string, progress: number, evidence?: string, tenantId: string = DEFAULT_TENANT_ID): Goal | null {
  const goal = goals.find((entry) => entry.id === id && entry.tenant_id === tenantId);
  if (!goal) {
    logger.warn({ goalId: id }, 'Goal not found');
    return null;
  }

  goal.progress = Math.min(100, Math.max(0, progress));
  goal.updated_at = Date.now();

  if (evidence) {
    goal.evidence.push(evidence);
    if (goal.evidence.length > 10) {
      goal.evidence.shift();
    }
  }

  try {
    dbUpdateGoal(goal, tenantId);
  } catch (err) {
    logger.error({ err, goalId: id }, 'Failed to persist goal progress to DB');
  }

  return goal;
}

export function completeGoal(id: string, success: boolean, finalEvidence?: string, tenantId: string = DEFAULT_TENANT_ID): Goal | null {
  const goal = goals.find((entry) => entry.id === id && entry.tenant_id === tenantId);
  if (!goal) return null;

  if (success) {
    goal.status = 'completed';
    goal.progress = 100;
    goal.completed_at = Date.now();
    goal.success_count += 1;
    goal.autonomy_budget = Math.min(5, goal.autonomy_budget + 1);
  } else {
    goal.status = 'failed';
    goal.failure_count += 1;
    goal.autonomy_budget = 1;
  }

  if (finalEvidence) {
    goal.evidence.push(finalEvidence);
  }

  goal.updated_at = Date.now();

  try {
    dbUpdateGoal(goal, tenantId);
  } catch (err) {
    logger.error({ err, goalId: id }, 'Failed to persist goal completion to DB');
  }

  logger.info({ goalId: id, status: goal.status, autonomy_budget: goal.autonomy_budget }, 'Goal updated');
  return goal;
}

export function getActiveGoals(tenantId?: string): Goal[] {
  return goals.filter((goal) =>
    (goal.status === 'pending' || goal.status === 'in_progress')
    && (tenantId === undefined || goal.tenant_id === tenantId),
  );
}

export function getAutonomyBudget(tenantId: string = DEFAULT_TENANT_ID): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(autonomy_budget) as max_budget
    FROM goals
    WHERE tenant_id = ? AND status IN ('pending', 'in_progress')
  `).get(tenantId) as { max_budget: number | null } | undefined;
  return row?.max_budget ?? 1;
}

export function loadPersistedGoals(tenantId: string = DEFAULT_TENANT_ID): Goal[] {
  const loaded = dbLoadGoals(tenantId);
  for (const dbGoal of loaded) {
    const existing = goals.findIndex((goal) => goal.id === dbGoal.id && goal.tenant_id === dbGoal.tenant_id);
    if (existing >= 0) {
      goals[existing] = dbGoal;
    } else {
      goals.push(dbGoal);
    }
  }
  logger.info({ count: loaded.length, tenantId }, 'Loaded persisted goals from DB');
  return loaded;
}

export function detectStalledGoals(tenantId: string = DEFAULT_TENANT_ID, stallThresholdMs: number = 3600000): Goal[] {
  const db = getDb();
  const thresholdMinutes = Math.floor(stallThresholdMs / 60000);
  const rows = db.prepare(`
    SELECT * FROM goals
    WHERE tenant_id = ? AND status = 'in_progress'
      AND updated_at < datetime('now', '-' || ? || ' minutes')
  `).all(tenantId, thresholdMinutes) as GoalRow[];
  return rows.map(goalRowToGoal);
}

export function resetGoals(): void {
  goals.length = 0;
  thoughtHistory.length = 0;
  selfEvaluations.length = 0;
  status.self_evaluation = null;
  status.last_decision = null;
  cycleCount = 0;
}
