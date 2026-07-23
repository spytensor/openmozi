/**
 * Proactive Engine — LLM-driven autonomous awareness module.
 *
 * Replaces the deterministic rule engine (evaluateLoopDecisions) with an LLM
 * judge that decides when to notify the user, take autonomous action, or stay
 * quiet.  Events from the progress bus, observer alerts, and periodic system
 * snapshots are fed to the LLM, which has full autonomy to act.
 *
 * Anti-runaway guardrails are intentionally very loose (~50× normal thresholds).
 */

import pino from 'pino';
import { log as logEvent } from '../store/events.js';
import { notify } from '../channels/proactive-notifier.js';
import { listSessions } from '../memory/sessions.js';
import { getHistory } from '../memory/conversations.js';
import { getProfile, type UserProfile } from '../memory/user-profile.js';
import { evaluate as evaluateAlerts } from '../observer/evaluator.js';
import { extractLessons as extractEventLessons } from './event-learner.js';
import type { AgentLoopSignalSnapshot } from './agent-loop.js';

const logger = pino({ name: 'mozi:proactive-engine' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProactiveEvent {
  type: string;
  summary: string;
  data?: unknown;
  timestamp: number;
}

export interface ProactiveDecision {
  action: 'notify' | 'act' | 'wait' | 'nothing';
  message?: string;
  autonomous_action?: string;
  wait_minutes?: number;
  reasoning?: string;
}

export interface UserContext {
  lastActivityAt: number | null;
  idleMinutes: number;
  recentMessages: string[];
  profile: UserProfile | null;
  language: string;
}

export interface ProactiveEngineConfig {
  ownerChatId: string;
  tenantId: string;
  intervalMinutes?: number;
  /** Injected snapshot collector — defaults to agent-loop's collectSignalSnapshot */
  collectSnapshot?: () => Promise<AgentLoopSignalSnapshot>;
  /** Injected LLM call — overridden in tests */
  llmCall?: (system: string, user: string) => Promise<string>;
  /** Injected autonomous action executor — routes proactive `act` decisions into the main handler. */
  actHandler?: (params: { chatId: string; tenantId: string; action: string }) => Promise<string | void>;
}

// ---------------------------------------------------------------------------
// Anti-runaway guardrails (intentionally very loose)
// ---------------------------------------------------------------------------

const MAX_MESSAGES_PER_HOUR = 100;
const MIN_INTERVAL_SECONDS = 120;
const MAX_CONSECUTIVE_ACTS = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const eventQueue: ProactiveEvent[] = [];

let intervalRef: ReturnType<typeof setTimeout> | null = null;
let nextWakeOverride: number | null = null;
let running = false;
let config: ProactiveEngineConfig | null = null;
let wakeInFlight = false;

// guardrail counters
let messageTimestamps: number[] = [];
let consecutiveActs = 0;
let lastNotifyAt = 0;
let wakeCycleCount = 0;

// Exponential backoff state
let consecutiveFailures = 0;
const BASE_INTERVAL_MS = 2 * 60_000;
const MAX_INTERVAL_MS = 30 * 60_000;

/** Calculate next wake interval based on consecutive LLM failures. */
export function getBackoffInterval(): number {
  if (consecutiveFailures === 0) return config?.intervalMinutes ? config.intervalMinutes * 60_000 : BASE_INTERVAL_MS;
  return Math.min(BASE_INTERVAL_MS * Math.pow(2, consecutiveFailures), MAX_INTERVAL_MS);
}

/** Get current consecutive failure count — for tests. */
export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

/** Push an event into the proactive engine's queue. */
export function pushEvent(event: Omit<ProactiveEvent, 'timestamp'>): void {
  eventQueue.push({ ...event, timestamp: Date.now() });
}

/** Drain and return all queued events. */
function drainQueue(): ProactiveEvent[] {
  return eventQueue.splice(0);
}

/** Read-only access for tests. */
export function getQueueLength(): number {
  return eventQueue.length;
}

/** Clear the wait override so the proactive engine resumes normal wake cycles. */
export function clearWaitOverride(): void {
  if (nextWakeOverride) {
    logger.info('Wait override cleared');
    nextWakeOverride = null;
  }
}

/** Set a new wait override (minutes from now). */
export function setWaitOverride(minutes: number): void {
  nextWakeOverride = Date.now() + (minutes * 60_000);
  logger.info({ minutes, resumesAt: new Date(nextWakeOverride).toISOString() }, 'Wait override set');
}

/** Get current proactive engine status for the LLM tool. */
export function getProactiveStatus(): {
  running: boolean;
  waitingUntil: string | null;
  queueLength: number;
  intervalMinutes: number;
} {
  return {
    running,
    waitingUntil: nextWakeOverride ? new Date(nextWakeOverride).toISOString() : null,
    queueLength: eventQueue.length,
    intervalMinutes: config?.intervalMinutes ?? 2,
  };
}

// ---------------------------------------------------------------------------
// JUDGE_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are the local agent runtime's background awareness module. Your default action is "nothing". Only deviate when there is a clear, user-actionable reason.

You receive: accumulated events, system state, and user context.

Your options:
1. "notify" — Send a message to the user ONLY if it requires their immediate action or is something they explicitly asked to be notified about.
2. "act" — Take an autonomous action ONLY if a critical failure needs immediate remediation.
3. "wait" — Set a follow-up time if an event might become actionable later.
4. "nothing" — Default. Use this for routine metrics, periodic checks, and anything the user did not ask to monitor.

Hard rules:
- System metrics (failure rates, token usage, task counts, cost) are NEVER worth notifying about. The user can check these on demand.
- Periodic checks with no accumulated events → always "nothing".
- Do NOT send status reports, summaries, or "everything is fine" messages.
- Only notify for: user-requested monitors, task completion the user is waiting for, or errors that block the user's work.
- Use the user's profile language if one is available. If there is no profile language for this background notification, use concise English.

Output ONLY valid JSON (no markdown fences, no extra text):
{
  "action": "notify" | "act" | "wait" | "nothing",
  "message": "text to send to user (if notify)",
  "autonomous_action": "description of action to take (if act)",
  "wait_minutes": 5,
  "reasoning": "brief internal reasoning"
}`;

// ---------------------------------------------------------------------------
// User context
// ---------------------------------------------------------------------------

async function collectUserContext(chatId: string, tenantId: string): Promise<UserContext> {
  let lastActivityAt: number | null = null;
  try {
    const sessions = listSessions(chatId, { tenantId, limit: 1 });
    const lastSession = sessions[0];
    lastActivityAt = lastSession ? new Date(lastSession.updated_at + 'Z').getTime() : null;
  } catch { /* DB may not be ready */ }

  const idleMinutes = lastActivityAt ? (Date.now() - lastActivityAt) / 60_000 : Infinity;

  let recentMessages: string[] = [];
  try {
    const history = getHistory(chatId, 5, tenantId);
    recentMessages = history.map(m => `[${m.role}] ${m.content.slice(0, 200)}`);
  } catch { /* empty history is fine */ }

  let profile: UserProfile | null = null;
  let language = 'en';
  try {
    profile = getProfile(tenantId);
    language = profile?.language_preference ?? 'en';
  } catch { /* default language */ }

  return { lastActivityAt, idleMinutes, recentMessages, profile, language };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildJudgePrompt(
  events: ProactiveEvent[],
  systemState: AgentLoopSignalSnapshot | null,
  userContext: UserContext,
): string {
  const sections: string[] = [];

  // Events
  if (events.length > 0) {
    const eventLines = events.map(e =>
      `- [${new Date(e.timestamp).toISOString()}] ${e.type}: ${e.summary}`,
    );
    sections.push(`## Accumulated Events (${events.length})\n${eventLines.join('\n')}`);
  } else {
    sections.push('## Accumulated Events\nNone — this is a periodic check.');
  }

  // System state
  if (systemState) {
    sections.push(`## System State
- Tasks: pending=${systemState.tasks.pending}, running=${systemState.tasks.running}, failed=${systemState.tasks.failed}, completed=${systemState.tasks.completed}
- Background: pending=${systemState.background_tasks.pending}, failed=${systemState.background_tasks.failed}
- Turns (24h): total=${systemState.recent_turns.total}, failed=${systemState.recent_turns.failed}, failure_rate=${systemState.recent_turns.failure_rate.toFixed(2)}, cost=$${systemState.recent_turns.cost_usd.toFixed(4)}
- Token quota: ${systemState.quota.daily_tokens_used}/${systemState.quota.daily_token_limit} (${systemState.quota.daily_token_state})
- Goals: pending=${systemState.goals.pending}, in_progress=${systemState.goals.in_progress}, stalled=${systemState.goals.stalled}
- Recent lessons: ${systemState.recent_lessons_count}`);
  }

  // User context
  sections.push(`## User Context
- Last activity: ${userContext.lastActivityAt ? new Date(userContext.lastActivityAt).toISOString() : 'unknown'}
- Idle: ${Number.isFinite(userContext.idleMinutes) ? `${Math.round(userContext.idleMinutes)} minutes` : 'unknown'}
- Language: ${userContext.language}
- Recent messages (last 5):
${userContext.recentMessages.length > 0 ? userContext.recentMessages.join('\n') : '(none)'}`);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Decision parser
// ---------------------------------------------------------------------------

export function parseDecision(raw: string): ProactiveDecision {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const action = parsed.action;
    if (action !== 'notify' && action !== 'act' && action !== 'wait' && action !== 'nothing') {
      return { action: 'nothing', reasoning: `Invalid action: ${String(action)}` };
    }
    return {
      action,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      autonomous_action: typeof parsed.autonomous_action === 'string' ? parsed.autonomous_action : undefined,
      wait_minutes: typeof parsed.wait_minutes === 'number' ? parsed.wait_minutes : undefined,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
    };
  } catch {
    // Attempt to salvage truncated JSON (e.g. max_tokens cut off the response)
    const actionMatch = cleaned.match(/"action"\s*:\s*"(notify|act|wait|nothing)"/);
    const messageMatch = cleaned.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
    if (actionMatch) {
      logger.warn('Salvaged truncated LLM decision JSON');
      return {
        action: actionMatch[1] as ProactiveDecision['action'],
        message: messageMatch ? messageMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : undefined,
        reasoning: 'Salvaged from truncated JSON',
      };
    }
    logger.warn({ raw: raw.slice(0, 200) }, 'Failed to parse LLM decision — defaulting to nothing');
    return { action: 'nothing', reasoning: `Parse error: ${raw.slice(0, 100)}` };
  }
}

