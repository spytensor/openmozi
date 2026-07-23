/**
 * Brain Engine — MOZI's direct interactive LLM/tool execution loop.
 *
 * Owns the hand-written loop extracted from handler.ts while preserving:
 * - Legacy XML tool call parsing (MiniMax)
 * - Output sanitization (think blocks, protocol leaks)
 * - Token budget tracking
 * - Streaming progress callbacks
 * - Recovery phases (self-heal, hard recovery, brain intervention)
 *
 * The handler.ts becomes a thin orchestrator that:
 * 1. Builds context
 * 2. Selects model
 * 3. Calls brainExecute()
 * 4. Handles post-execution (memory, title, session state)
 */

import pino from 'pino';
import { IncompleteStreamError, type LLMClient, type ChatMessage, type ChatOptions } from './llm.js';
import type { ToolContext } from '../tools/types.js';
import { executeToolCalls, extractToolIntent, extractToolSkillName } from '../tools/executor.js';
import { getAllRegisteredTools } from '../tools/dynamic-registry.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import { ArtifactCoordinator } from '../artifacts/coordinator.js';
import { createTurnFileArtifactTracker } from '../artifacts/file-artifacts.js';
import { findPublishedArtifactIdByPath } from '../memory/session-timeline.js';
import { buildActivePlanContext } from './plan-grounding.js';
import {
  createDurablePlanAdmissionState,
  DURABLE_PLAN_POLICY,
  SCHEDULER_CONTROL_POLICY,
  durablePlanBlockedResponse,
  rejectDurablePlanCompletion,
  resolveRuntimeAdmission,
  schedulerTerminalToolNames,
} from './durable-plan-admission.js';
import type { BrainExecutionOptions, BrainExecutionResult } from './brain-execution-types.js';
export type { BrainExecutionOptions, BrainExecutionResult } from './brain-execution-types.js';
import { hasDsmlToolCallMarkup, stripDsmlToolCallMarkup, extractLegacyToolCallsFromText } from './legacy-tool-parsing.js';
import { activeSkillScope, getActiveSkills } from '../skills/active-skills.js';
import { formatActiveSkillSection } from '../memory/context-slots.js';
import {
  buildCompletionGateBlockedResponse,
  buildCompletionGateFeedback,
  createCompletionGateState,
  evaluateCompletionGate,
  failForMissingDeliverables,
  recordCompletionGateBatch,
} from './completion-gates.js';
import { findMissingClaimedDeliverables } from './deliverable-verification.js';
import {
  shapePromptMessagesForExecution,
  shapeToolsForExecution,
} from '../tools/tool-shaping.js';
import { artifactEventContentType } from './brain-artifacts.js';
import { drainSteer, markBrainActivity } from '../gateway/steer-store.js';
import { prepareSteerInjection } from '../gateway/steer-injection.js';
import { buildRuntimeInterjection } from './runtime-interjection.js';
import { getProvider } from './providers.js';

const logger = pino({ name: 'mozi:brain-engine' });

// ---------------------------------------------------------------------------
// Output sanitization (moved from handler.ts)
// ---------------------------------------------------------------------------

/**
 * Wrap an LLMClient so every chat/chatStream call inside the loop reports its
 * without threading counters through each iteration helper.
 */
function withTurnChatOptions(
  client: LLMClient,
  collector: ChatOptions['usageCollector'],
  promptCacheKey: string | undefined,
): LLMClient {
  return {
    ...client,
    chat: (messages, options) => client.chat(messages, {
      ...options,
      ...(collector ? { usageCollector: collector } : {}),
      ...(promptCacheKey ? { promptCacheKey } : {}),
    }),
    chatStream: (messages, options) => client.chatStream(messages, {
      ...options,
      ...(collector ? { usageCollector: collector } : {}),
      ...(promptCacheKey ? { promptCacheKey } : {}),
    }),
  };
}

