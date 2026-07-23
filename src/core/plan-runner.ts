/**
 * Plan Runner — durable, detached execution of decomposed plan DAGs.
 *
 * The interactive turn is the wrong lifetime for a multi-step plan: turns get
 * cancelled, time out, and die with page refreshes and process restarts. This
 * module runs a plan DAG DETACHED from any turn:
 *
 *   - Plan state lives in the `tasks` table (root plan task + child subtasks).
 *     The DB is the single source of truth — never LLM context memory.
 *   - Execution is fire-and-forget from the caller's perspective; progress
 *     flows through the existing event pipeline (progress-reporter → event bus
 *     → WebSocket → session timeline).
 *   - Completion is delivered by the RUNTIME (persisted assistant message +
 *     broadcast), never invented by the Brain.
 *   - Incomplete plans are resumed at process startup (`resumeIncompletePlans`)
 *     with a per-root attempt cap so a poison plan cannot crash-loop tokens.
 */

import pino from 'pino';
import { getClient, getClientForRole } from './model-router.js';
import { getConfig } from '../config/index.js';
import {
  create,
  getById,
  listTasks,
  listPlanRootTasks,
  updateStatus,
  incrementAttempts,
  resetAttempts,
  updateTask,
  PLAN_ROOT_TAG,
  type TaskRecord,
} from '../store/task-dag.js';
import {
  persistTaskMetadata,
  loadTaskMetadata,
  persistTaskResult,
  loadTaskResult,
} from '../tasks/workspace.js';
import { executeDag } from './dag-executor.js';
import { emit } from '../progress/event-bus.js';
import { log as logEvent } from '../store/events.js';
import type { LLMClient } from './llm.js';
import type { DecomposeTaskInput } from './dag-bridge.js';
import { getSessionPermissionLevel, getSessionScopeGrants } from '../memory/sessions.js';
import { startTurnEnvelope, setTurnEnvelopeStatus } from '../memory/turn-envelopes.js';
import type { TurnOrigin } from './turn-envelope.js';
import { isValidLevel, type PermissionLevel } from '../security/permissions.js';
import type { ToolContext } from '../tools/types.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { defaultChatOptionsForSurface } from './llm-surface.js';
import type { ExecutionModelSnapshot } from './execution-model.js';
import { isExecutionModelSnapshot } from './execution-model.js';
import { rejectUnsupportedSandboxReferences } from './output-reference-policy.js';
import { isValidDelegationSystemPrompt, requireDelegationSystemPrompt } from './delegation-prompt.js';
import {
  verifyPlanSemantics,
  type PlanSemanticVerification,
} from './plan-semantic-verifier.js';

const logger = pino({ name: 'mozi:plan-runner' });

/** Statuses that mean a task no longer needs execution. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Max detached run attempts per plan root (creation run + resumes). */
const MAX_PLAN_RUN_ATTEMPTS = 3;

/** In-memory guard against double-running the same plan in one process. */
export interface PlanRunOutcome {
  rootTaskId: string;
  success: boolean;
  content: string;
  retryableFailure?: boolean;
}

const activeRuns = new Map<string, {
  startedAt: number;
  chatId: string;
  completion: Promise<PlanRunOutcome>;
}>();

interface ArtifactDeliveryState {
  pending: Set<Promise<void>>;
  failures: string[];
}

/** Artifact timeline persistence is async because of the websocket layering
 * boundary. Acceptance verification must wait for it, otherwise a fast DAG can
 * verify before its completed artifact becomes durable. */
const artifactDeliveryStates = new Map<string, ArtifactDeliveryState>();

function artifactDeliveryState(rootTaskId: string): ArtifactDeliveryState {
  let state = artifactDeliveryStates.get(rootTaskId);
  if (!state) {
    state = { pending: new Set(), failures: [] };
    artifactDeliveryStates.set(rootTaskId, state);
  }
  return state;
}

function broadcastPlanSessionActivity(ctx: PlanRunContext): void {
  if (!ctx.sessionId) return;
  emit({
    type: 'session_activity_changed',
    tenantId: ctx.tenantId,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
  });
}

/**
 * Push this background turn's envelope to live clients (Issue #714).
 *
 * Without it a client that never reloads has no `startedAt` for the background
 * turn and falls back to parsing an epoch out of the turn id — but a background
 * id is `turn_bg_${rootTaskId}`, which has none, so the turn sorts last and its
 * result renders after messages the user sent later.
 *
 * Deliberately its own event rather than a `turn_state` emit: `turn_state` also
 * drives `workspace_session_state`, and a background turn running concurrently
 * with the foreground has no standing to move the session's FSM.
 *
 * Call only after the envelope transition is durable — a live frame that outran
 * its own row would disagree with a simultaneous REST restore.
 */
function broadcastPlanTurnEnvelope(ctx: PlanRunContext, turnId: string): void {
  if (!ctx.sessionId) return;
  emit({
    type: 'turn_envelope_updated',
    tenantId: ctx.tenantId,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
    turnId,
  });
}

export interface PlanRunContext {
  tenantId: string;
  chatId: string;
  channelType?: string;
  sessionId?: string;
  userId?: string;
  permissionLevel?: PermissionLevel;
  turnId?: string;
  /** Foreground source identity and exact user-authored acceptance request. */
  sourceTurnId?: string;
  originalRequest?: string;
  /** Presentation locale resolved at plan admission (dag-bridge). Stamped on
   *  the background turn envelope so card labels follow the plan's language. */
  locale?: string;
  systemPrompt: string;
  fallbackClient?: LLMClient;
  executionModel?: ExecutionModelSnapshot;
  useSubAgents?: boolean;
  subagentRuntimeSource?: string;
  subagentSessionKey?: string;
  deliveryMode?: 'direct' | 'caller';
  turnOrigin?: TurnOrigin;
}