// ---------------------------------------------------------------------------
// Guardrail check
// ---------------------------------------------------------------------------

function checkGuardrails(decision: ProactiveDecision): boolean {
  const now = Date.now();

  // Rate-limit notifications
  if (decision.action === 'notify') {
    // Prune old timestamps
    messageTimestamps = messageTimestamps.filter(t => now - t < 3_600_000);
    if (messageTimestamps.length >= MAX_MESSAGES_PER_HOUR) {
      logger.warn({ count: messageTimestamps.length }, 'Proactive engine: notification rate limit exceeded');
      return false;
    }
    if (now - lastNotifyAt < MIN_INTERVAL_SECONDS * 1000) {
      logger.warn('Proactive engine: minimum notification interval not met');
      return false;
    }
  }

  // Limit consecutive autonomous actions
  if (decision.action === 'act') {
    if (consecutiveActs >= MAX_CONSECUTIVE_ACTS) {
      logger.warn({ consecutiveActs }, 'Proactive engine: consecutive action limit exceeded');
      return false;
    }
  }

  return true;
}

function updateGuardrailCounters(decision: ProactiveDecision): void {
  if (decision.action === 'notify') {
    messageTimestamps.push(Date.now());
    lastNotifyAt = Date.now();
    consecutiveActs = 0;
  } else if (decision.action === 'act') {
    consecutiveActs += 1;
  } else {
    consecutiveActs = 0;
  }
}

