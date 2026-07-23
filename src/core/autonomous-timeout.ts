import pino from 'pino';
import { getConfig, updateConfig } from '../config/index.js';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:autonomous-timeout' });

const WINDOW_MS = 10 * 60_000;
const TRIGGER_COUNT = 2;
const APPLY_COOLDOWN_MS = 5 * 60_000;
const GROWTH_FACTOR = 1.5;
const MIN_CALL_TIMEOUT_STEP_MS = 15_000;
const MIN_LOOP_TIMEOUT_STEP_MS = 60_000;
const MIN_INTERACTIVE_TIMEOUT_STEP_MS = 60_000;
const MAX_CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_LOOP_TIMEOUT_MS = 60 * 60_000;
const MAX_INTERACTIVE_TIMEOUT_MS = 2 * 60 * 60_000;
const LOOP_MULTIPLIER = 4;

type TimeoutScope = 'gateway' | 'dag' | 'subagent';

interface FailureWindow {
  timeoutTimestamps: number[];
  lastAppliedAt: number;
}

export interface TimeoutAutonomySignal {
  scope: TimeoutScope;
  tenantId: string;
  chatId?: string;
  taskId?: string;
  iteration?: number;
  observedCallTimeoutMs?: number;
  observedLoopTimeoutMs?: number;
  observedInteractiveTurnTimeoutMs?: number;
  detail?: string;
}

export interface TimeoutAutonomyResult {
  applied: boolean;
  reason: string;
  previousCallTimeoutMs: number;
  previousLoopTimeoutMs: number;
  previousInteractiveTurnTimeoutMs: number;
  nextCallTimeoutMs: number;
  nextLoopTimeoutMs: number;
  nextInteractiveTurnTimeoutMs: number;
}

const state = new Map<string, FailureWindow>();