import {
  buildPreopenRenderableArtifact,
  createLiveArtifactInputTracker,
  emitTurnExecutionDetail,
  isRenderableArtifactEvent,
  parseToolArguments,
} from './brain-artifacts.js';
export { isRenderableArtifactEvent } from './brain-artifacts.js';
import { errorMessageForTerminalPatch, sanitizeVisibleOutput, throwIfAborted } from './brain-loop-policy.js';
import { executeNonStreamingTurn, executeRecovery, executeStreamingTurn, type TurnParams, type TurnResult } from './brain-turn-handlers.js';
import {
  sanitizeExecutionMessages,
  UnifiedExecutionKernel,
} from './unified-execution-kernel.js';
export { sanitizeVisibleOutput } from './brain-loop-policy.js';

const INTERACTIVE_LOOP_EXEMPT_TOOLS = new Set([
  'process_status',
  'process_output',
  'read_file',
  'list_directory',
  'web_search',
  'web_fetch',
  'browser_extract',
  'browser_assert',
  'list_tasks',
  'get_task',
  'list_runtime_skills',
  'list_cron_tasks',
]);

/**
 * Execute brain turn using Mozi's existing LLM client.
 *
 * This function owns the loop extracted from handler.ts and calls MOZI's
 * LLMClient.chat/chatStream APIs directly.
 *
 * Key improvement over the old while loop:
 * - Extracted as a pure function (no handler state dependency)
 * - Testable in isolation
 * - Clear input/output contract
 * - Recovery logic is self-contained
 */
