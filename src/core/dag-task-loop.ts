/**
 * DAG Task Loop — single-task LLM execution loop for DAG executor.
 *
 * Runs one task through the tool-calling loop with timeout, retry,
 * and loop-guard protections. Used by dag-executor.ts.
 */

import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { getClientForTask, getClientForRole, type TaskHints } from './model-router.js';
import type { ChatMessage, LLMClient, ModelThinkSetting } from './llm.js';
import { defaultChatOptionsForSurface } from './llm-surface.js';
import type { TaskRecord } from '../store/task-dag.js';
import { updateTask } from '../store/task-dag.js';
import { executeToolCalls, extractToolIntent, extractToolSkillName } from '../tools/executor.js';
import { STEP_RESULT_PERSISTENCE_NOTE } from './plan-grounding.js';
import { createTurnFileArtifactTracker } from '../artifacts/file-artifacts.js';
import { findPublishedArtifactIdByPath } from '../memory/session-timeline.js';
import { ArtifactCoordinator } from '../artifacts/coordinator.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import { getConfig } from '../config/index.js';
import { getAllRegisteredTools } from '../tools/dynamic-registry.js';
import { log as logEvent } from '../store/events.js';
import { extractMissingEnvKeys } from './recovery-policy.js';
import { throwIfTaskCancelled } from './task-cancellation.js';
import {
  UnifiedExecutionKernel,
  createKernelSystemMessage,
  sanitizeExecutionMessages,
} from './unified-execution-kernel.js';
import { reportTimeoutAndMaybeTune } from './autonomous-timeout.js';
import {
  ensureTaskWorkspace,
  persistTaskResult,
  appendTranscript,
  appendTranscriptBatch,
  loadTaskTranscript,
  type TranscriptEntry,
  type PersistedTaskResult,
} from '../tasks/workspace.js';
import { getSessionPermissionLevel, getSessionScopeGrants } from '../memory/sessions.js';
import { saveTimelineItem } from '../memory/session-timeline.js';
import type { ToolContext } from '../tools/types.js';
import { buildExecutionToolContext } from '../tools/execution-context.js';
import {
  shapePromptMessagesForExecution,
  shapeToolsForExecution,
  type ToolShapingResult,
} from '../tools/tool-shaping.js';
import { normalizeProviderError } from './error-surfacing.js';