// ---------------------------------------------------------------------------
// Decision execution
// ---------------------------------------------------------------------------

const HIGH_RISK_ACTION_PATTERNS = [
  /\brm\s+-r?f\b/i,
  /\bdelete\s+(database|table|production|all|volume|cluster)\b/i,
  /\bdeploy\s+to\s+prod(uction)?\b/i,
  /\bdrop\s+(table|database|collection)\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\s+-9\b/i,
  /\bforce[-_\s]?push\b/i,
  /\btruncate\s+table\b/i,
];

export function evaluateActionSafety(action: string): { allowed: true } | { allowed: false; reason: string } {
  const normalized = action.trim();
  if (!normalized) return { allowed: false, reason: 'empty action' };
  for (const pattern of HIGH_RISK_ACTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { allowed: false, reason: `matched high-risk pattern ${pattern}` };
    }
  }
  return { allowed: true };
}

async function executeDecision(decision: ProactiveDecision, chatId: string, tenantId: string): Promise<void> {
  if (decision.action === 'notify' && decision.message) {
    await notify(chatId, decision.message);
  }
  if (decision.action === 'act' && decision.autonomous_action) {
    const safety = evaluateActionSafety(decision.autonomous_action);
    if (!safety.allowed) {
      await notify(chatId, `Proactive action blocked by safety gate: ${decision.autonomous_action}`);
      logEvent('proactive_action_blocked', 'proactive', `act_${Date.now()}`, {
        action: decision.autonomous_action,
        reason: safety.reason,
      }, tenantId);
      return;
    }

    if (!config?.actHandler) {
      logger.info({ chatId, tenantId, action: decision.autonomous_action }, 'Proactive action skipped: executor unavailable');
      logEvent('proactive_action_skipped', 'proactive', `act_${Date.now()}`, {
        action: decision.autonomous_action,
        reason: 'executor_unavailable',
      }, tenantId);
      return;
    }

    try {
      const result = await config.actHandler({
        chatId,
        tenantId,
        action: decision.autonomous_action,
      });
      const resultSummary = typeof result === 'string' && result.trim().length > 0
        ? result.trim().slice(0, 500)
        : 'completed';
      await notify(chatId, `Proactive action executed: ${decision.autonomous_action}\nResult: ${resultSummary}`);
      logEvent('proactive_action_executed', 'proactive', `act_${Date.now()}`, {
        action: decision.autonomous_action,
        result: resultSummary,
      }, tenantId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await notify(chatId, `Proactive action failed: ${decision.autonomous_action}\nError: ${message}`);
      logEvent('proactive_action_failed', 'proactive', `act_${Date.now()}`, {
        action: decision.autonomous_action,
        error: message,
      }, tenantId);
    }
  }
  if (decision.action === 'wait' && decision.wait_minutes) {
    nextWakeOverride = Date.now() + (decision.wait_minutes * 60_000);
  }
}

// ---------------------------------------------------------------------------
// Observer alerts integration
// ---------------------------------------------------------------------------

function collectObserverAlerts(systemState: AgentLoopSignalSnapshot | null, tenantId: string): void {
  if (!systemState) return;

  try {
    const context = {
      metric_name: 'turn_failure_rate',
      metric_value: systemState.recent_turns.failure_rate,
      threshold: 0.5,
      timestamp: Date.now(),
    };
    const alerts = evaluateAlerts(context, tenantId);
    for (const alert of alerts) {
      pushEvent({
        type: `alert:${alert.rule_id}`,
        summary: `Alert fired: ${alert.rule_id} (${alert.severity})`,
        data: alert,
      });
    }
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Observer alert evaluation failed');
  }
}

function runEventLearnerCycle(tenantId: string): void {
  try {
    const lessons = extractEventLessons(tenantId, 24);
    if (lessons.length === 0) return;
    pushEvent({
      type: 'event_learner',
      summary: `Event learner extracted ${lessons.length} lesson(s) from recent execution history.`,
      data: { lessons_preview: lessons.slice(0, 3) },
    });
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Event learner cycle failed');
  }
}

// ---------------------------------------------------------------------------
// Default LLM call via brain client
// ---------------------------------------------------------------------------

async function defaultLLMCall(system: string, user: string, tenantId: string): Promise<string> {
  // Dynamic import to avoid circular dependency at module load time
  const { create } = await import('./llm.js');
  const { getConfig } = await import('../config/index.js');
  const cfg = getConfig();
  const provider = cfg.model_router?.brain_provider ?? 'openai';
  const model = cfg.brain.model ?? '';
  const { getModel: getModelDef } = await import('./providers.js');
  const modelDef = getModelDef(provider, model);
  const maxTokens = modelDef?.maxOutputTokens ?? 4096;
  const client = create(provider, { configProviders: cfg.providers });
  const response = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      max_tokens: maxTokens,
      temperature: 0.3,
      think: cfg.brain.think,
      timeout_ms: 30_000,
      billing: { tenantId, agentId: 'proactive-engine' },
    },
  );
  return response.content;
}