export async function brainExecute(opts: BrainExecutionOptions): Promise<BrainExecutionResult> {
  const {
    contextMessages, maxTokens, temperature,
    progress, chatId, turnId, taskId,
    abortSignal,
    maxIterations, llmCallTimeoutMs, maxLoopElapsedMs,
    repeatedBatchThreshold, maxFailedToolBatches,
    selfHealRetries, selfHealBackoffMs,
  } = opts;
  const client = opts.usageCollector || opts.promptCacheKey
    ? withTurnChatOptions(opts.client, opts.usageCollector, opts.promptCacheKey)
    : opts.client;

  if (!opts.tenantId.trim()) {
    throw new Error('Brain execution requires a tenantId');
  }
  if (opts.toolContext.tenantId && opts.toolContext.tenantId !== opts.tenantId) {
    throw new Error(`Brain tenant mismatch: turn=${opts.tenantId} toolContext=${opts.toolContext.tenantId}`);
  }

  const loopMessages: ChatMessage[] = [...contextMessages];
  const appendTurnSystemContext = (content: string): void => {
    let lastUserIndex = -1;
    for (let index = loopMessages.length - 1; index >= 0; index--) {
      if (loopMessages[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    // interjection-lint-exempt: turn-START system-context assembly (policy
    // blocks inserted before the loop runs), not mid-turn runtime speech.
    loopMessages.splice(lastUserIndex >= 0 ? lastUserIndex : loopMessages.length, 0, {
      role: 'system',
      content,
    });
  };
  throwIfAborted(abortSignal, 'Request cancelled');

  const userMsg = contextMessages[contextMessages.length - 1]?.content?.toString() ?? '';
  const artifactCapable = typeof opts.toolContext.onArtifact === 'function';

  // Plan grounding: re-read persisted plan state from the DB every turn so the
  // Brain never depends on conversation memory for plan progress. Injected
  // before admission so the model can answer status/follow-up questions from
  // runtime truth. Existing plans never exempt a new complex request: a recent
  // completed plan or an unrelated running plan must not reopen inline tools.
  if (chatId) {
    try {
      const planContext = buildActivePlanContext(chatId, opts.tenantId);
      if (planContext) {
        appendTurnSystemContext(planContext);
      }
    } catch {
      // Grounding is best-effort; a broken block must never break the turn.
    }
  }

  // Runtime-owned admission: multi-phase requests must establish a persisted
  // DAG before any foreground work can execute. Prompt text explains the
  // contract, but enforcement happens below through the exposed tool surface
  // and the final-response gate. The model does not get to opt out.
  const externalCliTurn = opts.modelProvider
    ? getProvider(opts.modelProvider)?.apiMode === 'cli-pipe'
    : false;
  const runtimeAdmission = externalCliTurn
    ? undefined
    : Object.hasOwn(opts, 'runtimeAdmission')
      ? opts.runtimeAdmission
      : resolveRuntimeAdmission(userMsg);
  const durablePlanRequired = runtimeAdmission === 'durable_plan';
  const schedulerControlRequired = runtimeAdmission === 'scheduler_control';
  if (durablePlanRequired) {
    appendTurnSystemContext(DURABLE_PLAN_POLICY);
  }
  if (schedulerControlRequired) {
    appendTurnSystemContext(SCHEDULER_CONTROL_POLICY);
  }
  // NOTE(2026-07-18): the keyword-regex "[Artifact Contract]" system-context
  // block that used to be appended here is DELETED with its mid-turn repair
  // twin. Deciding that the user "explicitly requested an artifact" from a
  // keyword list is the runtime second-guessing the Brain — it misfired on a
  // file path containing ".html" and forced an unrequested artifact. Artifact
  // policy is SOUL's; deliverable truthfulness stays with the completion gate.

  let loopStopReason: string | null = null;
  let truncationContinuations = 0;
  const maxTruncationContinuations = 3;
  let responseText = '';
  let totalTokens = 0;
  let completionGateRejections = 0;
  const maxCompletionGateRejections = 2;
  const availableTools = externalCliTurn ? [] : getAllRegisteredTools(opts.tenantId);
  const toolShaping = shapeToolsForExecution({
    tools: availableTools,
    userText: userMsg,
    runtimeAdmission,
    provider: opts.modelProvider,
    model: opts.modelId,
  });
  if (durablePlanRequired && !toolShaping.tools.some(tool => tool.function.name === 'decompose_task')) {
    throw new Error('Durable plan admission requires the registered decompose_task tool');
  }
  if (schedulerControlRequired && toolShaping.tools.length === 0) {
    throw new Error('Scheduler control admission requires a registered scheduler tool');
  }
  const artifactVerificationProfiles = new Set(['office', 'report', 'data', 'creative', 'finance']);
  const completionGateState = createCompletionGateState(
    artifactVerificationProfiles.has(toolShaping.taskProfile) ? 'artifact' : 'project',
  );
  loopMessages.splice(0, loopMessages.length, ...shapePromptMessagesForExecution(loopMessages, toolShaping));
  const toolsDef = toolShaping.tools.length > 0 ? toolShaping.tools : undefined;
  const executionMetadata = {
    durablePlanRequired,
    taskToolProfile: toolShaping.taskProfile,
    exposedToolCount: toolShaping.shapedCount,
    toolSchemaTokensEstimate: toolShaping.schemaTokensEstimate,
  };
  const durablePlanAdmissionState = createDurablePlanAdmissionState();
  let schedulerAdmissionRejections = 0;
  const durablePlanBlockedResult = (model: string | undefined, iterationIndex: number): BrainExecutionResult => ({
    responseText: durablePlanBlockedResponse(userMsg),
    model,
    totalTokens,
    toolIterations: iterationIndex,
    recovered: true,
    recoveryMode: 'fallback',
    completionGateDecision: evaluateCompletionGate(completionGateState),
    durablePlanAdmissionBlocked: true,
    runtimeAdmissionBlocked: true,
    ...executionMetadata,
  });
  const schedulerBlockedResult = (model: string | undefined, iterationIndex: number): BrainExecutionResult => ({
    responseText: /[㐀-鿿]/.test(userMsg)
      ? 'MOZI 未能通过受管调度工具完成这次操作，因此没有创建、修改或取消任何定时任务。请重试。'
      : 'MOZI could not complete this request through the managed scheduler, so no schedule was created, changed, or cancelled. Please retry.',
    model,
    totalTokens,
    toolIterations: iterationIndex,
    recovered: true,
    recoveryMode: 'fallback',
    completionGateDecision: evaluateCompletionGate(completionGateState),
    durablePlanAdmissionBlocked: false,
    runtimeAdmissionBlocked: true,
    ...executionMetadata,
  });
  const resolveCompletionCandidate = (candidate: TurnResult, iterationIndex: number): BrainExecutionResult | null => {
    if (durablePlanRequired && candidate.terminalToolName !== 'decompose_task') {
      responseText = '';
      progress.onStreamEnd?.('');
      const admissionDecision = rejectDurablePlanCompletion(
        durablePlanAdmissionState,
        loopMessages,
        candidate.responseText,
      );
      if (!admissionDecision.blocked) {
        logger.warn({
          chatId,
          iteration: iterationIndex + 1,
          rejection: admissionDecision.rejection,
        }, 'Durable plan admission rejected direct model completion');
        return null;
      }
      logger.error({ chatId, iteration: iterationIndex + 1 }, 'Durable plan admission failed closed after model bypass attempts');
      return durablePlanBlockedResult(candidate.model, iterationIndex);
    }

    if (schedulerControlRequired && !schedulerTerminalToolNames(userMsg).has(candidate.terminalToolName ?? '')) {
      responseText = '';
      progress.onStreamEnd?.('');
      if (schedulerAdmissionRejections < 2) {
        schedulerAdmissionRejections += 1;
        if (candidate.responseText.trim()) loopMessages.push({ role: 'assistant', content: candidate.responseText });
        loopMessages.push(buildRuntimeInterjection(
          'kernel_directive',
          '[Runtime admission rejected] This turn must finish through the exposed MOZI scheduler tool. Do not execute the future workload, create a DAG, write files, or run shell commands now.',
        ));
        logger.warn({ chatId, iteration: iterationIndex + 1, schedulerAdmissionRejections }, 'Scheduler admission rejected direct completion');
        return null;
      }
      return schedulerBlockedResult(candidate.model, iterationIndex);
    }

    // Runtime fact check: if the final text claims deliverable files that do not
    // exist on disk, the gate FAILS regardless of what the model narrated — the
    // substrate, not the Brain, decides whether a deliverable was produced.
    const missingDeliverables = findMissingClaimedDeliverables(candidate.responseText, opts.toolContext.userId);
    const decision = failForMissingDeliverables(evaluateCompletionGate(completionGateState), missingDeliverables);
    if (decision.status === 'pending' || decision.status === 'failed') {
      if (completionGateRejections < maxCompletionGateRejections) {
        completionGateRejections += 1;
        loopMessages.push({ role: 'assistant', content: candidate.responseText });
        loopMessages.push(buildRuntimeInterjection('completion_gate', buildCompletionGateFeedback(decision)));
        progress.onStreamEnd?.('');
        return null;
      }
      return {
        // Deliver what the model actually produced plus an honest caveat —
        // never swallow the deliverable or surface internal verifier actions.
        responseText: buildCompletionGateBlockedResponse(
          decision,
          userMsg,
          candidate.responseText,
          artifactCoordinator?.completedDeliverableTitles() ?? [],
        ),
        model: candidate.model,
        totalTokens,
        toolIterations: iterationIndex,
        recovered: true,
        recoveryMode: 'fallback',
        completionGateDecision: decision,
        completionGateBlocked: true,
        ...executionMetadata,
      };
    }
    return {
      responseText: candidate.responseText,
      model: candidate.model,
      totalTokens,
      toolIterations: iterationIndex,
      recovered: false,
      completionGateDecision: decision,
      detachedPlanRootId: candidate.detachedPlanRootId,
      ...executionMetadata,
    };
  };

  let renderableArtifactEmitted = false;
  const executionStartedAt = Date.now();
  const deadlineController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleExecutionDeadline = (timeoutMs: number): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (timeoutMs <= 0 || deadlineController.signal.aborted) return;
    const remainingMs = timeoutMs - (Date.now() - executionStartedAt);
    if (remainingMs <= 0) {
      deadlineController.abort(new Error('Gateway execution deadline exceeded'));
      return;
    }
    deadlineTimer = setTimeout(
      () => deadlineController.abort(new Error('Gateway execution deadline exceeded')),
      remainingMs,
    );
    deadlineTimer.unref?.();
  };
  const executionKernel = new UnifiedExecutionKernel({
    scope: 'gateway',
    tenantId: opts.tenantId,
    chatId,
    taskId,
    maxIterations,
    llmCallTimeoutMs,
    maxLoopElapsedMs,
    maxFailedToolBatches,
    repeatedFailureStrategy: 'inject_then_stop',
    timeoutMode: 'wall_clock',
    onLoopTimeoutChanged: scheduleExecutionDeadline,
    loopDetectorOptions: {
      consecutiveThreshold: repeatedBatchThreshold,
      exemptToolNames: INTERACTIVE_LOOP_EXEMPT_TOOLS,
      countingMode: 'turn_frequency',
    },
  });
  const executionAbortSignal = abortSignal
    ? AbortSignal.any([abortSignal, deadlineController.signal])
    : deadlineController.signal;
  const baseToolContext: ToolContext = { ...opts.toolContext, tenantId: opts.tenantId, abortSignal: executionAbortSignal };
  const turnRichArtifactPaths = baseToolContext.turnRichArtifactPaths ?? new Set<string>();
  const artifactCoordinator = baseToolContext.artifactCoordinator ?? (artifactCapable
    ? new ArtifactCoordinator(turnId, (event) => {
        if (isRenderableArtifactEvent(event)) {
          renderableArtifactEmitted = true;
          const contentType = artifactEventContentType(event);
        }
        baseToolContext.onArtifact?.(event);
      })
    : undefined);
  const trackedToolContext: ToolContext = artifactCapable
    ? {
      ...baseToolContext,
      turnRichArtifactPaths,
      artifactCoordinator,
    }
    : baseToolContext;

  const fileArtifactTracker = artifactCapable
      ? createTurnFileArtifactTracker({
          activeRootPath: opts.toolContext.workspaceRootPath,
          tenantId: opts.tenantId,
          sessionId: opts.toolContext.sessionId,
          userId: opts.toolContext.userId,
          richArtifactPaths: turnRichArtifactPaths,
          artifactCoordinator,
          resolvePublishedArtifactId: opts.toolContext.sessionId
            ? (path) => findPublishedArtifactIdByPath({
                tenantId: opts.toolContext.tenantId,
                sessionId: opts.toolContext.sessionId!,
                path,
              })
            : undefined,
        })
    : undefined;
  await fileArtifactTracker?.captureBaseline();
  scheduleExecutionDeadline(maxLoopElapsedMs);

  logger.debug({ chatId, userText: contextMessages[contextMessages.length - 1]?.content?.toString().slice(0, 80) }, 'Brain execution starting');

  let iteration = 0;
  try {
  while (executionKernel.canContinue()) {
    throwIfAborted(abortSignal, 'Request cancelled');

    const iterationBudget = executionKernel.beginIteration();
    if ('stopReason' in iterationBudget) {
      loopStopReason = iterationBudget.stopReason;
      logger.warn({
        chatId,
        elapsedMs: executionKernel.elapsedMs(),
        maxLoopElapsedMs: executionKernel.currentLoopTimeoutMs,
      }, 'Tool loop timed out');
      break;
    }
    iteration = iterationBudget.iteration;
    const i = iteration - 1;
    const effectiveCallTimeoutMs = iterationBudget.effectiveCallTimeoutMs;
    markBrainActivity(opts.tenantId, chatId, turnId);
    const queuedSteers = drainSteer(opts.tenantId, chatId, turnId);
    if (queuedSteers.length > 0) {
      loopMessages.push(...prepareSteerInjection(chatId, opts.tenantId, queuedSteers));
    }
    const sanitizedMessages = sanitizeExecutionMessages(loopMessages);
    if (sanitizedMessages !== loopMessages) {
      loopMessages.length = 0;
      loopMessages.push(...sanitizedMessages);
    }

    // --- LLM call (streaming or non-streaming) ---
    const isStreaming = !!progress.onStreamChunk;

    if (isStreaming) {
      const result = await executeStreamingTurn({
        client, loopMessages, maxTokens, temperature, think: opts.think, toolsDef,
        effectiveCallTimeoutMs, progress, chatId, turnId, taskId, i, executionKernel,
        truncationContinuations, maxTruncationContinuations,
        toolContext: trackedToolContext, tenantId: opts.tenantId,
        abortSignal,
        executionAbortSignal,
        fileArtifactTracker,
        completionGateState,
        runtimeAdmission,
        durablePlanAdmissionState,
      });

      truncationContinuations = result.truncationContinuations;
      totalTokens += result.totalTokens ?? 0;

      if (result.action === 'final') {
        responseText = result.responseText;
        const resolved = resolveCompletionCandidate(result, i);
        if (resolved) return resolved;
        continue;
      }
      if (result.action === 'stop') {
        loopStopReason = result.stopReason ?? 'max_iterations';
        break;
      }
      // action === 'continue' — loop continues
    } else {
      const result = await executeNonStreamingTurn({
        client, loopMessages, maxTokens, temperature, think: opts.think, toolsDef,
        effectiveCallTimeoutMs, progress, chatId, turnId, taskId, i, executionKernel,
        truncationContinuations, maxTruncationContinuations,
        toolContext: trackedToolContext, tenantId: opts.tenantId,
        abortSignal,
        executionAbortSignal,
        fileArtifactTracker,
        completionGateState,
        runtimeAdmission,
        durablePlanAdmissionState,
      });

      truncationContinuations = result.truncationContinuations;
      totalTokens += result.totalTokens ?? 0;

      if (result.action === 'final') {
        responseText = result.responseText;
        const resolved = resolveCompletionCandidate(result, i);
        if (resolved) return resolved;
        continue;
      }
      if (result.action === 'stop') {
        loopStopReason = result.stopReason ?? 'max_iterations';
        break;
      }
    }
  }
  loopStopReason ??= executionKernel.stopReasonAfterLoop();

  // --- Recovery if no response ---
  if (!responseText) {
    throwIfAborted(abortSignal, 'Request cancelled');
    // Recovery is intentionally not allowed to bypass a required DAG by
    // producing an unverified inline answer after timeout/loop exhaustion.
    if (durablePlanRequired) {
      return durablePlanBlockedResult(undefined, iteration);
    }
    if (schedulerControlRequired) {
      return schedulerBlockedResult(undefined, iteration);
    }
    const gateDecision = evaluateCompletionGate(completionGateState);
    if (gateDecision.status === 'pending' || gateDecision.status === 'failed') {
      return {
        responseText: buildCompletionGateBlockedResponse(
          gateDecision,
          userMsg,
          undefined,
          artifactCoordinator?.completedDeliverableTitles() ?? [],
        ),
        totalTokens,
        toolIterations: iteration,
        recovered: true,
        recoveryMode: 'fallback',
        completionGateDecision: gateDecision,
        completionGateBlocked: true,
        ...executionMetadata,
      };
    }
    const recoveryResult = await executeRecovery({
      client, contextMessages, loopMessages, chatId, turnId,
      loopStopReason: loopStopReason ?? 'max_iterations',
      selfHealRetries, selfHealBackoffMs,
      llmCallTimeoutMs,
      abortSignal,
      executionAbortSignal,
      executionKernel,
    });
    return {
      responseText: recoveryResult.responseText,
      model: recoveryResult.model,
      totalTokens: totalTokens + (recoveryResult.totalTokens ?? 0),
      toolIterations: iteration,
      recovered: true,
      recoveryMode: recoveryResult.mode,
      completionGateDecision: gateDecision,
      ...executionMetadata,
    };
  }

  return {
    responseText,
    totalTokens,
    toolIterations: iteration,
    recovered: false,
    completionGateDecision: evaluateCompletionGate(completionGateState),
    ...executionMetadata,
  };
  } catch (err) {
    artifactCoordinator?.terminateAll('failed', errorMessageForTerminalPatch(err, 'Artifact generation interrupted'));
    throw err;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    artifactCoordinator?.terminateAll('closed');
  }
}
