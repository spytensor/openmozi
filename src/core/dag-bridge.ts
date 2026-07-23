/**
 * DAG Bridge — validates decompose_task arguments, creates TaskRecords,
 * invokes executeDag(), and returns aggregated results to the Brain.
 *
 * This module glues the LLM's decompose_task tool call to the existing
 * DAG executor infrastructure.
 */

import { z } from 'zod';
import pino from 'pino';
import { create, type CreateTaskInputType } from '../store/task-dag.js';
import { executeDag } from './dag-executor.js';
import { emit } from '../progress/event-bus.js';
import { getConfig } from '../config/index.js';
import type { LLMClient } from './llm.js';
import { getSessionPermissionLevel, getSessionScopeGrants } from '../memory/sessions.js';
import { isValidLevel, type PermissionLevel } from '../security/permissions.js';
import type { ToolContext } from '../tools/types.js';
import type { ExecutionModelSnapshot } from './execution-model.js';
import { requireDelegationSystemPrompt } from './delegation-prompt.js';
import { inferTurnLocale } from './turn-locale.js';
import { getTurnEnvelope } from '../memory/turn-envelopes.js';
import { getUserRequestForTurn } from '../memory/session-timeline.js';

const logger = pino({ name: 'mozi:dag-bridge' });

const DEPENDENCY_CORRECTIVE_HINT =
  'Corrective hint: depends_on indices are 0-based; a subtask cannot depend on itself; "the previous subtask" is index N-1. Re-call decompose_task with corrected depends_on.';

function dependencyValidationError(message: string): Error {
  return new Error(`${message} ${DEPENDENCY_CORRECTIVE_HINT}`);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const SubtaskInputSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2000),
  done_criteria: z.string().trim().min(1).max(500),
  depends_on: z.array(z.number().int().min(0)),
  agent_type_hint: z.string().default('any'),
  constraints: z.object({
    timeout_seconds: z.number().min(10).max(600).optional(),
    max_retries: z.number().min(0).max(5).optional(),
    max_tokens: z.number().int().min(100).max(16000).optional(),
  }).default({}),
});

export const DecomposeTaskInputSchema = z.object({
  goal: z.string().min(1).max(500),
  all_steps_independent: z.boolean().default(false),
  subtasks: z.array(SubtaskInputSchema).min(2).max(20),
});

export type DecomposeTaskInput = z.infer<typeof DecomposeTaskInputSchema>;

export interface PlanCriticReview {
  warnings: string[];
  risks: string[];
}

export interface PlanVerifierReport {
  passed: boolean;
  failedSubtaskIndexes: number[];
  findings: string[];
}

/**
 * Enforce the dependency contract independently of planner prose. A multi-step
 * zero-edge plan is valid only when the planner explicitly attests that every
 * step is independent; the runtime never infers ordering from titles.
 */