function resolvePlanPermissionLevel(ctx: PlanRunContext): PermissionLevel | undefined {
  if (ctx.sessionId) {
    const current = getSessionPermissionLevel(ctx.sessionId, ctx.tenantId);
    if (current) return current;
  }
  return ctx.permissionLevel && isValidLevel(ctx.permissionLevel) ? ctx.permissionLevel : undefined;
}

/**
 * Stable, distinct Turn Envelope identity for a detached plan run (Issue #626).
 *
 * A detached plan is its OWN background turn, NOT part of the foreground turn that
 * spawned it. Deriving the id from the root task keeps it stable across a resume
 * and guarantees it never collides with an interactive `turn_*` id — so plan step
 * events and the completion message group under one background MOZI turn instead of
 * corrupting the (usually already-terminal) foreground turn's chronology.
 */
export function planBackgroundTurnId(rootTaskId: string): string {
  return `turn_bg_${rootTaskId}`;
}

/** Exported for tests: the ToolContext every detached plan step executes with. */
export function buildPlanToolContext(rootTaskId: string, ctx: PlanRunContext): ToolContext | undefined {
  const permissionLevel = resolvePlanPermissionLevel(ctx);
  if (!permissionLevel) return undefined;
  const { sessionId, userId, tenantId } = ctx;
  return {
    chatId: ctx.chatId,
    channelType: ctx.channelType,
    taskId: rootTaskId,
    tenantId,
    sessionId,
    userId,
    // All tool/artifact events emitted by this plan carry the background turn id,
    // so the persist path stamps them onto the background turn rather than
    // backfilling whatever foreground turn happens to be active (Issue #626).
    turnId: planBackgroundTurnId(rootTaskId),
    agentId: rootTaskId,
    permissionLevel,
    // Unattended discipline (#824) keys off turnOrigin in the executor's
    // approval branches. Detached plan steps run through THIS context, not the
    // gateway handler's — omitting the field here silently revived the
    // interactive approval wait for scheduled plans (2026-07-22 incident).
    turnOrigin: ctx.turnOrigin,
    scopeGrants: sessionId ? getSessionScopeGrants(sessionId, tenantId) : [],
    // Artifacts created by plan steps must reach the session timeline (and any
    // live UI) through the same persist-then-broadcast path interactive turns
    // use — otherwise the deliverable exists only as a disk file the browser
    // cannot open. Dynamic import mirrors deliverPlanCompletion (layering).
    onArtifact: sessionId && userId
      ? (event: ArtifactEvent) => {
          const state = artifactDeliveryState(rootTaskId);
          const delivery = import('../channels/websocket.js')
            .then(({ broadcastArtifactEvent }) => broadcastArtifactEvent(
              event,
              userId,
              sessionId,
              tenantId,
              planBackgroundTurnId(rootTaskId),
            ))
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              state.failures.push(message);
              logger.warn({ rootTaskId, err: message }, 'Failed to broadcast plan artifact event');
            })
            .finally(() => state.pending.delete(delivery));
          state.pending.add(delivery);
        }
      : undefined,
    executionModel: ctx.executionModel,
    systemPrompt: ctx.systemPrompt,
  };
}

export interface CreatedPlan {
  rootTaskId: string;
  goal: string;
  steps: Array<{ taskId: string; title: string; dependsOn: string[] }>;
}

/**
 * Persist a plan as a root task + child subtask rows. Pure creation — does
 * not execute anything. The root row carries PLAN_ROOT_TAG and its workspace
 * metadata records the delivery target (chat/session) and the system prompt
 * for resume.
 */
export function createPlanTasks(plan: DecomposeTaskInput, ctx: PlanRunContext): CreatedPlan {
  const systemPrompt = requireDelegationSystemPrompt(ctx.systemPrompt);
  const root = create({
    tenant_id: ctx.tenantId,
    title: plan.goal.slice(0, 200),
    objective: plan.goal,
    done_criteria: 'Every explicit requirement in the original user request is supported by persisted results and artifacts.',
    tags: [PLAN_ROOT_TAG],
    constraints: {},
  });

  const taskIds: string[] = [];
  const steps: CreatedPlan['steps'] = [];
  for (let i = 0; i < plan.subtasks.length; i++) {
    const sub = plan.subtasks[i];
    const dependsOn = sub.depends_on.map((idx) => taskIds[idx]);
    const record = create({
      tenant_id: ctx.tenantId,
      parent_task_id: root.id,
      title: sub.title,
      objective: sub.objective,
      done_criteria: sub.done_criteria,
      depends_on: dependsOn,
      agent_type_hint: sub.agent_type_hint,
      constraints: {
        timeout_seconds: sub.constraints.timeout_seconds,
        max_retries: sub.constraints.max_retries ?? 2,
        max_tokens: sub.constraints.max_tokens,
      },
      priority: i,
      tags: [],
    });
    taskIds.push(record.id);
    // Carry the store-owned dependency edges so presentation consumers reuse
    // this mapping instead of re-deriving it from index alignment (Issue #735).
    steps.push({ taskId: record.id, title: sub.title, dependsOn });
  }

  persistTaskMetadata(root.id, {
    task_id: root.id,
    title: root.title,
    objective: root.objective,
    status: root.status,
    created_at: root.created_at,
    workspace_path: '',
    chat_id: ctx.chatId,
    channel_type: ctx.channelType,
    session_id: ctx.sessionId,
    user_id: ctx.userId,
    permission_level: resolvePlanPermissionLevel(ctx),
    plan_goal: plan.goal,
    source_turn_id: ctx.sourceTurnId,
    source_request: ctx.originalRequest ?? plan.goal,
    system_prompt: systemPrompt,
    execution_model: ctx.executionModel,
    plan_locale: ctx.locale,
    plan_delivery_mode: ctx.deliveryMode ?? 'direct',
    plan_turn_origin: ctx.turnOrigin ?? 'background',
  });

  logEvent('plan_created', 'task', root.id, {
    goal: plan.goal,
    step_count: steps.length,
    chat_id: ctx.chatId,
    session_id: ctx.sessionId ?? null,
  }, ctx.tenantId);

  return { rootTaskId: root.id, goal: plan.goal, steps };
}