// ---------------------------------------------------------------------------
// Fallback decision (used when LLM call fails)
// ---------------------------------------------------------------------------

/**
 * Simple rule-based fallback when the LLM judge is unavailable.
 * Only critical alerts trigger a notification; everything else is ignored.
 */
export function fallbackDecision(events: ProactiveEvent[]): ProactiveDecision {
  const critical = events.find(e => e.type.startsWith('alert:') && e.summary.includes('critical'));
  if (critical) {
    return { action: 'notify', message: critical.summary, reasoning: 'Fallback: critical alert detected' };
  }
  return { action: 'nothing', reasoning: 'Fallback: no critical events' };
}

// ---------------------------------------------------------------------------
// Wake cycle
// ---------------------------------------------------------------------------

export async function wake(ownerChatId: string, tenantId: string): Promise<void> {
  wakeCycleCount += 1;

  // 1. Collect observer alerts (may push to queue)
  let systemState: AgentLoopSignalSnapshot | null = null;
  if (config?.collectSnapshot) {
    try {
      systemState = await config.collectSnapshot();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to collect system snapshot');
    }
  }

  collectObserverAlerts(systemState, tenantId);

  // 2. Drain event queue
  const events = drainQueue();

  // 3. Collect user context
  const userContext = await collectUserContext(ownerChatId, tenantId);

  // 4. Build prompt and call LLM (or use fallback if too many failures)
  const MAX_CONSECUTIVE_FAILURES = 5;
  const prompt = buildJudgePrompt(events, systemState, userContext);
  const llmCall = config?.llmCall ?? ((system, user) => defaultLLMCall(system, user, config?.tenantId ?? 'default'));
  let decision: ProactiveDecision;
  
  // If too many consecutive failures, skip LLM call entirely
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    decision = fallbackDecision(events);
    logger.info({ events: events.length }, 'Using fallback decision (LLM skipped due to repeated failures)');
  } else {
    try {
      const raw = await llmCall(JUDGE_SYSTEM_PROMPT, prompt);
      decision = parseDecision(raw);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      logger.warn({ err: err instanceof Error ? err.message : String(err), consecutiveFailures, nextIntervalMs: getBackoffInterval() }, 'LLM judge call failed — applying backoff');
      decision = fallbackDecision(events);
    }
  }

  if (events.length === 0 && decision.action !== 'nothing') {
    logger.info(
      { requestedAction: decision.action },
      'Suppressing proactive action during periodic check without accumulated events',
    );
    decision = {
      action: 'nothing',
      reasoning: `Suppressed ${decision.action} during periodic check without accumulated events`,
    };
  }

  // 5. Check guardrails
  if (!checkGuardrails(decision)) {
    decision = { action: 'nothing', reasoning: 'Suppressed by anti-runaway guardrails' };
  }

  // 6. Execute decision
  await executeDecision(decision, ownerChatId, tenantId);
  updateGuardrailCounters(decision);

  // 7. Log decision for audit trail
  logEvent('proactive_engine_decision', 'proactive', `wake_${Date.now()}`, {
    event_count: events.length,
    decision,
  }, tenantId);

  logger.info({
    events: events.length,
    action: decision.action,
    reasoning: decision.reasoning?.slice(0, 100),
  }, 'Proactive engine wake cycle completed');
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