export function validateDecomposePlan(plan: DecomposeTaskInput, maxPlanSteps: number): void {
  if (plan.subtasks.length > maxPlanSteps) {
    throw new Error(
      `Too many subtasks: ${plan.subtasks.length} exceeds max_plan_steps=${maxPlanSteps}. ` +
      'Reduce the number of subtasks or increase brain.max_plan_steps in config.',
    );
  }

  let edgeCount = 0;
  for (let i = 0; i < plan.subtasks.length; i++) {
    const seen = new Set<number>();
    for (const depIdx of plan.subtasks[i].depends_on) {
      if (seen.has(depIdx)) {
        throw dependencyValidationError(
          `Subtask ${i} ("${plan.subtasks[i].title}") repeats depends_on index ${depIdx}.`,
        );
      }
      seen.add(depIdx);
      edgeCount++;
      if (depIdx >= i) {
        throw dependencyValidationError(
          `Subtask ${i} ("${plan.subtasks[i].title}") depends_on index ${depIdx}, ` +
          `which must be less than its own index ${i} (only earlier subtasks allowed).`,
        );
      }
    }
  }

  if (edgeCount === 0 && plan.subtasks.length >= 2 && !plan.all_steps_independent) {
    throw dependencyValidationError(
      `Plan has ${plan.subtasks.length} subtasks but zero dependency edges. ` +
      'Add explicit depends_on relationships, or set all_steps_independent=true only if every step is genuinely independent.',
    );
  }
  if (edgeCount > 0 && plan.all_steps_independent) {
    throw dependencyValidationError('all_steps_independent=true contradicts the explicit depends_on relationships in this plan.');
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
}

/**
 * Critic stage: inspect plan quality and risk before execution.
 */
export function criticReviewPlan(plan: DecomposeTaskInput): PlanCriticReview {
  const warnings: string[] = [];
  const risks: string[] = [];

  const missingDoneCriteria = plan.subtasks
    .map((sub, idx) => ({ idx, hasDone: sub.done_criteria.trim().length > 0 }))
    .filter(x => !x.hasDone)
    .map(x => x.idx);
  if (missingDoneCriteria.length > 0) {
    warnings.push(`Subtasks missing done_criteria: ${missingDoneCriteria.join(', ')}`);
  }

  const highRiskWords = /(delete|drop|force|prod|production|payment|billing|transfer|wire|shutdown|terminate)/i;
  for (let i = 0; i < plan.subtasks.length; i++) {
    const sub = plan.subtasks[i];
    if (highRiskWords.test(`${sub.title} ${sub.objective} ${sub.done_criteria}`)) {
      risks.push(`Subtask ${i} appears high-risk and should be validated carefully: ${sub.title}`);
    }
  }

  const maxFanIn = Math.max(...plan.subtasks.map(s => s.depends_on.length), 0);
  if (maxFanIn >= 4) {
    warnings.push(`Plan dependency fan-in is high (max depends_on=${maxFanIn}); risk of brittle ordering.`);
  }

  if (plan.subtasks.length >= 2 && plan.subtasks.every(s => s.depends_on.length === 0)) {
    warnings.push('Plan explicitly declares every subtask independent; verify that no synthesis or deliverable step consumes upstream results.');
  }

  return { warnings, risks };
}

/**
 * Verifier stage: evaluate DAG output against basic completion signals.
 */
export function verifyDagOutput(plan: DecomposeTaskInput, dagOutput: string): PlanVerifierReport {
  const sections = dagOutput.split('\n\n---\n\n');
  const failedSubtaskIndexes: number[] = [];
  const findings: string[] = [];

  for (let i = 0; i < plan.subtasks.length; i++) {
    const section = sections[i] ?? '';
    const sub = plan.subtasks[i];
    const lowerSection = section.toLowerCase();

    if (lowerSection.includes('error (task skipped):') || lowerSection.includes('cancelled:')) {
      failedSubtaskIndexes.push(i);
      findings.push(`Subtask ${i} failed execution: ${sub.title}`);
      continue;
    }

    if (lowerSection.includes('(no output)')) {
      failedSubtaskIndexes.push(i);
      findings.push(`Subtask ${i} has no verifiable output: ${sub.title}`);
      continue;
    }

    const criteria = sub.done_criteria.trim();
    if (!criteria) continue;

    const criteriaTokens = tokenize(criteria).filter(token => token.length >= 3);
    if (criteriaTokens.length === 0) continue;

    const outputTokens = new Set(tokenize(section));
    const matched = criteriaTokens.filter(token => outputTokens.has(token)).length;
    const coverage = matched / criteriaTokens.length;
    if (coverage < 0.15) {
      failedSubtaskIndexes.push(i);
      findings.push(`Subtask ${i} done_criteria weakly evidenced (coverage=${coverage.toFixed(2)}): ${sub.title}`);
    }
  }

  return {
    passed: failedSubtaskIndexes.length === 0,
    failedSubtaskIndexes,
    findings,
  };
}

/**
 * Planner iteration fallback: when verification fails, re-plan only failed subtasks.
 */
export function replanFromVerifierFailure(
  plan: DecomposeTaskInput,
  verifier: PlanVerifierReport,
  iteration: number,
): DecomposeTaskInput | null {
  if (verifier.failedSubtaskIndexes.length === 0) return null;
  const replanned = verifier.failedSubtaskIndexes.map((idx) => {
    const original = plan.subtasks[idx];
    return {
      ...original,
      title: `[Iteration ${iteration + 1}] ${original.title}`,
      objective: `${original.objective}\nAddress previous verification failure and provide explicit evidence of completion.`,
      depends_on: [] as number[],
      done_criteria: original.done_criteria || 'Provide concrete evidence and validation output.',
    };
  });
  if (replanned.length < 2) {
    // Keep DAG size valid (schema requires min 2 subtasks).
    replanned.push({
      title: `[Iteration ${iteration + 1}] Final validation`,
      objective: 'Verify previous retry output and produce final acceptance summary.',
      done_criteria: 'A clear pass/fail acceptance statement.',
      depends_on: [0] as number[],
      agent_type_hint: 'any',
      constraints: {},
    });
  }
  return {
    goal: `${plan.goal} (iteration ${iteration + 1})`,
    all_steps_independent: replanned.every(subtask => subtask.depends_on.length === 0),
    subtasks: replanned,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DecomposeTaskOptions {
  chatId: string;
  channelType?: string;
  tenantId: string;
  systemPrompt?: string;
  turnId?: string;
  fallbackClient?: LLMClient;
  executionModel?: ExecutionModelSnapshot;
  useSubAgents?: boolean;
  subagentRuntimeSource?: string;
  subagentSessionKey?: string;
  sessionId?: string;
  userId?: string;
  permissionLevel?: string;
  originalRequest?: string;
  deliveryMode?: 'direct' | 'caller';
  turnOrigin?: import('./turn-envelope.js').TurnOrigin;
}

function buildDecomposeToolContext(options: DecomposeTaskOptions, systemPrompt: string): ToolContext | undefined {
  const livePermission = options.sessionId
    ? getSessionPermissionLevel(options.sessionId, options.tenantId)
    : null;
  const fallbackPermission = isValidLevel(options.permissionLevel ?? '')
    ? options.permissionLevel as PermissionLevel
    : undefined;
  const permissionLevel = livePermission ?? fallbackPermission;
  if (!permissionLevel) return undefined;
  return {
    chatId: options.chatId,
    channelType: options.channelType,
    tenantId: options.tenantId,
    sessionId: options.sessionId,
    userId: options.userId,
    permissionLevel,
    scopeGrants: options.sessionId ? getSessionScopeGrants(options.sessionId, options.tenantId) : [],
    systemPrompt,
  };
}

/**
 * Result of a background-mode decompose: the detached plan is running, so the
 * foreground turn must END (runtime-enforced — prompt text alone did not stop
 * a weak model from re-executing the whole plan in the foreground, doubling
 * cost and racing the background delivery).
 */
export interface DetachedPlanStarted {
  detached: true;
  /** Model-directed acknowledgement (tool-result content). */
  content: string;
  /** User-facing final message for the turn. */
  userMessage: string;
  rootTaskId: string;
}

/**
 * One-sentence handoff only (Issue #735): the plan's structure travels as the
 * typed `plan_started` timeline event, so persisting a formatted phase list as
 * assistant prose would duplicate the execution UI and freeze layout decisions
 * into runtime truth. Takes the already-resolved presentation locale so the
 * sentence and the typed event can never disagree about language.
 */
function buildDetachedPlanUserMessage(locale: string | undefined, stepCount: number): string {
  if (locale === 'zh-CN') {
    return `已将任务分解为 ${stepCount} 步计划并开始后台执行,完成后我会把结果发到这里。`;
  }
  return `I broke this down into a ${stepCount}-step plan now running in the background; I will post the results here when it finishes.`;
}

/**
 * Presentation locale for the typed plan event and the handoff sentence: the
 * turn envelope's server-owned locale when the turn has one, else inferred from
 * the goal text (a detached plan may outlive its foreground turn, so the
 * payload carries the locale instead of making consumers re-derive it).
 */
function resolvePlanPresentationLocale(
  options: DecomposeTaskOptions,
  goal: string,
): string | undefined {
  if (options.sessionId && options.turnId) {
    try {
      const envelope = getTurnEnvelope(options.sessionId, options.turnId, options.tenantId ?? 'default');
      if (envelope?.locale) return envelope.locale;
    } catch {
      // Envelope store unavailable (e.g. bare test harness) — fall through.
    }
  }
  return inferTurnLocale(goal);
}

/**
 * Execute a decompose_task tool call.
 *
 * Production mode (always 'background'): persist the plan (root task + children),
 * start a DETACHED run via plan-runner, and return immediately with a
 * DetachedPlanStarted outcome. The caller must treat it as end-of-turn; the
 * runtime delivers real results when execution ends — the plan survives turn
 * timeouts, refreshes, and restarts.
 *
 * Inline mode has been REMOVED from production (operator-approved one-way door,
 * blueprint §8 wave 3). Setting brain.dag_execution_mode='inline' in config is
 * silently mapped to 'background' with a startup warning. The inline path is
 * retained ONLY behind the env escape hatch MOZI_TEST_INLINE_DAG=1, used by
 * existing tests that cannot yet be migrated to background mode.
 */
export async function executeDecomposeTask(
  rawArgs: unknown,
  options: DecomposeTaskOptions,
): Promise<string | DetachedPlanStarted> {
  // 1. Validate input
  let currentPlan = DecomposeTaskInputSchema.parse(rawArgs);
  const maxPlanSteps = getConfig().brain.max_plan_steps;
  const maxPlannerIterations = 2;

  // Inline mode is test-only (MOZI_TEST_INLINE_DAG=1). In production the config
  // always resolves to 'background' (any 'inline' config value is remapped at
  // load time in src/config/index.ts with a loud warning).
  const testInlineMode = process.env.MOZI_TEST_INLINE_DAG === '1';
  if (!testInlineMode) {
    validateDecomposePlan(currentPlan, maxPlanSteps);
    const systemPrompt = requireDelegationSystemPrompt(options.systemPrompt);
    const critic = criticReviewPlan(currentPlan);
    const { createPlanTasks, startDetachedPlanRun } = await import('./plan-runner.js');
    // Resolved ONCE at admission and carried through the run context: the
    // background envelope, the typed plan event, and the handoff sentence all
    // speak this language (never the UI's, never the completion text's).
    const planLocale = resolvePlanPresentationLocale(options, currentPlan.goal);
    const originalRequest = options.originalRequest ?? (options.sessionId && options.turnId
      ? getUserRequestForTurn({
          tenantId: options.tenantId,
          sessionId: options.sessionId,
          turnId: options.turnId,
        })
      : currentPlan.goal);
    if (!originalRequest) {
      throw new Error('Cannot start a detached plan without the persisted original user request for this turn.');
    }
    const planCtx = {
      tenantId: options.tenantId,
      chatId: options.chatId,
      channelType: options.channelType,
      sessionId: options.sessionId,
      userId: options.userId,
      permissionLevel: isValidLevel(options.permissionLevel ?? '') ? options.permissionLevel as PermissionLevel : undefined,
      turnId: options.turnId,
      sourceTurnId: options.turnId,
      originalRequest,
      locale: planLocale,
      systemPrompt,
      fallbackClient: options.fallbackClient,
      executionModel: options.executionModel,
      useSubAgents: options.useSubAgents,
      subagentRuntimeSource: options.subagentRuntimeSource,
      subagentSessionKey: options.subagentSessionKey,
      deliveryMode: options.deliveryMode,
      turnOrigin: options.turnOrigin,
    };
    const created = createPlanTasks(currentPlan, planCtx);

    emit({
      type: 'dag_created',
      taskId: created.rootTaskId,
      taskTitle: currentPlan.goal,
      chatId: options.chatId,
      tenantId: options.tenantId,
      sessionId: options.sessionId,
      turnId: options.turnId,
      totalTasks: currentPlan.subtasks.length,
    });

    const started = startDetachedPlanRun(created.rootTaskId, planCtx);
    if (!started) {
      return `Error: plan ${created.rootTaskId} was created but its background run could not start. Use run_task with task_id="${created.rootTaskId}" to execute it.`;
    }

    // Typed plan presentation event (Issue #735): the single source the inline
    // card, sticky capsule, and inspector consume, carrying the store-owned
    // task-id dependency edges so the client renders real dependency state,
    // never a re-parsed prose list. Emitted only AFTER the detached run
    // actually started — a persisted "plan started" row for a run that failed
    // to launch would be a fabricated-success artifact.
    emit({
      type: 'plan_started',
      taskId: created.rootTaskId,
      taskTitle: currentPlan.goal,
      planPhases: created.steps.map((step) => ({
        taskId: step.taskId,
        title: step.title,
        dependsOn: step.dependsOn,
      })),
      locale: planLocale,
      chatId: options.chatId,
      tenantId: options.tenantId,
      sessionId: options.sessionId,
      turnId: options.turnId,
    });

    logger.info({
      rootTaskId: created.rootTaskId,
      goal: currentPlan.goal,
      steps: created.steps.length,
      chatId: options.chatId,
    }, 'decompose_task started detached background plan run');

    return {
      detached: true,
      rootTaskId: created.rootTaskId,
      content: [
        `Plan accepted and RUNNING IN BACKGROUND (plan id: ${created.rootTaskId}).`,
        `Goal: ${currentPlan.goal}`,
        `Steps (${created.steps.length}):`,
        ...created.steps.map((s, i) => `  ${i + 1}. ${s.title}`),
        critic.warnings.length > 0 ? `Plan warnings: ${critic.warnings.join('; ')}` : '',
        critic.risks.length > 0 ? `Plan risks: ${critic.risks.join('; ')}` : '',
        '',
        'The runtime now ENDS this turn: the plan runs detached and real results are',
        'delivered as a message when execution finishes.',
      ].filter(Boolean).join('\n'),
      userMessage: buildDetachedPlanUserMessage(planLocale, created.steps.length),
    };
  }

  logger.info({
    goal: currentPlan.goal,
    subtaskCount: currentPlan.subtasks.length,
    chatId: options.chatId,
    tenantId: options.tenantId,
    useSubAgents: options.useSubAgents === true,
    subagentRuntimeSource: options.subagentRuntimeSource ?? 'disabled',
    subagentSessionKey: options.subagentSessionKey ?? `${options.tenantId}:${options.chatId}`,
  }, 'Executing decompose_task with planner-critic-verifier loop');

  const systemPrompt = requireDelegationSystemPrompt(options.systemPrompt);

  let finalOutput = '';
  let finalVerifier: PlanVerifierReport = { passed: false, failedSubtaskIndexes: [], findings: [] };
  const criticSummaries: string[] = [];

  for (let iteration = 1; iteration <= maxPlannerIterations; iteration++) {
    validateDecomposePlan(currentPlan, maxPlanSteps);

    const critic = criticReviewPlan(currentPlan);
    criticSummaries.push([
      `Iteration ${iteration}:`,
      `warnings=${critic.warnings.length}`,
      `risks=${critic.risks.length}`,
    ].join(' '));

    emit({
      type: 'dag_created',
      chatId: options.chatId,
      tenantId: options.tenantId,
      sessionId: options.sessionId,
      turnId: options.turnId,
      totalTasks: currentPlan.subtasks.length,
    });

    const taskIds: string[] = [];
    for (let i = 0; i < currentPlan.subtasks.length; i++) {
      const sub = currentPlan.subtasks[i];
      const dependsOnIds = sub.depends_on.map(idx => taskIds[idx]);
      const input: CreateTaskInputType = {
        tenant_id: options.tenantId,
        title: sub.title,
        objective: sub.objective,
        done_criteria: sub.done_criteria,
        depends_on: dependsOnIds,
        agent_type_hint: sub.agent_type_hint,
        constraints: {
          timeout_seconds: sub.constraints.timeout_seconds,
          max_retries: sub.constraints.max_retries ?? 2,
          max_tokens: sub.constraints.max_tokens,
        },
        priority: i,
        tags: [],
      };
      const record = create(input);
      taskIds.push(record.id);
    }

    const { getById } = await import('../store/task-dag.js');
    const taskRecords = taskIds
      .map(id => getById(id, options.tenantId))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (taskRecords.length === 0) {
      return 'Error: Failed to create task records for DAG execution.';
    }

    finalOutput = await executeDag(
      taskRecords,
      systemPrompt,
      options.chatId,
      undefined,
      options.fallbackClient,
      options.turnId,
      {
        useSubAgents: options.useSubAgents === true,
        subagentRuntimeSource: options.subagentRuntimeSource,
        subagentSessionKey: options.subagentSessionKey,
        sessionId: options.sessionId,
        toolContext: buildDecomposeToolContext(options, systemPrompt),
      },
    );

    finalVerifier = verifyDagOutput(currentPlan, finalOutput);
    if (finalVerifier.passed) {
      break;
    }

    if (iteration < maxPlannerIterations) {
      const replanned = replanFromVerifierFailure(currentPlan, finalVerifier, iteration);
      if (!replanned) break;
      currentPlan = replanned;
      continue;
    }
  }

  logger.info({
    goal: currentPlan.goal,
    verifierPassed: finalVerifier.passed,
    failedCount: finalVerifier.failedSubtaskIndexes.length,
    chatId: options.chatId,
  }, 'decompose_task completed with planner-critic-verifier loop');

  return [
    '## Planner-Critic-Verifier Results',
    '',
    `Goal: ${currentPlan.goal}`,
    `Planner iterations: ${criticSummaries.length}`,
    `Critic summary: ${criticSummaries.join(' | ')}`,
    `Verifier passed: ${finalVerifier.passed ? 'yes' : 'no'}`,
    finalVerifier.findings.length > 0
      ? `Verifier findings:\n- ${finalVerifier.findings.join('\n- ')}`
      : 'Verifier findings: none',
    '',
    '## DAG Output',
    '',
    finalOutput,
  ].join('\n');
}