/** Children of a plan root, in priority order. */
export function getPlanSteps(rootTaskId: string, tenantId: string): TaskRecord[] {
  return listTasks({ tenant_id: tenantId, parent_task_id: rootTaskId });
}

export function isPlanRunActive(rootTaskId: string): boolean {
  return activeRuns.has(rootTaskId);
}

function persistedPlanOutcome(rootTaskId: string, tenantId: string): PlanRunOutcome | null {
  const root = getById(rootTaskId, tenantId);
  if (!root || !TERMINAL.has(root.status)) return null;
  const persisted = loadTaskResult(rootTaskId);
  const completionContent = typeof persisted?.metadata?.completion_content === 'string'
    ? persisted.metadata.completion_content
    : persisted?.output;
  return {
    rootTaskId,
    success: root.status === 'completed' && persisted?.success === true,
    content: completionContent?.trim() || `Plan ${root.status}.`,
    retryableFailure: persisted?.metadata?.retryable_failure === true,
  };
}

export async function waitForPlanRun(
  rootTaskId: string,
  tenantId = 'default',
  signal?: AbortSignal,
): Promise<PlanRunOutcome> {
  const active = activeRuns.get(rootTaskId);
  const completion = active?.completion ?? Promise.resolve(persistedPlanOutcome(rootTaskId, tenantId)).then(outcome => {
    if (!outcome) throw new Error(`Plan ${rootTaskId} is not active or terminal`);
    return outcome;
  });
  if (!signal) return completion;
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Scheduled plan wait aborted');
  return await Promise.race([
    completion,
    new Promise<PlanRunOutcome>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Scheduled plan wait aborted'));
      }, { once: true });
    }),
  ]);
}

interface RestartPlanFromMetadataOptions {
  tenantId?: string;
  systemPrompt: string;
  fallbackClient?: LLMClient;
  normalizeStrandedSteps?: boolean;
  retryFailedSteps?: boolean;
}

export function restartPlanFromMetadata(
  rootTaskId: string,
  options: RestartPlanFromMetadataOptions,
): { started: boolean; reason?: string } {
  const currentSystemPrompt = requireDelegationSystemPrompt(options.systemPrompt);
  const tenantId = options.tenantId ?? 'default';
  const root = getById(rootTaskId, tenantId);
  if (!root) return { started: false, reason: 'plan not found' };

  const meta = loadTaskMetadata(rootTaskId);
  if (!meta?.chat_id) {
    updateStatus(rootTaskId, 'failed', tenantId, { reason: 'unresumable: missing plan metadata' });
    return { started: false, reason: 'no delivery metadata' };
  }
  const systemPrompt = isValidDelegationSystemPrompt(meta.system_prompt)
    ? meta.system_prompt
    : currentSystemPrompt;
  if (meta.system_prompt !== systemPrompt) {
    persistTaskMetadata(rootTaskId, { ...meta, system_prompt: systemPrompt });
  }
  if (root.attempts >= MAX_PLAN_RUN_ATTEMPTS) {
    updateStatus(rootTaskId, 'failed', tenantId, { reason: 'plan run attempt cap reached' });
    return { started: false, reason: 'attempt cap reached' };
  }

  if (options.normalizeStrandedSteps) {
    for (const step of getPlanSteps(rootTaskId, tenantId)) {
      if (step.status === 'running' || step.status === 'assigned') {
        updateStatus(step.id, 'ready', tenantId, { reason: 'normalized at boot resume' });
      }
    }
  }
  if (options.retryFailedSteps) {
    for (const step of getPlanSteps(rootTaskId, tenantId)) {
      if (step.status !== 'failed' && step.status !== 'blocked') continue;
      const constraints = { ...step.constraints };
      delete constraints.blocked_by_task_id;
      delete constraints.blocked_reason;
      delete constraints.guard_reason;
      delete constraints.failure_retryable;
      delete constraints.retry_window_started_at;
      updateTask(step.id, { constraints }, tenantId);
      resetAttempts(step.id, tenantId);
      updateStatus(step.id, 'pending', tenantId, { reason: 'outer retry re-entry' });
    }
  }

  const executionModel = isExecutionModelSnapshot(meta.execution_model)
    ? meta.execution_model
    : undefined;
  let fallbackClient = options.fallbackClient;
  if (executionModel) {
    try {
      fallbackClient = getClient({
        ...executionModel,
        role: 'brain',
        tenantId,
        userId: meta.user_id,
      });
    } catch (err) {
      logger.warn({ rootTaskId, executionModel, err: err instanceof Error ? err.message : String(err) }, 'Failed to restore persisted execution model');
    }
  }

  const started = startDetachedPlanRun(rootTaskId, {
    tenantId,
    chatId: meta.chat_id,
    channelType: meta.channel_type,
    sessionId: meta.session_id,
    userId: meta.user_id,
    permissionLevel: isValidLevel(meta.permission_level ?? '') ? meta.permission_level as PermissionLevel : undefined,
    locale: typeof meta.plan_locale === 'string' ? meta.plan_locale : undefined,
    sourceTurnId: typeof meta.source_turn_id === 'string' ? meta.source_turn_id : undefined,
    originalRequest: typeof meta.source_request === 'string' ? meta.source_request : (meta.plan_goal ?? root.objective),
    systemPrompt,
    fallbackClient,
    executionModel,
    deliveryMode: meta.plan_delivery_mode === 'caller' ? 'caller' : 'direct',
    turnOrigin: meta.plan_turn_origin,
  });
  return started ? { started } : { started: false, reason: 'start refused' };
}