export function startProactiveEngine(cfg: ProactiveEngineConfig): void {
  if (running) {
    logger.warn('Proactive engine already running');
    return;
  }

  config = cfg;
  running = true;

  function scheduleNext(): void {
    if (!running) return;
    const intervalMs = getBackoffInterval();
    intervalRef = setTimeout(() => {
      if (!running) return;
      if (wakeInFlight) {
        logger.debug('Skipping proactive wake: previous cycle still running');
        scheduleNext();
        return;
      }
      // Honour dynamic wake override
      if (nextWakeOverride && Date.now() < nextWakeOverride) {
        scheduleNext();
        return;
      }
      nextWakeOverride = null;
      wakeInFlight = true;
      void wake(cfg.ownerChatId, cfg.tenantId)
        .catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Proactive wake failed');
        })
        .finally(() => {
          wakeInFlight = false;
          scheduleNext();
        });
    }, intervalMs);
  }

  scheduleNext();
  logger.info({ intervalMinutes: cfg.intervalMinutes ?? 2 }, 'Proactive engine started');
}

export function stopProactiveEngine(): void {
  if (intervalRef) {
    clearTimeout(intervalRef);
    intervalRef = null;
  }
  running = false;
  config = null;
  nextWakeOverride = null;
  wakeInFlight = false;
  logger.info('Proactive engine stopped');
}

export function isProactiveEngineRunning(): boolean {
  return running;
}

/** Reset all state — for tests. */
export function resetProactiveEngine(): void {
  stopProactiveEngine();
  eventQueue.length = 0;
  messageTimestamps = [];
  consecutiveActs = 0;
  lastNotifyAt = 0;
  wakeCycleCount = 0;
  consecutiveFailures = 0;
}