function keyFor(signal: TimeoutAutonomySignal): string {
  return `${signal.tenantId}:${signal.scope}`;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function bumpTimeout(currentMs: number, observedMs: number | undefined, minStepMs: number, capMs: number): number {
  const normalizedObserved = normalizePositiveInt(observedMs, 0);
  const growthByFactor = Math.ceil(currentMs * GROWTH_FACTOR);
  const growthByStep = currentMs + minStepMs;
  const growthByObserved = normalizedObserved > 0 ? normalizedObserved + minStepMs : 0;
  return Math.min(capMs, Math.max(currentMs, growthByFactor, growthByStep, growthByObserved));
}

function pruneWindow(window: FailureWindow, now: number): void {
  window.timeoutTimestamps = window.timeoutTimestamps.filter(ts => now - ts <= WINDOW_MS);
}

export function reportTimeoutAndMaybeTune(signal: TimeoutAutonomySignal): TimeoutAutonomyResult {
  const now = Date.now();
  const cfg = getConfig();
  const previousCallTimeoutMs = normalizePositiveInt(cfg.tools.loops.llm_call_timeout_ms, 300_000);
  const previousLoopTimeoutMs = normalizePositiveInt(cfg.tools.loops.max_elapsed_ms, 600_000);
  const previousInteractiveTurnTimeoutMs = normalizePositiveInt(cfg.telegram.interactive_turn_timeout_ms, 600_000);

  const key = keyFor(signal);
  const window = state.get(key) ?? { timeoutTimestamps: [], lastAppliedAt: 0 };
  pruneWindow(window, now);
  window.timeoutTimestamps.push(now);
  state.set(key, window);

  if (window.timeoutTimestamps.length < TRIGGER_COUNT) {
    return {
      applied: false,
      reason: 'insufficient_timeout_signals',
      previousCallTimeoutMs,
      previousLoopTimeoutMs,
      previousInteractiveTurnTimeoutMs,
      nextCallTimeoutMs: previousCallTimeoutMs,
      nextLoopTimeoutMs: previousLoopTimeoutMs,
      nextInteractiveTurnTimeoutMs: previousInteractiveTurnTimeoutMs,
    };
  }

  if (window.lastAppliedAt > 0 && now - window.lastAppliedAt < APPLY_COOLDOWN_MS) {
    return {
      applied: false,
      reason: 'cooldown_active',
      previousCallTimeoutMs,
      previousLoopTimeoutMs,
      previousInteractiveTurnTimeoutMs,
      nextCallTimeoutMs: previousCallTimeoutMs,
      nextLoopTimeoutMs: previousLoopTimeoutMs,
      nextInteractiveTurnTimeoutMs: previousInteractiveTurnTimeoutMs,
    };
  }

  const nextCallTimeoutMs = bumpTimeout(
    previousCallTimeoutMs,
    signal.observedCallTimeoutMs,
    MIN_CALL_TIMEOUT_STEP_MS,
    MAX_CALL_TIMEOUT_MS,
  );

  const loopTargetFromCall = nextCallTimeoutMs * LOOP_MULTIPLIER;
  const loopTargetFromObserved = normalizePositiveInt(signal.observedLoopTimeoutMs, 0) + MIN_LOOP_TIMEOUT_STEP_MS;
  const nextLoopTimeoutMs = Math.min(
    MAX_LOOP_TIMEOUT_MS,
    Math.max(previousLoopTimeoutMs, previousLoopTimeoutMs + MIN_LOOP_TIMEOUT_STEP_MS, loopTargetFromCall, loopTargetFromObserved),
  );
  const hasInteractiveObservation = normalizePositiveInt(signal.observedInteractiveTurnTimeoutMs, 0) > 0;
  const nextInteractiveTurnTimeoutMs = hasInteractiveObservation
    ? Math.min(
      MAX_INTERACTIVE_TIMEOUT_MS,
      Math.max(
        previousInteractiveTurnTimeoutMs,
        previousInteractiveTurnTimeoutMs + MIN_INTERACTIVE_TIMEOUT_STEP_MS,
        nextLoopTimeoutMs,
        bumpTimeout(
          previousInteractiveTurnTimeoutMs,
          signal.observedInteractiveTurnTimeoutMs,
          MIN_INTERACTIVE_TIMEOUT_STEP_MS,
          MAX_INTERACTIVE_TIMEOUT_MS,
        ),
      ),
    )
    : previousInteractiveTurnTimeoutMs;

  if (
    nextCallTimeoutMs === previousCallTimeoutMs
    && nextLoopTimeoutMs === previousLoopTimeoutMs
    && nextInteractiveTurnTimeoutMs === previousInteractiveTurnTimeoutMs
  ) {
    return {
      applied: false,
      reason: 'already_at_cap',
      previousCallTimeoutMs,
      previousLoopTimeoutMs,
      previousInteractiveTurnTimeoutMs,
      nextCallTimeoutMs,
      nextLoopTimeoutMs,
      nextInteractiveTurnTimeoutMs,
    };
  }

  updateConfig('tools.loops.llm_call_timeout_ms', nextCallTimeoutMs);
  updateConfig('tools.loops.max_elapsed_ms', nextLoopTimeoutMs);
  if (nextInteractiveTurnTimeoutMs !== previousInteractiveTurnTimeoutMs) {
    updateConfig('telegram.interactive_turn_timeout_ms', nextInteractiveTurnTimeoutMs);
  }

  window.lastAppliedAt = now;
  window.timeoutTimestamps = [];
  state.set(key, window);

  try {
    logEvent(
      'autonomous_timeout_tuned',
      'tenant',
      signal.tenantId,
      {
        scope: signal.scope,
        chat_id: signal.chatId,
        task_id: signal.taskId,
        iteration: signal.iteration,
        previous_llm_call_timeout_ms: previousCallTimeoutMs,
        next_llm_call_timeout_ms: nextCallTimeoutMs,
        previous_max_elapsed_ms: previousLoopTimeoutMs,
        next_max_elapsed_ms: nextLoopTimeoutMs,
        previous_interactive_turn_timeout_ms: previousInteractiveTurnTimeoutMs,
        next_interactive_turn_timeout_ms: nextInteractiveTurnTimeoutMs,
        observed_call_timeout_ms: signal.observedCallTimeoutMs,
        observed_loop_timeout_ms: signal.observedLoopTimeoutMs,
        observed_interactive_turn_timeout_ms: signal.observedInteractiveTurnTimeoutMs,
        detail: signal.detail?.slice(0, 500),
      },
      signal.tenantId,
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist autonomous timeout tuning event');
  }

  logger.warn({
    tenantId: signal.tenantId,
    scope: signal.scope,
    previousCallTimeoutMs,
    nextCallTimeoutMs,
    previousLoopTimeoutMs,
    nextLoopTimeoutMs,
    previousInteractiveTurnTimeoutMs,
    nextInteractiveTurnTimeoutMs,
  }, 'Autonomous timeout tuning applied');

  return {
    applied: true,
    reason: 'timeout_budget_increased',
    previousCallTimeoutMs,
    previousLoopTimeoutMs,
    previousInteractiveTurnTimeoutMs,
    nextCallTimeoutMs,
    nextLoopTimeoutMs,
    nextInteractiveTurnTimeoutMs,
  };
}

export function resetAutonomousTimeoutState(): void {
  state.clear();
}