/**
 * Start (or resume) a detached run of a plan root. Returns immediately.
 * All observable effects flow through the DB and the event bus.
 */
export function startDetachedPlanRun(rootTaskId: string, ctx: PlanRunContext): boolean {
  const systemPrompt = requireDelegationSystemPrompt(ctx.systemPrompt);
  const runContext = { ...ctx, systemPrompt };
  if (activeRuns.has(rootTaskId)) {
    logger.warn({ rootTaskId }, 'Plan run already active in this process — not starting another');
    return false;
  }
  const root = getById(rootTaskId, ctx.tenantId);
  if (!root) {
    logger.error({ rootTaskId }, 'Plan root not found — cannot start run');
    return false;
  }
  if (root.attempts >= MAX_PLAN_RUN_ATTEMPTS) {
    updateStatus(rootTaskId, 'failed', ctx.tenantId, { reason: 'plan run attempt cap reached' });
    logger.warn({ rootTaskId, attempts: root.attempts }, 'Plan run attempt cap reached — marking failed');
    return false;
  }

  incrementAttempts(rootTaskId, ctx.tenantId);
  updateStatus(rootTaskId, 'running', ctx.tenantId);

  const completion = runPlan(rootTaskId, runContext)
    .catch((err) => {
      // runPlan handles its own errors; this catch is the last-resort guard so
      // a detached rejection can never become an unhandled promise crash.
      logger.error({
        rootTaskId,
        err: err instanceof Error ? err.message : String(err),
      }, 'Detached plan run crashed outside runPlan error handling');
      try {
        updateStatus(rootTaskId, 'failed', ctx.tenantId, { reason: 'detached run crashed' });
      } catch { /* DB unavailable — nothing left to do */ }
      return {
        rootTaskId,
        success: false,
        content: err instanceof Error ? err.message : String(err),
      };
    })
    .finally(() => {
      activeRuns.delete(rootTaskId);
      artifactDeliveryStates.delete(rootTaskId);
    });
  activeRuns.set(rootTaskId, { startedAt: Date.now(), chatId: ctx.chatId, completion });
  void completion;

  return true;
}