const logger = pino({ name: 'mozi:dag-executor' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce tool result content to a string (some tools may return non-string). */
export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

export function normalizeNonNegativeInt(value: unknown, fallback: number, min = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.max(min, Math.floor(numeric));
}

/** Apply the same model-aware tool shaping policy to a durable DAG step. */
export function shapeDagStepTools(
  task: Pick<TaskRecord, 'title' | 'objective'>,
  client: Pick<LLMClient, 'provider'>,
  model: string | undefined,
  tools = getAllRegisteredTools(),
): ToolShapingResult {
  return shapeToolsForExecution({
    tools,
    userText: `${task.title}\n${task.objective}`,
    provider: client.provider,
    model,
  });
}

export type TaskLoopStopReason = 'loop_timeout' | 'repeated_tool_failures' | 'loop_detected' | 'max_iterations' | 'runtime_guard';

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function recentErrorPreview(payload: Record<string, unknown> | undefined): string | undefined {
  const recent = payload?.recent_errors;
  if (Array.isArray(recent)) {
    const first = recent.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return first?.slice(0, 200);
  }
  const detail = payloadString(payload, 'error') ?? payloadString(payload, 'detail');
  return detail?.slice(0, 200);
}

function hasCjkText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

export function buildTaskLoopFallbackMessage(
  task: TaskRecord,
  reason: TaskLoopStopReason,
  recentErrors: string[],
): string {
  const isZh = hasCjkText(`${task.title} ${task.objective}`);
  const missingEnvKeys = extractMissingEnvKeys(recentErrors);

  if (isZh) {
    if (missingEnvKeys.length > 0) {
      return `任务阻塞：缺少环境变量 ${missingEnvKeys.join(', ')}。我已停止无效重试并保留任务上下文，请先完成配置后重新执行。`;
    }
    if (reason === 'loop_timeout') {
      return '任务执行超时。我已停止自动重试并保留任务上下文，请重新发起该任务。';
    }
    return '任务执行中断。我已停止自动重试并保留任务上下文，请重新发起该任务。';
  }

  if (missingEnvKeys.length > 0) {
    return `Task blocked: missing environment variables ${missingEnvKeys.join(', ')}. I stopped ineffective retries and preserved task context; configure them and rerun this task.`;
  }
  if (reason === 'loop_timeout') {
    return 'Task timed out. I stopped automatic retries and preserved task context; rerun this task.';
  }
  return 'Task execution was interrupted. I stopped automatic retries and preserved task context; rerun this task.';
}

export function recordTaskLoopGuardEvent(
  task: TaskRecord,
  chatId: string,
  reason: TaskLoopStopReason,
  payload?: Record<string, unknown>,
): void {
  const sessionId = payloadString(payload, 'session_id');
  const turnId = payloadString(payload, 'turn_id');
  const errorPreview = recentErrorPreview(payload);
  try {
    logEvent(
      'dag_tool_loop_guard',
      'task',
      task.id,
      {
        chat_id: chatId,
        reason,
        ...payload,
      },
      task.tenant_id,
    );
  } catch (err) {
    logger.warn({
      taskId: task.id,
      chatId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist DAG loop-guard event');
  }

  try {
    updateTask(task.id, {
      constraints: {
        ...task.constraints,
        guard_reason: reason,
      },
    }, task.tenant_id);
  } catch (err) {
    logger.warn({
      taskId: task.id,
      reason,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist DAG loop-guard reason on task');
  }

  try {
    const transcript = loadTaskTranscript(task.id);
    const alreadyRecorded = transcript.some((entry) => (
      entry.type === 'error'
      && entry.data.status === 'guarded'
      && entry.data.guard_reason === reason
    ));
    if (!alreadyRecorded) {
      appendTranscript(task.id, {
        timestamp: new Date().toISOString(),
        type: 'error',
        data: {
          status: 'guarded',
          guard_reason: reason,
          error_preview: errorPreview,
        },
      });
    }
  } catch (err) {
    logger.warn({
      taskId: task.id,
      reason,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to append DAG loop-guard transcript entry');
  }

  emitProgress({
    type: 'task_guarded',
    taskId: task.id,
    taskTitle: task.title,
    reason,
    errorPreview,
    chatId,
    tenantId: task.tenant_id,
    sessionId,
    turnId,
  });

  if (sessionId) {
    try {
      saveTimelineItem({
        tenantId: task.tenant_id,
        sessionId,
        chatId,
        turnId,
        type: 'task_update',
        eventKey: `task:${task.id}`,
        timestamp: Date.now(),
        preserveTimestampOnUpdate: true,
        mergeDataOnUpdate: true,
        data: {
          id: `task_${task.id}`,
          task_id: task.id,
          turnId,
          title: task.title,
          status: 'failed',
          guard_reason: reason,
          error_preview: errorPreview,
        },
      });
    } catch (err) {
      logger.warn({
        taskId: task.id,
        sessionId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      }, 'Failed to persist DAG loop-guard timeline entry');
    }
  }
}

/**
 * Detect if a task result is a *timeout* fallback message (retryable).
 * Only matches timeout-specific prefixes from buildTaskLoopFallbackMessage.
 * Other fallback types (env-var blocking, generic interruption) are NOT retryable.
 */
export function isTimeoutFallbackResult(result: string | undefined): boolean {
  if (!result) return false;
  return result.startsWith('Task timed out.')
    || result.startsWith('任务执行超时。');
}

/**
 * Detect a *generic interruption* fallback message (NOT a clean success and NOT
 * retryable). This is the string `executeSingleTask` returns when the loop is
 * stopped by a guard (loop_detected / repeated_tool_failures / max_iterations /
 * runtime_guard) — including the case where a user cancel aborts tool calls but
 * the loop unwinds by returning this string instead of throwing TaskCancelledError.
 *
 * Without this, dag-executor treated the polite "任务执行中断…" string as a
 * completed step, whitewashing a cancelled/interrupted task into "Plan completed".
 * The caller maps this to a CANCELLED outcome so the plan reports the truth.
 */
export function isInterruptedFallbackResult(result: string | undefined): boolean {
  if (!result) return false;
  return result.startsWith('Task execution was interrupted.')
    || result.startsWith('任务执行中断。');
}

function inferTaskHints(task: TaskRecord): TaskHints {
  const objective = task.objective || '';
  const estimatedTokens = Math.max(300, Math.ceil(objective.length / 4));

  const complexity: TaskHints['complexity'] =
    objective.length > 800 ? 'high' : objective.length > 200 ? 'medium' : 'low';

  const normalizedType = normalizeTaskType(task.agent_type_hint, task.tags);

  return {
    complexity,
    type: normalizedType,
    needs_tool_calling: true,
    estimated_tokens: estimatedTokens,
  };
}

function normalizeTaskType(
  agentTypeHint: string,
  tags: string[],
): TaskHints['type'] {
  const hint = (agentTypeHint || '').toLowerCase();
  const lowerTags = tags.map(t => t.toLowerCase());

  if (hint.includes('code') || lowerTags.includes('code')) return 'code';
  if (hint.includes('research') || lowerTags.includes('research')) return 'research';
  if (hint.includes('review') || lowerTags.includes('review')) return 'review';
  if (hint.includes('summary') || lowerTags.includes('summary')) return 'summary';

  return 'general';
}

export function resolveClient(
  task: TaskRecord,
  fallbackClient?: LLMClient,
  executionModel?: import('./execution-model.js').ExecutionModelSnapshot,
): { client: LLMClient; think?: ModelThinkSetting } {
  // MOZI_E2E_LLM=scripted: gate:e2e test seam — bypass role-routing and use the
  // scripted fallbackClient directly so step execution is zero-network.
  if (process.env['MOZI_E2E_LLM'] === 'scripted' && fallbackClient) {
    return { client: fallbackClient };
  }

  const configuredRoles = getConfig().model_router?.roles as Record<string, unknown> | undefined;
  const hasExplicitStepOverride = Boolean(configuredRoles?.['step']);

  // Default: inherit the immutable model selected for the user turn. A step
  // role only wins when the operator explicitly configured it in Settings.
  if (!hasExplicitStepOverride && fallbackClient) {
    logger.info({ taskId: task.id, executionModel, routingReason: 'inherited_turn_model' }, 'DAG step model resolved');
    return { client: fallbackClient, think: executionModel?.think };
  }

  try {
    const { client, selection } = getClientForRole('step', fallbackClient, { tenantId: task.tenant_id });
    logger.info({ taskId: task.id, provider: selection.provider, model: selection.model, routingReason: hasExplicitStepOverride ? 'explicit_step_override' : 'router_fallback' }, 'DAG step model resolved');
    return { client, think: selection.think };
  } catch (err) {
    if (fallbackClient) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId: task.id, error: message }, 'Step role routing failed, using fallback client');
      return { client: fallbackClient };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// executeSingleTask — the LLM tool-calling loop for one DAG task
// ---------------------------------------------------------------------------

/** Tools whose completion means a file may have appeared and should be scanned. */
const FILE_ARTIFACT_SCAN_TOOLS = new Set([
  'shell_exec', 'shell_exec_bg', 'process_output', 'write_file', 'edit_file', 'append_file',
]);

/**
 * Research evidence must survive the model context that produced it.  Detached
 * plan verification reads these transcript entries after every child has
 * terminated; a 300-character UI preview is not enough to check whether a
 * claimed "latest" value was actually grounded in a dated source.
 *
 * Keep this allow-list narrow so arbitrary shell arguments, file contents, and
 * secrets never become verifier evidence by accident.
 */
const RESEARCH_EVIDENCE_TOOLS = new Set(['web_search', 'web_fetch']);
const ACCEPTANCE_EVIDENCE_TOOLS = new Set([...RESEARCH_EVIDENCE_TOOLS, 'set_cron_task']);
const RESEARCH_EVIDENCE_CHARS = 6000;

export async function executeSingleTask(
  task: TaskRecord,
  systemPrompt: string,
  chatId: string,
  fallbackClient?: LLMClient,
  dependencyContext?: string,
  turnId?: string,
  taskAbortSignal?: AbortSignal,
  baseToolContext?: ToolContext,
): Promise<string> {
  throwIfTaskCancelled(taskAbortSignal, task.id);

  // Initialize task workspace for result/transcript persistence
  try { ensureTaskWorkspace(task.id); } catch { /* non-critical */ }
  const transcriptBuffer: TranscriptEntry[] = [];

  const { client, think: taskThink } = resolveClient(task, fallbackClient, baseToolContext?.executionModel);
  // One provider/model owns one complete tool loop. A retry calls
  // executeSingleTask again and therefore receives a fresh key, allowing the
  // failover manager to restart cleanly on another provider instead of
  // continuing provider-native reasoning history across incompatible APIs.
  const failoverSessionKey = `dag:${task.id}:${randomUUID()}`;

  logger.debug({
    taskId: task.id,
    maxTokens: task.constraints.max_tokens,
    temperature: task.constraints.temperature,
    timeoutSeconds: task.constraints.timeout_seconds,
  }, 'Per-task execution params');

  const objective = [
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    task.done_criteria ? `Done Criteria: ${task.done_criteria}` : '',
    dependencyContext || '',
    '',
    'Complete this sub-task and provide a concise result summary.',
    STEP_RESULT_PERSISTENCE_NOTE,
    // Deliverable contract: step text output lands in a chat summary, not in a
    // file. A document/page deliverable that stays in text is silently lost.
    'If the deliverable is a document, web page, HTML report, slide deck, or any',
    'visual/file output, you MUST create it via the create_artifact or write_file',
    'tool — do NOT paste its source into your text answer. Your text answer',
    'should then reference the created artifact/file and summarize it.',
  ].filter(Boolean).join('\n');

  const loopMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: objective },
  ];

  const toolShaping = shapeDagStepTools(
    task,
    client,
    baseToolContext?.executionModel?.model,
    getAllRegisteredTools(task.tenant_id),
  );
  loopMessages.splice(0, loopMessages.length, ...shapePromptMessagesForExecution(loopMessages, toolShaping, { childSurface: true }));
  const availableTools = toolShaping.tools;
  logger.info({
    taskId: task.id,
    taskProfile: toolShaping.taskProfile,
    exposedToolCount: toolShaping.shapedCount,
    originalToolCount: toolShaping.originalCount,
    toolSchemaTokensEstimate: toolShaping.schemaTokensEstimate,
  }, 'DAG step tools shaped');

  // Shared per-task tool context. Built ONCE and mutated per batch: the
  // executor writes approval side-effects onto it (elevation dedup cache,
  // elevated permissionLevel, write confirmation, scope grants) and a
  // per-batch spread copy would discard them, re-prompting on every batch.
  const surface = baseToolContext?.executionContext?.surface === 'subagent_fallback'
    ? 'subagent_fallback'
    : 'dag_step';
  const taskToolContext = buildExecutionToolContext(surface, {
    ...baseToolContext,
    chatId: surface === 'subagent_fallback' ? task.id : chatId,
    taskId: task.id,
    tenantId: task.tenant_id,
    agentId: task.assigned_agent || task.id,
    abortSignal: taskAbortSignal,
    systemPrompt,
  });

  // Surface files produced by a plan STEP as openable artifact cards. The durable
  // plan path ran tools through executeToolCalls but never wired the file-artifact
  // tracker, so a deck/doc produced by a shell script existed only as a disk path
  // the browser could not open. Mirror brain-engine: capture a baseline, then
  // emit/scan after each file-touching batch through the context's onArtifact
  // broadcast so cards reach the session timeline.
  const turnRichArtifactPaths = taskToolContext.turnRichArtifactPaths ?? new Set<string>();
  taskToolContext.turnRichArtifactPaths = turnRichArtifactPaths;
  const fileArtifactTracker = typeof taskToolContext.onArtifact === 'function'
    ? (() => {
        const coordinator = taskToolContext.artifactCoordinator
          // Plan-step documents are working notes, not conversation
          // deliverables — they surface in the workbench artifacts view only.
          ?? new ArtifactCoordinator(turnId ?? task.id, (event: ArtifactEvent) => taskToolContext.onArtifact?.(event), { documentRole: 'workspace' });
        taskToolContext.artifactCoordinator = coordinator;
        return createTurnFileArtifactTracker({
          activeRootPath: taskToolContext.workspaceRootPath,
          tenantId: task.tenant_id,
          sessionId: taskToolContext.sessionId,
          userId: taskToolContext.userId,
          richArtifactPaths: turnRichArtifactPaths,
          artifactCoordinator: coordinator,
          resolvePublishedArtifactId: taskToolContext.sessionId
            ? (path) => findPublishedArtifactIdByPath({
                tenantId: taskToolContext.tenantId,
                sessionId: taskToolContext.sessionId!,
                path,
              })
            : undefined,
        });
      })()
    : undefined;
  await fileArtifactTracker?.captureBaseline();

  const loopsConfig = getConfig().tools.loops;
  // Config is the safety cap; Brain decides within it. Config=0 means unlimited (Brain fully decides).
  const configMaxIterations = normalizeNonNegativeInt(loopsConfig.dag_max_iterations, 0);
  const brainMaxIterations = normalizeNonNegativeInt(task.constraints.tool_max_iterations ?? 0, 0);
  const maxToolIterations = (() => {
    if (configMaxIterations === 0 && brainMaxIterations === 0) return 0; // both unlimited
    if (configMaxIterations === 0) return brainMaxIterations; // config unlimited, Brain decides
    if (brainMaxIterations === 0) return configMaxIterations; // Brain unlimited, config caps
    return Math.min(brainMaxIterations, configMaxIterations); // both set, take smaller
  })();
  const initialLlmCallTimeoutMs = normalizeNonNegativeInt(loopsConfig.llm_call_timeout_ms, 300000);
  // A task timeout is an inactivity lease, not a wall-clock lifetime. Long DAG
  // steps renew it whenever the model or a tool batch makes observable progress.
  const brainTimeoutMs = (task.constraints.timeout_seconds ?? 0) > 0
    ? task.constraints.timeout_seconds! * 1000 : 0;
  const configTimeoutMs = normalizeNonNegativeInt(loopsConfig.max_elapsed_ms, 120000);
  const resolveDagLoopTimeoutMs = (nextConfigTimeoutMs: number): number => {
    if (nextConfigTimeoutMs === 0 && brainTimeoutMs === 0) return 0;
    if (nextConfigTimeoutMs === 0) return brainTimeoutMs;
    if (brainTimeoutMs === 0) return nextConfigTimeoutMs;
    // Autonomous tuning must be allowed to grow beyond the planner's initial
    // estimate. Otherwise a 300s task cap permanently defeats a 30m tuned cap.
    return Math.max(brainTimeoutMs, nextConfigTimeoutMs);
  };
  const maxLoopElapsedMs = brainTimeoutMs > 0 ? brainTimeoutMs : configTimeoutMs;
  const maxFailedToolBatches = normalizeNonNegativeInt(loopsConfig.max_failed_tool_batches, 3, 1);
  // Default step output budget must fit a real deliverable (a full HTML report
  // or long analysis); 2000 silently truncated document-producing steps. The
  // Brain can still set a tighter per-task cap via constraints.max_tokens.
  const taskMaxTokens = task.constraints.max_tokens ?? 8192;
  const taskTemperature = task.constraints.temperature ?? 0.7;
  const executionKernel = new UnifiedExecutionKernel({
    scope: 'dag',
    tenantId: task.tenant_id,
    chatId,
    taskId: task.id,
    maxIterations: maxToolIterations,
    llmCallTimeoutMs: initialLlmCallTimeoutMs,
    maxLoopElapsedMs,
    maxFailedToolBatches,
    repeatedFailureStrategy: 'stop',
    resolveLoopTimeoutMs: resolveDagLoopTimeoutMs,
  });

  while (executionKernel.canContinue()) {
    throwIfTaskCancelled(taskAbortSignal, task.id);
    const iterationBudget = executionKernel.beginIteration();
    if ('stopReason' in iterationBudget) {
      recordTaskLoopGuardEvent(task, chatId, 'loop_timeout', {
        elapsed_ms: executionKernel.elapsedMs(),
        max_elapsed_ms: executionKernel.currentLoopTimeoutMs,
        session_id: taskToolContext.sessionId,
        turn_id: turnId,
      });
      return buildTaskLoopFallbackMessage(task, 'loop_timeout', []);
    }
    const iteration = iterationBudget.iteration;
    const sanitizedMessages = sanitizeExecutionMessages(loopMessages);
    if (sanitizedMessages !== loopMessages) {
      loopMessages.length = 0;
      loopMessages.push(...sanitizedMessages);
    }

    let response;
    try {
      response = await client.chat(
        loopMessages,
        {
          ...defaultChatOptionsForSurface('dag_step', {
            tenantId: task.tenant_id,
            userId: taskToolContext.userId,
            taskId: task.id,
            agentId: task.assigned_agent || task.id,
            abort_signal: taskAbortSignal,
          }),
          max_tokens: taskMaxTokens,
          temperature: taskTemperature,
          think: taskThink,
          tools: availableTools.length > 0 ? availableTools : undefined,
          timeout_ms: iterationBudget.effectiveCallTimeoutMs,
          failoverSessionKey,
        },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (taskAbortSignal?.aborted) {
        throwIfTaskCancelled(taskAbortSignal, task.id);
      }
      const providerError = normalizeProviderError(err);
      if (providerError.kind === 'transient' || providerError.kind === 'rate_limit') {
        // Provider failures belong to the step retry budget. Returning a
        // loop_timeout fallback here burns that budget without backoff and
        // misattributes provider unavailability to the infinite-loop guard.
        throw providerError;
      }
      const isTimeout = errMsg.includes('abort') || errMsg.includes('timeout')
        || (err instanceof Error && err.name === 'AbortError');
      if (isTimeout) {
        const timeoutDecision = executionKernel.handleLlmTimeoutError(errMsg, iterationBudget.effectiveCallTimeoutMs);
        if (timeoutDecision.autotuneDirective) {
          loopMessages.push(createKernelSystemMessage(timeoutDecision.autotuneDirective));
        }
        logger.warn({
          taskId: task.id,
          iteration,
          elapsed_ms: executionKernel.elapsedMs(),
          timeout_ms: iterationBudget.effectiveCallTimeoutMs,
        }, 'LLM call timed out, will retry if budget remains');
        if (timeoutDecision.stopReason) {
          recordTaskLoopGuardEvent(task, chatId, 'loop_timeout', {
            recent_errors: timeoutDecision.recentFailureDetails,
            session_id: taskToolContext.sessionId,
            turn_id: turnId,
          });
          return buildTaskLoopFallbackMessage(task, 'loop_timeout', [errMsg]);
        }
        continue;
      }
      throw err;
    }
    executionKernel.recordActivity();

    if (response.tool_calls && response.tool_calls.length > 0) {
      loopMessages.push({
        role: 'assistant',
        content: response.content || '',
        // Preserve reasoning across tool continuations (brain-engine already
        // does this). DeepSeek accepts continuations without it (probe-verified
        // 2026-07-08), but echoing it keeps the model's chain of thought intact
        // in thinking mode.
        reasoning_content: response.reasoning_content,
        tool_calls: response.tool_calls,
      });

      // Record LLM call to transcript
      transcriptBuffer.push({
        timestamp: new Date().toISOString(),
        type: 'llm_call',
        data: {
          iteration: executionKernel.currentIteration,
          content_length: (response.content || '').length,
          tool_call_count: response.tool_calls.length,
          tool_names: response.tool_calls.map(tc => tc.function.name),
        },
      });

      for (const tc of response.tool_calls) {
        throwIfTaskCancelled(taskAbortSignal, task.id);
        if (ACCEPTANCE_EVIDENCE_TOOLS.has(tc.function.name)) {
          let evidenceArgs: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(tc.function.arguments || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              evidenceArgs = parsed as Record<string, unknown>;
            }
          } catch { /* malformed arguments are handled by the tool executor */ }
          transcriptBuffer.push({
            timestamp: new Date().toISOString(),
            type: 'tool_call',
            data: {
              tool_name: tc.function.name,
              tool_call_id: tc.id,
              arguments: evidenceArgs,
              evidence_kind: RESEARCH_EVIDENCE_TOOLS.has(tc.function.name) ? 'research_source' : 'scheduler_control',
            },
          });
        }
        emitProgress({
          type: 'tool_call',
          taskId: task.id,
          toolName: tc.function.name,
          toolCallId: tc.id,
          agentId: task.assigned_agent || task.id,
          intent: extractToolIntent(tc.function.name, tc.function.arguments),
          skillName: extractToolSkillName(tc.function.name, tc.function.arguments),
          chatId,
          // Without tenant/session identity the timeline persist gate drops
          // these frames: the plan's whole tool history then vanished on
          // reload (live WS looked rich, restored sessions showed bare
          // phase rows).
          tenantId: task.tenant_id,
          sessionId: taskToolContext.sessionId,
          turnId,
        });
      }

      const toolStartTime = Date.now();
      throwIfTaskCancelled(taskAbortSignal, task.id);
      // Refresh session-derived fields per batch (a mid-plan elevation must
      // apply) without discarding executor-written approval state.
      if (taskToolContext.sessionId) {
        const livePermissionLevel = getSessionPermissionLevel(taskToolContext.sessionId, task.tenant_id);
        if (livePermissionLevel) taskToolContext.permissionLevel = livePermissionLevel;
        const liveGrants = getSessionScopeGrants(taskToolContext.sessionId, task.tenant_id);
        taskToolContext.scopeGrants = Array.from(new Set([...(taskToolContext.scopeGrants ?? []), ...liveGrants]));
      }
      const results = await executeToolCalls(response.tool_calls, taskToolContext);
      throwIfTaskCancelled(taskAbortSignal, task.id);

      // Surface any files this batch produced as openable artifact cards.
      if (fileArtifactTracker) {
        const producedFiles = results.flatMap(result => result.is_error ? [] : (result.produced_files ?? []));
        await fileArtifactTracker.emitPaths(producedFiles);
        if (response.tool_calls.some(tc => FILE_ARTIFACT_SCAN_TOOLS.has(tc.function.name))) {
          await fileArtifactTracker.scanAndEmit();
        }
      }

      const toolElapsedMs = Date.now() - toolStartTime;
      const recentErrors = results
        .map(result => asString(result.content).trim())
        .filter(content => content.length > 0)
        .slice(0, 2)
        .map(error => error.slice(0, 240));

      for (const result of results) {
        loopMessages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
          tool_name: result.tool_name,
        });
      }

      for (const result of results) {
        emitProgress({
          type: 'tool_result',
          taskId: task.id,
          toolName: result.tool_name,
          toolCallId: result.tool_call_id,
          agentId: task.assigned_agent || task.id,
          result: result.is_error ? undefined : asString(result.content).slice(0, 200),
          sources: result.is_error ? undefined : result.sources,
          elapsed_ms: toolElapsedMs,
          error: result.is_error ? asString(result.content).slice(0, 280) : undefined,
          skillName: result.skillName,
          skillDescription: result.skillDescription,
          skillLoadOutcome: result.skillLoadOutcome,
          skillMissingBins: result.skillMissingBins,
          skillMissingEnv: result.skillMissingEnv,
          skillLoadError: result.skillLoadError,
          chatId,
          tenantId: task.tenant_id,
          sessionId: taskToolContext.sessionId,
          turnId,
        });

        // Record tool result to transcript
        transcriptBuffer.push({
          timestamp: new Date().toISOString(),
          type: result.is_error ? 'error' : 'tool_result',
          data: {
            tool_name: result.tool_name,
            tool_call_id: result.tool_call_id,
            is_error: result.is_error,
            content_preview: asString(result.content).slice(0, 300),
            ...(ACCEPTANCE_EVIDENCE_TOOLS.has(result.tool_name ?? '')
              ? { content_evidence: asString(result.content).slice(0, RESEARCH_EVIDENCE_CHARS) }
              : {}),
            elapsed_ms: toolElapsedMs,
          },
        });
      }

      // Flush transcript buffer periodically (every 10 entries)
      if (transcriptBuffer.length >= 10) {
        try {
          appendTranscriptBatch(task.id, transcriptBuffer.splice(0));
        } catch { /* non-critical */ }
      }

      const toolBatchDecision = executionKernel.recordToolBatch(
        response.tool_calls,
        results.map(result => ({
          toolCallId: result.tool_call_id,
          toolName: result.tool_name ?? (response.tool_calls ?? []).find(call => call.id === result.tool_call_id)?.function.name ?? 'tool',
          status: result.is_error ? 'error' as const : 'success' as const,
          errorSummary: result.is_error ? asString(result.content).slice(0, 200) : undefined,
        })),
        recentErrors,
      );
      if (toolBatchDecision.toolTruthDirective) {
        loopMessages.push(createKernelSystemMessage(toolBatchDecision.toolTruthDirective));
      }
      if (toolBatchDecision.constraintRecoveryHint) {
        loopMessages.push(createKernelSystemMessage(toolBatchDecision.constraintRecoveryHint));
      }
      if (toolBatchDecision.failureHint) {
        loopMessages.push(createKernelSystemMessage(toolBatchDecision.failureHint));
      }
      if (toolBatchDecision.loopHint) {
        loopMessages.push(createKernelSystemMessage(toolBatchDecision.loopHint));
      }
      if (toolBatchDecision.stopReason) {
        const reason = toolBatchDecision.stopReason === 'loop_detected'
          ? 'loop_detected'
          : 'repeated_tool_failures';
        recordTaskLoopGuardEvent(task, chatId, reason, {
          recent_errors: toolBatchDecision.recentFailureDetails,
          max_failed_batches: maxFailedToolBatches,
          session_id: taskToolContext.sessionId,
          turn_id: turnId,
        });
        return buildTaskLoopFallbackMessage(task, reason, toolBatchDecision.recentFailureDetails);
      }

      continue;
    }

    // Persist final result and flush remaining transcript
    try {
      transcriptBuffer.push({
        timestamp: new Date().toISOString(),
        type: 'summary',
        data: { status: 'completed', output_length: response.content.length },
      });
      appendTranscriptBatch(task.id, transcriptBuffer.splice(0));
      persistTaskResult(task.id, {
        task_id: task.id,
        success: true,
        output: response.content,
        tokens_used: 0,
        elapsed_ms: executionKernel.elapsedMs(),
        completed_at: new Date().toISOString(),
      });
    } catch { /* non-critical */ }

    return response.content;
  }

  // Flush remaining transcript on loop exhaustion
  try {
    transcriptBuffer.push({
      timestamp: new Date().toISOString(),
      type: 'error',
      data: { status: 'loop_exhausted', iterations: executionKernel.currentIteration },
    });
    appendTranscriptBatch(task.id, transcriptBuffer.splice(0));
  } catch { /* non-critical */ }

  const stopReason = executionKernel.stopReasonAfterLoop();
  recordTaskLoopGuardEvent(task, chatId, stopReason, {
    max_iterations: maxToolIterations,
    iterations_executed: executionKernel.currentIteration,
    session_id: taskToolContext.sessionId,
    turn_id: turnId,
  });
  return buildTaskLoopFallbackMessage(task, stopReason, executionKernel.getRecentFailureDetails());
}