async function runPlan(rootTaskId: string, ctx: PlanRunContext): Promise<PlanRunOutcome> {
  const steps = getPlanSteps(rootTaskId, ctx.tenantId);
  const incomplete = steps.filter((step) => !TERMINAL.has(step.status));
  const startedAt = Date.now();
  const backgroundTurnId = planBackgroundTurnId(rootTaskId);

  logger.info({
    rootTaskId,
    totalSteps: steps.length,
    incompleteSteps: incomplete.length,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
  }, 'Detached plan run starting');

  // Record the background Turn Envelope (Issue #626). This is a distinct,
  // origin='background' turn — never the foreground turn that spawned the plan.
  // Idempotent per (session, turnId), so a resume keeps the original started_at.
  if (ctx.sessionId) {
    try {
      startTurnEnvelope({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        chatId: ctx.chatId,
        turnId: backgroundTurnId,
        origin: ctx.turnOrigin ?? 'background',
        // The plan's presentation locale, resolved at admission — without it
        // the envelope stayed NULL until the completion delivery stamped it
        // from the completion TEXT's language, and every live card label
        // followed the UI language instead of the task's (mixed-language card).
        locale: ctx.locale,
        startedAt,
      });
      broadcastPlanTurnEnvelope(ctx, backgroundTurnId);
      broadcastPlanSessionActivity(ctx);
    } catch (err) {
      logger.warn({ rootTaskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to start background turn envelope');
    }
  }

  let output = '';
  let failedMessage: string | null = null;

  if (incomplete.length > 0) {
    try {
      output = await executeDag(
        incomplete,
        ctx.systemPrompt,
        ctx.chatId,
        undefined,
        ctx.fallbackClient,
        backgroundTurnId,
        {
          useSubAgents: ctx.useSubAgents === true,
          subagentRuntimeSource: ctx.subagentRuntimeSource,
          subagentSessionKey: ctx.subagentSessionKey,
          sessionId: ctx.sessionId,
          toolContext: buildPlanToolContext(rootTaskId, ctx),
        },
      );
    } catch (err) {
      failedMessage = err instanceof Error ? err.message : String(err);
      logger.error({ rootTaskId, err: failedMessage }, 'Plan DAG execution threw');
    }
  }

  const artifactState = artifactDeliveryStates.get(rootTaskId);
  if (artifactState?.pending.size) {
    await Promise.allSettled([...artifactState.pending]);
  }
  if (artifactState?.failures.length && failedMessage === null) {
    failedMessage = `Artifact persistence failed: ${artifactState.failures[0]}`;
  }

  // Re-read child statuses from the DB — the single source of truth.
  const finalSteps = getPlanSteps(rootTaskId, ctx.tenantId);
  const completed = finalSteps.filter((s) => s.status === 'completed').length;
  const cancelled = finalSteps.filter((s) => s.status === 'cancelled').length;
  const failedOnly = finalSteps.filter((s) => s.status === 'failed').length;
  const blocked = finalSteps.filter((s) => s.status === 'blocked').length;
  const failed = failedOnly + cancelled;
  const unfinished = finalSteps.length - completed - failed - blocked;
  const rootWasCancelled = getById(rootTaskId, ctx.tenantId)?.status === 'cancelled';
  const planCancelled = rootWasCancelled;
  const structurallySucceeded = failedMessage === null && failed === 0 && blocked === 0 && unfinished === 0;
  const retryableFailure = !planCancelled
    && failedMessage === null
    && failedOnly > 0
    && finalSteps.filter((step) => step.status === 'failed')
      .every((step) => step.constraints.failure_retryable === true);
  let semanticVerification: PlanSemanticVerification | undefined;
  if (structurallySucceeded) {
    const root = getById(rootTaskId, ctx.tenantId);
    const meta = loadTaskMetadata(rootTaskId);
    const planGoal = root?.objective || root?.title || rootTaskId;
    semanticVerification = await verifyPlanSemantics({
      rootTaskId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      turnId: backgroundTurnId,
      originalRequest: ctx.originalRequest ?? meta?.source_request ?? planGoal,
      planGoal,
      steps: finalSteps,
      client: ctx.fallbackClient,
    });
    if (semanticVerification.outcome === 'failed') {
      failedMessage = `Semantic verification failed: ${semanticVerification.summary}`;
      logger.warn({
        rootTaskId,
        verdict: semanticVerification.verdict,
        findings: semanticVerification.findings,
      }, 'Structurally complete plan failed semantic verification');
    }
  }
  const qualityUnverified = semanticVerification?.outcome === 'unverified';
  const planSucceeded = structurallySucceeded && semanticVerification?.outcome !== 'failed';

  updateStatus(rootTaskId, planCancelled ? 'cancelled' : planSucceeded ? 'completed' : 'failed', ctx.tenantId, {
    completed_steps: completed,
    failed_steps: failedOnly,
    cancelled_steps: cancelled,
    blocked_steps: blocked,
    unfinished_steps: unfinished,
  });

  try {
    persistTaskResult(rootTaskId, {
      task_id: rootTaskId,
      success: planSucceeded,
      output: output || failedMessage || '(no output)',
      tokens_used: 0,
      elapsed_ms: Date.now() - startedAt,
      completed_at: new Date().toISOString(),
      metadata: {
        completed,
        failed: failedOnly,
        cancelled,
        blocked,
        unfinished,
        total: finalSteps.length,
        structurally_succeeded: structurallySucceeded,
        retryable_failure: retryableFailure,
        quality_unverified: qualityUnverified,
        semantic_verification: semanticVerification,
      },
    });
  } catch (err) {
    logger.warn({
      rootTaskId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist plan result');
  }

  emit({
    type: planCancelled ? 'task_cancelled' : planSucceeded ? 'background_agent_complete' : 'background_agent_failed',
    taskId: rootTaskId,
    taskTitle: getById(rootTaskId, ctx.tenantId)?.title,
    totalTasks: finalSteps.length,
    completedTasks: completed,
    error: failedMessage
      ?? (failed > 0 ? `${failed} step(s) failed` : blocked > 0 ? `${blocked} step(s) blocked` : undefined),
    chatId: ctx.chatId,
    tenantId: ctx.tenantId,
    sessionId: ctx.sessionId,
  });

  // Terminalize the background Turn Envelope (Issue #626) before delivery so a
  // reload sees an honest completed/failed background turn, not a zombie active one.
  if (ctx.sessionId) {
    try {
      setTurnEnvelopeStatus({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        turnId: backgroundTurnId,
        status: planCancelled ? 'cancelled' : planSucceeded ? 'completed' : 'failed',
      });
      broadcastPlanTurnEnvelope(ctx, backgroundTurnId);
      broadcastPlanSessionActivity(ctx);
    } catch (err) {
      logger.warn({ rootTaskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to terminalize background turn envelope');
    }
    // Plan steps stamp every document `workspace` (working notes, Issue #746)
    // — but the LAST completed document IS the deliverable the user asked
    // for. Promote it to `primary` so the turn ends with a hero card, not a
    // text wall whose prose claims cards that never rendered (operator
    // report 2026-07-18). Runs for failed plans too: a delivered brief that
    // failed verification still exists and must be reachable.
    if (ctx.userId && !planCancelled) {
      try {
        const { demoteDataFilePrimariesOnTurn, findLatestWorkspaceDocumentOnTurn } = await import('../memory/session-timeline.js');
        const { broadcastArtifactEvent } = await import('../channels/websocket.js');
        // Turn-wide curation backstop BEFORE the promotion query: the live file
        // tracker is per step, so a dataset another step downloaded can still
        // hold `primary` here — which would both hero-card the raw input and
        // trip the promotion guard, hiding the real deliverable (HIGH-1 review
        // finding, 2026-07-18). Demotion writes the DB directly; these patches
        // only mirror it to live clients.
        const demotedIds = demoteDataFilePrimariesOnTurn({
          tenantId: ctx.tenantId,
          sessionId: ctx.sessionId,
          turnId: backgroundTurnId,
        });
        for (const demotedId of demotedIds) {
          broadcastArtifactEvent(
            { type: 'patch', artifactId: demotedId, patch: { data: { role: 'supporting' } } },
            ctx.userId,
            ctx.sessionId,
            ctx.tenantId,
            backgroundTurnId,
          );
        }
        const deliverableId = findLatestWorkspaceDocumentOnTurn({
          tenantId: ctx.tenantId,
          sessionId: ctx.sessionId,
          turnId: backgroundTurnId,
        });
        if (deliverableId) {
          broadcastArtifactEvent(
            { type: 'patch', artifactId: deliverableId, patch: { data: { role: 'primary' } } },
            ctx.userId,
            ctx.sessionId,
            ctx.tenantId,
            backgroundTurnId,
          );
        }
      } catch (err) {
        logger.warn({ rootTaskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to promote plan deliverable');
      }
    }
    // The semantic verification is internal QA machinery, not a user-facing
    // step. It never gets its own timeline row (users repeatedly rejected the
    // "结果质量校验" row as noise, especially when it dumped verifier reasoning
    // and evidence IDs). Its outcome still lands honestly in the run's terminal
    // status and the final completion message: a genuine quality failure sets
    // `failedMessage` above, so the delivered message states it in plain prose
    // without hiding it.
  }

  const completionSummary: PlanCompletionSummary = {
    planSucceeded,
    completed,
    failed: failedOnly,
    cancelled,
    blocked,
    unfinished,
    total: finalSteps.length,
    output,
    failedMessage,
    semanticVerification,
  };
  const completionContent = planCancelled
    ? (ctx.locale === 'zh-CN' ? '计划已取消。' : 'Plan cancelled.')
    : await deliverPlanCompletion(
        rootTaskId,
        ctx,
        completionSummary,
        ctx.deliveryMode !== 'caller',
      );
  try {
    persistTaskResult(rootTaskId, {
      task_id: rootTaskId,
      success: planSucceeded,
      output: output || failedMessage || '(no output)',
      tokens_used: 0,
      elapsed_ms: Date.now() - startedAt,
      completed_at: new Date().toISOString(),
      metadata: {
        completed,
        failed: failedOnly,
        cancelled,
        blocked,
        unfinished,
        total: finalSteps.length,
        structurally_succeeded: structurallySucceeded,
        retryable_failure: retryableFailure,
        quality_unverified: qualityUnverified,
        semantic_verification: semanticVerification,
        completion_content: completionContent,
      },
    });
  } catch (err) {
    logger.warn({ rootTaskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to persist plan completion content');
  }
  return { rootTaskId, success: planSucceeded, content: completionContent, retryableFailure };
}

interface PlanCompletionSummary {
  planSucceeded: boolean;
  completed: number;
  failed: number;
  cancelled: number;
  blocked: number;
  unfinished: number;
  total: number;
  output: string;
  failedMessage: string | null;
  semanticVerification?: PlanSemanticVerification;
}

interface StepDetail {
  title: string;
  status: string;
  excerpt: string;
}

const STEP_EXCERPT_CHARS = 2000;
const TOTAL_EXCERPT_CHARS = 9000;

function hasCjk(text: string): boolean {
  return /[㐀-鿿]/.test(text);
}

/** Load per-step persisted results, capped so the summary prompt stays bounded. */
function collectStepDetails(rootTaskId: string, tenantId: string): StepDetail[] {
  let budget = TOTAL_EXCERPT_CHARS;
  return getPlanSteps(rootTaskId, tenantId).map((step) => {
    let excerpt = '';
    try {
      const persisted = loadTaskResult(step.id);
      const out = (persisted?.output ?? '').trim();
      if (out && budget > 0) {
        excerpt = out.slice(0, Math.min(STEP_EXCERPT_CHARS, budget));
        budget -= excerpt.length;
      }
    } catch { /* missing result files are fine — status still reported */ }
    return { title: step.title, status: step.status, excerpt };
  });
}

function statsLineFor(summary: PlanCompletionSummary): string {
  return `Steps: ${summary.completed}/${summary.total} completed`
    + (summary.cancelled > 0 ? `, ${summary.cancelled} cancelled` : '')
    + (summary.failed > 0 ? `, ${summary.failed} failed` : '')
    + (summary.blocked > 0 ? `, ${summary.blocked} blocked` : '')
    + (summary.unfinished > 0 ? `, ${summary.unfinished} unfinished` : '');
}

/** Localized problem-step status word for the fallback prose. */
function problemStatusWord(status: string, isZh: boolean): string {
  switch (status) {
    case 'failed': return isZh ? '失败' : 'failed';
    case 'cancelled': return isZh ? '已取消' : 'cancelled';
    case 'blocked': return isZh ? '被上游阻塞' : 'blocked by an earlier step';
    default: return isZh ? '未完成' : 'unfinished';
  }
}

/**
 * Compact runtime-truth fallback when the Brain summary is unavailable.
 * Presentation matrix: step/tool COUNTS are never user-facing prose, and the
 * plan card already shows every phase with its state — so failure prose names
 * only the problem steps, in the goal's language, with no "Steps: N/N" stats
 * and no raw internal status tokens.
 */
function buildCompletionFallback(
  goal: string,
  summary: PlanCompletionSummary,
  stepDetails: StepDetail[],
  locale?: string,
): string {
  const isZh = locale === 'zh-CN' || (locale === undefined && hasCjk(goal));
  if (summary.semanticVerification?.outcome === 'unverified') {
    const reason = [summary.semanticVerification.summary, summary.semanticVerification.findings[0]]
      .filter(Boolean)
      .join(' — ');
    return isZh
      ? `交付物已生成，但质量未经校验。原因：${reason}\n\n各步骤详情见任务计划卡片。`
      : `The deliverable was produced, but its quality was not verified. Reason: ${reason}\n\nStep details are in the plan card.`;
  }
  const header = summary.planSucceeded
    ? (isZh ? `计划完成:${goal}` : `Plan completed: ${goal}`)
    : (isZh ? `计划结束(有问题):${goal}` : `Plan finished with problems: ${goal}`);
  // Only the steps that went wrong — the plan card carries the full phase list.
  const problemLines = summary.planSucceeded
    ? []
    : stepDetails
        .filter((s) => s.status !== 'completed')
        .map((s) => `- ${s.title} — ${problemStatusWord(s.status, isZh)}`);
  const lastWithOutput = summary.planSucceeded
    ? [...stepDetails].reverse().find((s) => s.status === 'completed' && s.excerpt)
    : undefined;
  const tail = lastWithOutput
    ? lastWithOutput.excerpt.slice(0, 600)
    : (summary.failedMessage ? `${isZh ? '执行错误' : 'Execution error'}: ${summary.failedMessage}` : '');
  const verification = summary.semanticVerification?.required
    ? [
        `${isZh ? '语义校验' : 'Semantic verification'}: ${summary.semanticVerification.verdict}`,
        summary.semanticVerification.summary,
        ...summary.semanticVerification.findings.slice(0, 3).map((finding) => `- ${finding}`),
      ].join('\n')
    : '';
  const cardHint = isZh ? '各步骤详情见任务计划卡片。' : 'Step details are in the plan card.';
  return [header, '', ...problemLines, verification ? '' : null, verification || null, tail ? '' : null, tail || null, '', cardHint]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Standard delivery shape (Claude Code / Codex pattern): completion re-invokes
 * the MODEL with the real persisted step results and the model writes the
 * user-facing report. Honesty holds because the inputs are runtime truth —
 * the model does expression, not invention. Falls back to the compact
 * template when no client is available or the call fails/returns empty.
 */
async function summarizePlanCompletionWithBrain(
  rootTaskId: string,
  ctx: PlanRunContext,
  goal: string,
  summary: PlanCompletionSummary,
  stepDetails: StepDetail[],
): Promise<string | null> {
  if (summary.semanticVerification?.outcome === 'unverified') return null;
  // Resolve client via the 'plan_summary' role (fallback chain: plan_summary → summary → brain).
  // ctx.fallbackClient is required — when absent the caller opted out of LLM summaries.
  // When present, try the plan_summary role first (may give a stronger/cheaper model);
  // fall back to ctx.fallbackClient if role resolution fails.
  if (!ctx.fallbackClient) return null;
  let summaryClient = ctx.fallbackClient;
  // Only use the plan_summary role when it is explicitly configured in model_router.roles.
  // This avoids silently replacing ctx.fallbackClient with a generic provider client and
  // preserves behavioral compatibility for callers that inject a specific client.
  const routerRoles = getConfig().model_router?.roles as Record<string, unknown> | undefined;
  const hasPlanSummaryRole = !!(routerRoles?.['plan_summary']);
  if (hasPlanSummaryRole) {
    try {
      const { client } = getClientForRole('plan_summary', ctx.fallbackClient);
      summaryClient = client;
    } catch {
      // Role resolution failed; use ctx.fallbackClient as-is
    }
  }
  const stepsBlock = stepDetails
    .map((s, i) => `### Step ${i + 1}: ${s.title}\nStatus: ${s.status}\n${s.excerpt || '(no persisted output)'}`)
    .join('\n\n');
  try {
    const response = await summaryClient.chat([
      {
        role: 'system',
        content: [
          'You are MOZI reporting the completion of a background plan to the user.',
          ctx.locale === 'zh-CN'
            ? 'Write ONLY the user-facing completion message in Simplified Chinese.'
            : 'Write ONLY the user-facing completion message in English.',
          'Ground every statement in the step results below — never invent progress, results, or files.',
          'Artifacts created during the plan (reports, documents, pages) are already shown to the user',
          'as openable cards in the conversation — reference them by title only.',
          'NEVER print internal file paths (e.g. /data/... or "Persisted at ...") — the user cannot open',
          'them and they read as broken links. Keep it under 250 words.',
          'If steps failed or were cancelled, state that plainly first. No emoji.',
          'If semantic verification did NOT pass, your FIRST sentence must state that the result',
          'failed verification and why — do NOT open with success language ("All steps completed",',
          '"Successfully...") when verification failed; completed steps do not outrank a failed check.',
          'NEVER state step or tool counts ("3/3 steps", "Steps: N/N") — the plan card already shows',
          'phase progress; describe outcomes, not tallies.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Goal: ${goal}`,
          `Outcome: ${statsLineFor(summary)}`,
          summary.failedMessage ? `Runner error: ${summary.failedMessage}` : null,
          summary.semanticVerification?.required
            ? `Semantic verification: ${JSON.stringify(summary.semanticVerification)}`
            : null,
          '',
          'Step results:',
          stepsBlock,
        ].filter((line): line is string => line !== null).join('\n'),
      },
    ], defaultChatOptionsForSurface('plan_summary', {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      taskId: rootTaskId,
      agentId: rootTaskId,
    }));
    // A summary the cap cut off mid-sentence must never reach the user (real
    // incident: a message ending "**Key findings from completed" delivered
    // verbatim). Same stop-reason contract brain-turn-handlers checks; the
    // runtime-truth fallback template is bounded by construction.
    if (
      response.truncated === true
      || response.incomplete === true
      || response.stop_reason === 'length'
      || response.stop_reason === 'max_tokens'
      || response.stop_reason === 'content_filter'
    ) {
      logger.warn({
        rootTaskId,
        stopReason: response.stop_reason,
        contentLength: (response.content ?? '').length,
      }, 'Brain plan-completion summary was truncated by the token cap; using compact fallback');
      return null;
    }
    const text = (response.content ?? '').trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn({
      rootTaskId: goal.slice(0, 60),
      err: err instanceof Error ? err.message : String(err),
    }, 'Brain plan-completion summary failed; falling back to compact template');
    return null;
  }
}

async function deliverPlanCompletion(
  rootTaskId: string,
  ctx: PlanRunContext,
  summary: PlanCompletionSummary,
  shouldDeliver = true,
): Promise<string> {
  const root = getById(rootTaskId, ctx.tenantId);
  const goal = root?.objective || root?.title || rootTaskId;
  const stepDetails = collectStepDetails(rootTaskId, ctx.tenantId);

  // Runtime-truth delivery: both paths report actual persisted task state.
  // The Brain path only rewords real results; it never narrates progress.
  const brainSummary = await summarizePlanCompletionWithBrain(rootTaskId, ctx, goal, summary, stepDetails);
  // No "Plan completed: … Steps: N/N" prefix on the Brain summary — the typed
  // plan card already carries goal and phase progress (presentation matrix:
  // step counts are never user-facing prose). The Brain text stands alone.
  const content = brainSummary || buildCompletionFallback(goal, summary, stepDetails, ctx.locale);
  const sanitized = rejectUnsupportedSandboxReferences(content);
  if (sanitized.rejectedCount > 0) {
    logger.warn({ rootTaskId, rejectedCount: sanitized.rejectedCount }, 'Rejected unsupported sandbox links from plan completion');
  }

  if (!shouldDeliver) {
    logger.info({ rootTaskId }, 'Plan completion retained for caller-owned delivery');
    return sanitized.content;
  }
  try {
    const { deliverAssistantMessage } = await import('../channels/websocket.js');
    const { delivered } = deliverAssistantMessage({
      tenantId: ctx.tenantId,
      chatId: ctx.chatId,
      sessionId: ctx.sessionId,
      content: sanitized.content,
      // Deliver under the plan's own background turn (Issue #626) so the completion
      // message can never backfill an unrelated foreground turn active right now.
      turnId: planBackgroundTurnId(rootTaskId),
      origin: ctx.turnOrigin ?? 'background',
    });
    logger.info({ rootTaskId, delivered, sessionId: ctx.sessionId }, 'Plan completion delivered');
  } catch (err) {
    logger.error({
      rootTaskId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to deliver plan completion message');
  }
  return sanitized.content;
}

/**
 * Resume incomplete plans at process startup.
 *
 * Runs regardless of clean/unclean shutdown: a `docker compose restart` is a
 * clean SIGTERM but still strands a running plan. Crash recovery (index.ts)
 * has already normalized orphaned running/assigned tasks by the time this is
 * called; here we additionally normalize plan children stranded in 'running'
 * (clean-shutdown case) and restart the detached run.
 */
export function resumeIncompletePlans(options: {
  tenantId?: string;
  systemPrompt: string;
  fallbackClient?: LLMClient;
}): { resumed: string[]; skipped: Array<{ rootTaskId: string; reason: string }> } {
  const tenantId = options.tenantId ?? 'default';
  const resumed: string[] = [];
  const skipped: Array<{ rootTaskId: string; reason: string }> = [];

  const roots = listPlanRootTasks(tenantId, { activeOnly: true });
  for (const root of roots) {
    const result = restartPlanFromMetadata(root.id, {
      tenantId,
      systemPrompt: options.systemPrompt,
      fallbackClient: options.fallbackClient,
      normalizeStrandedSteps: true,
    });
    if (result.started) {
      resumed.push(root.id);
      const meta = loadTaskMetadata(root.id);
      logEvent('plan_resumed', 'task', root.id, {
        chat_id: meta?.chat_id,
        session_id: meta?.session_id ?? null,
        attempt: root.attempts + 1,
      }, tenantId);
    } else {
      skipped.push({ rootTaskId: root.id, reason: result.reason ?? 'start refused' });
    }
  }

  if (resumed.length > 0 || skipped.length > 0) {
    logger.info({ resumed, skipped }, 'Boot-time plan resume pass finished');
  }
  return { resumed, skipped };
}
