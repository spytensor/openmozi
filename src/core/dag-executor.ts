import pino from 'pino';
import type { LLMClient } from './llm.js';
import type { TaskRecord } from '../store/task-dag.js';
import { getById, getDependencies, incrementAttempts, updateStatus, updateTask } from '../store/task-dag.js';
import { loadTaskResult } from '../tasks/workspace.js';
import { getConfig } from '../config/index.js';
import {
  startTracking,
  reportTaskStarted,
  reportTaskCompleted,
  reportTaskFailed,
  reportTaskCancelled,
  reportTaskRetryScheduled,
  stopTracking,
} from '../progress/progress-reporter.js';
import { log as logEvent } from '../store/events.js';
import { dispatchToSubAgent, isSubAgentAvailable } from './subagent-dispatch.js';
import { write as writeBlackboard } from '../capabilities/blackboard.js';
import { searchLessons, incrementApplied } from '../memory/lessons.js';
import {
  TaskCancelledError,
  registerRunningTask,
  finishRunningTask,
  clearCancellationRequest,
  isTaskCancellationRequested,
  throwIfTaskCancelled,
} from './task-cancellation.js';
import { reportTimeoutAndMaybeTune } from './autonomous-timeout.js';
import { buildDependencyMap, buildDependentsMap, topologicalOrder } from './dag-graph.js';
import { executeSingleTask, isTimeoutFallbackResult, isInterruptedFallbackResult } from './dag-task-loop.js';
import type { ToolContext } from '../tools/types.js';
import { buildExecutionToolContext } from '../tools/execution-context.js';
import { normalizeProviderError, ProviderRuntimeError } from './error-surfacing.js';

const logger = pino({ name: 'mozi:dag-executor' });
const RETRY_BASE_DELAYS_MS = [10_000, 60_000, 300_000] as const;
const RETRY_JITTER_RATIO = 0.2;
const MAX_STEP_RETRY_WINDOW_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Process-wide DAG concurrency — one truthful limit for every execution path
// ---------------------------------------------------------------------------

class DagConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<{
    limit: number;
    resolve: (release: () => void) => void;
  }> = [];

  async acquire(limit: number): Promise<() => void> {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (this.active < normalizedLimit && this.waiting.length === 0) {
      return this.grant();
    }
    return new Promise<() => void>((resolve) => {
      this.waiting.push({ limit: normalizedLimit, resolve });
      this.drain();
    });
  }

  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiting.length > 0 && this.active < this.waiting[0].limit) {
      const next = this.waiting.shift()!;
      next.resolve(this.grant());
    }
  }
}

const dagConcurrencyLimiter = new DagConcurrencyLimiter();

type SubagentFallbackReason = 'subagent_dispatch_failed' | 'subagent_dispatch_exception' | 'no_subagent_available';

interface SubagentFallbackMetadata {
  runtimeSource?: string;
  runtimeSessionKey?: string;
  sessionId?: string;
  turnId?: string;
  toolContext?: ToolContext;
  detail?: string;
}

function recordSubagentFallbackForTask(
  task: TaskRecord,
  chatId: string,
  reason: SubagentFallbackReason,
  metadata?: SubagentFallbackMetadata,
): void {
  try {
    logEvent(
      'dag_subagent_fallback',
      'task',
      task.id,
      {
        chat_id: chatId,
        reason,
        fallback: 'in_process',
        runtime_source: metadata?.runtimeSource ?? 'unknown',
        runtime_session_key: metadata?.runtimeSessionKey ?? null,
        session_id: metadata?.sessionId ?? null,
        turn_id: metadata?.turnId,
        detail: metadata?.detail,
      },
      task.tenant_id,
    );
  } catch (err) {
    logger.warn({
      taskId: task.id,
      chatId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist SubAgent fallback event');
  }
}

function recordSubagentUnavailableForDag(
  tenantId: string,
  chatId: string,
  taskCount: number,
  metadata?: SubagentFallbackMetadata,
): void {
  try {
    logEvent(
      'dag_subagent_fallback',
      'dag',
      chatId,
      {
        chat_id: chatId,
        reason: 'no_subagent_available',
        fallback: 'in_process',
        task_count: taskCount,
        runtime_source: metadata?.runtimeSource ?? 'unknown',
        runtime_session_key: metadata?.runtimeSessionKey ?? null,
        turn_id: metadata?.turnId,
      },
      tenantId,
    );
  } catch (err) {
    logger.warn({
      chatId,
      reason: 'no_subagent_available',
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist DAG SubAgent unavailable event');
  }
}

type ExecutionStatus = 'pending' | 'ready' | 'waiting_retry' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';

interface ExecutionState {
  status: ExecutionStatus;
  result?: string;
  error?: string;
  attempts: number;
}

interface TaskExecutionOutcome {
  taskId: string;
  success: boolean;
  cancelled?: boolean;
  result?: string;
  error?: string;
  elapsedMs: number;
  timedOut?: boolean;
  retryable?: boolean;
  retryAfterMs?: number;
}

function clearTaskGuardReason(taskId: string, tenantId: string, clearRetryWindow = false): void {
  const persisted = getById(taskId, tenantId);
  if (!persisted) return;
  const constraints = { ...persisted.constraints };
  const hadGuardReason = typeof constraints.guard_reason === 'string';
  delete constraints.guard_reason;
  delete constraints.failure_retryable;
  if (clearRetryWindow) delete constraints.retry_window_started_at;
  if (!hadGuardReason
    && constraints.failure_retryable === persisted.constraints?.failure_retryable
    && constraints.retry_window_started_at === persisted.constraints?.retry_window_started_at) return;
  updateTask(taskId, { constraints }, tenantId);
  if (hadGuardReason) {
    logEvent('task_guard_cleared', 'task', taskId, { reason: 'execution_recovered' }, tenantId);
  }
}

function retryBackoffMs(attempt: number): number {
  const base = RETRY_BASE_DELAYS_MS[Math.min(Math.max(0, attempt - 1), RETRY_BASE_DELAYS_MS.length - 1)];
  const jitter = 1 - RETRY_JITTER_RATIO + (Math.random() * RETRY_JITTER_RATIO * 2);
  return Math.round(base * jitter);
}

export interface DagTaskProgressEvent {
  type: 'task_started' | 'task_completed' | 'task_failed' | 'task_cancelled';
  taskId: string;
  taskTitle: string;
  elapsed_ms?: number;
  error?: string;
  /**
   * Result excerpt for a completed task (first 400 chars of its output).
   * Travels persist-then-broadcast into the session timeline so the plan
   * card can disclose what each step actually produced — steps that used
   * no tools would otherwise have nothing to show behind their row.
   */
  detail?: string;
}

export type DagProgressCallback = (event: DagTaskProgressEvent) => void | Promise<void>;

/**
 * Execute a task DAG through an event-driven ready queue. Dependency completion
 * releases successors immediately, while one process-wide admission limit
 * covers both in-process and SubAgent execution paths.
 */
export interface DagExecutionOptions {
  /** When true, dispatch tasks to SubAgent child processes instead of in-process LLM loops. */
  useSubAgents?: boolean;
  /** Observability tag describing who enabled SubAgent runtime (global/tenant/session/capability). */
  subagentRuntimeSource?: string;
  /** Session key used by rollout controls (tenant:session/chat). */
  subagentSessionKey?: string;
  /** DB session ID used by the Web UI timeline. */
  sessionId?: string;
  /** Permission/session context inherited from the originating turn. */
  toolContext?: ToolContext;
}

export async function executeDag(
  tasks: TaskRecord[],
  systemPrompt: string,
  chatId: string,
  progress?: DagProgressCallback,
  fallbackClient?: LLMClient,
  turnId?: string,
  options?: DagExecutionOptions,
): Promise<string> {
  if (tasks.length === 0) {
    return '(No tasks to execute)';
  }

  const planRootId = tasks.find(task => task.parent_task_id)?.parent_task_id;
  const dagId = planRootId ?? `dag:${turnId ?? tasks[0].id}`;
  const tenantId = tasks[0].tenant_id;
  const requestedSubAgents = options?.useSubAgents === true;
  const subagentAvailable = requestedSubAgents ? isSubAgentAvailable(tenantId) : false;
  const useSubAgents = requestedSubAgents && subagentAvailable;
  const maxParallel = Math.max(1, getConfig().system.max_parallel_agents);

  if (requestedSubAgents && !subagentAvailable) {
    logger.info({
      tenantId,
      chatId,
      source: options?.subagentRuntimeSource ?? 'unknown',
    }, 'SubAgent runtime requested but unavailable, using in-process fallback');
    recordSubagentUnavailableForDag(
      tenantId,
      chatId,
      tasks.length,
      {
        runtimeSource: options?.subagentRuntimeSource,
        runtimeSessionKey: options?.subagentSessionKey,
        sessionId: options?.sessionId,
        turnId,
      },
    );
  }

  if (useSubAgents) {
    logger.info({
      maxParallel,
      source: options?.subagentRuntimeSource ?? 'unknown',
      sessionKey: options?.subagentSessionKey ?? `${tenantId}:${chatId}`,
    }, 'DAG using SubAgent dispatch');
  }

  const taskById = new Map(tasks.map(task => [task.id, task]));
  const dependencies = buildDependencyMap(tasks, taskById);
  const dependents = buildDependentsMap(tasks, dependencies);
  const topoOrder = topologicalOrder(tasks, dependencies, dependents);

  startTracking(dagId, tasks.length, chatId, turnId, options?.sessionId, tenantId);

  const state = new Map<string, ExecutionState>();
  for (const task of tasks) {
    state.set(task.id, { status: 'pending', attempts: task.attempts });
  }

  const emitTaskEvent = async (event: DagTaskProgressEvent): Promise<void> => {
    const task = taskById.get(event.taskId);
    if (task) {
      const nextStatus = event.type === 'task_started'
        ? 'running'
        : event.type === 'task_completed'
        ? 'completed'
        : event.type === 'task_cancelled'
        ? 'cancelled'
        : 'failed';
      updateStatus(task.id, nextStatus, task.tenant_id);
      logEvent(event.type, 'task', task.id, {
        title: task.title,
        elapsed_ms: event.elapsed_ms,
        error: event.error,
      }, task.tenant_id);
    }

    // Parent linkage (Issue #624): surface the subtask's owning plan-root/parent
    // so the timeline nests it under the correct group. undefined for a top-level
    // task (e.g. the plan root itself).
    const parentTaskId = task?.parent_task_id ?? undefined;
    if (event.type === 'task_started') {
      reportTaskStarted(dagId, event.taskId, event.taskTitle, parentTaskId);
    } else if (event.type === 'task_completed') {
      reportTaskCompleted(dagId, event.taskId, event.taskTitle, event.elapsed_ms ?? 0, parentTaskId, event.detail);
    } else if (event.type === 'task_cancelled') {
      reportTaskCancelled(dagId, event.taskId, event.taskTitle, event.error ?? 'Task cancelled', parentTaskId);
    } else {
      reportTaskFailed(dagId, event.taskId, event.taskTitle, event.error ?? 'Unknown error', parentTaskId);
    }

    if (progress) {
      await progress(event);
    }
  };

  const failDependents = async (failedTaskId: string, reason: string): Promise<void> => {
    const queue = [...(dependents.get(failedTaskId) ?? [])];

    while (queue.length > 0) {
      const dependentId = queue.shift()!;
      const snapshot = state.get(dependentId);
      if (!snapshot || snapshot.status !== 'pending') {
        continue;
      }

      const dependentTask = taskById.get(dependentId);
      if (!dependentTask) {
        continue;
      }

      // Check on_dep_failure policy
      if (dependentTask.on_dep_failure === 'continue') {
        // Task opts to continue despite upstream failure — don't cascade
        logger.info({
          taskId: dependentTask.id,
          failedDep: failedTaskId,
          policy: 'continue',
        }, 'Upstream failed but dependent continues per on_dep_failure policy');
        continue;
      }

      // fail_fast (default): the dependent did not execute. Persist it as
      // blocked rather than lying that its own work failed.
      const error = `Dependency failed: ${reason}`;
      state.set(dependentId, { status: 'blocked', error, attempts: snapshot.attempts });
      updateTask(dependentTask.id, {
        constraints: {
          ...dependentTask.constraints,
          blocked_by_task_id: failedTaskId,
          blocked_reason: error,
        },
      }, dependentTask.tenant_id);
      updateStatus(dependentTask.id, 'blocked', dependentTask.tenant_id, {
        reason: error,
        blocked_by_task_id: failedTaskId,
      });
      logEvent('task_blocked', 'task', dependentTask.id, {
        title: dependentTask.title,
        error,
        blocked_by_task_id: failedTaskId,
      }, dependentTask.tenant_id);

      queue.push(...(dependents.get(dependentId) ?? []));
    }
  };

  const cancelDependents = async (cancelledTaskId: string, reason: string): Promise<void> => {
    const queue = [...(dependents.get(cancelledTaskId) ?? [])];
    while (queue.length > 0) {
      const dependentId = queue.shift()!;
      const snapshot = state.get(dependentId);
      if (!snapshot || snapshot.status !== 'pending') {
        continue;
      }

      const dependentTask = taskById.get(dependentId);
      if (!dependentTask) continue;

      const error = `Dependency cancelled: ${reason}`;
      state.set(dependentId, { status: 'cancelled', error, attempts: snapshot.attempts });
      await emitTaskEvent({
        type: 'task_cancelled',
        taskId: dependentTask.id,
        taskTitle: dependentTask.title,
        error,
      });
      clearCancellationRequest(dependentTask.id, dependentTask.tenant_id);
      queue.push(...(dependents.get(dependentId) ?? []));
    }
  };

  const inFlight = new Map<string, Promise<void>>();
  const retryDelays = new Map<string, Promise<void>>();
  const retryWindowStarts = new Map<string, number>();
  for (const task of tasks) {
    if (task.constraints.retry_window_started_at !== undefined) {
      retryWindowStarts.set(task.id, task.constraints.retry_window_started_at);
    }
  }

  const dependenciesResolved = (taskId: string): boolean => {
    const task = taskById.get(taskId);
    return (dependencies.get(taskId) ?? []).every((depId) => {
      const depStatus = state.get(depId)?.status;
      if (depStatus === 'completed') return true;
      return depStatus === 'failed' && task?.on_dep_failure === 'continue';
    });
  };

  const markNewlyReady = (): void => {
    for (const taskId of topoOrder) {
      const snapshot = state.get(taskId);
      if (!snapshot || snapshot.status !== 'pending' || !dependenciesResolved(taskId)) continue;
      const task = taskById.get(taskId)!;
      state.set(taskId, { ...snapshot, status: 'ready' });
      if (task.status !== 'ready' || snapshot.attempts > 0) {
        updateStatus(task.id, 'ready', task.tenant_id, { reason: 'dependencies_resolved' });
      }
    }
  };

  const executeAttempt = async (taskId: string): Promise<TaskExecutionOutcome> => {
    const task = taskById.get(taskId)!;
    const prevState = state.get(taskId)!;
    const startedAt = Date.now();
    const taskAbortSignal = registerRunningTask({
      taskId: task.id,
      tenantId: task.tenant_id,
      chatId,
      turnId,
      taskTitle: task.title,
    });

    try {
      throwIfTaskCancelled(taskAbortSignal, task.id);
      incrementAttempts(task.id, task.tenant_id);
      state.set(taskId, { status: 'running', attempts: prevState.attempts });
      await emitTaskEvent({ type: 'task_started', taskId: task.id, taskTitle: task.title });

      let depContext = buildDependencyContext(task, dependencies, state, taskById);
      if (prevState.attempts > 0) depContext = appendLessonsContext(depContext, task);

      if (useSubAgents) {
        return await executeViaSubAgentOrFallback(
          task, systemPrompt, chatId, depContext, fallbackClient, turnId, startedAt, taskAbortSignal,
          {
            runtimeSource: options?.subagentRuntimeSource,
            runtimeSessionKey: options?.subagentSessionKey,
            sessionId: options?.sessionId,
            turnId,
            toolContext: options?.toolContext,
          },
        );
      }

      const result = await executeSingleTask(
        task,
        systemPrompt,
        chatId,
        fallbackClient,
        depContext,
        turnId,
        taskAbortSignal,
        options?.toolContext,
      );
      if (isInterruptedFallbackResult(result)) {
        return {
          taskId,
          success: false,
          cancelled: true,
          error: result,
          elapsedMs: Date.now() - startedAt,
        };
      }
      const timedOut = isTimeoutFallbackResult(result);
      return {
        taskId,
        success: !timedOut,
        result: timedOut ? undefined : result,
        error: timedOut ? 'Task timed out' : undefined,
        elapsedMs: Date.now() - startedAt,
        timedOut,
      };
    } catch (err) {
      if (err instanceof TaskCancelledError || taskAbortSignal.aborted) {
        return {
          taskId,
          success: false,
          cancelled: true,
          error: err instanceof Error ? err.message : 'Task cancelled',
          elapsedMs: Date.now() - startedAt,
        };
      }
      return {
        taskId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
        retryable: isRetryableTaskError(err),
        retryAfterMs: retryAfterMs(err),
      };
    } finally {
      finishRunningTask(task.id, task.tenant_id);
    }
  };

  const handleOutcome = async (outcome: TaskExecutionOutcome): Promise<void> => {
    const taskId = outcome.taskId;
    const task = taskById.get(taskId)!;
    const prevAttempts = state.get(taskId)?.attempts ?? 0;
    const attempts = prevAttempts + 1;
    const maxRetries = task.constraints.max_retries ?? 2;

    if (outcome.cancelled) {
      const error = outcome.error || 'Task cancelled';
      state.set(taskId, { status: 'cancelled', error, attempts });
      await emitTaskEvent({
        type: 'task_cancelled',
        taskId: task.id,
        taskTitle: task.title,
        elapsed_ms: outcome.elapsedMs,
        error,
      });
      await cancelDependents(taskId, `${task.title}: ${error}`);
      clearCancellationRequest(task.id, task.tenant_id);
      return;
    }

    if (outcome.success) {
      clearTaskGuardReason(task.id, task.tenant_id, true);
      state.set(taskId, { status: 'completed', result: outcome.result, attempts });
      await emitTaskEvent({
        type: 'task_completed',
        taskId: task.id,
        taskTitle: task.title,
        elapsed_ms: outcome.elapsedMs,
        // Code-point slice: a UTF-16 .slice can split a surrogate pair
        // (emoji/astral char) at the boundary into a replacement character.
        detail: outcome.result ? Array.from(outcome.result.trim()).slice(0, 400).join('') || undefined : undefined,
      });
      clearCancellationRequest(task.id, task.tenant_id);
      return;
    }

    const retryableFailure = outcome.timedOut === true || outcome.retryable === true;
    const retryWindowStartedAt = retryWindowStarts.get(taskId) ?? Date.now();
    const retryWindowElapsedMs = Date.now() - retryWindowStartedAt;
    const computedBackoffMs = retryBackoffMs(attempts);
    const retryDelayMs = Math.max(computedBackoffMs, outcome.retryAfterMs ?? 0);
    const retryWindowRemainingMs = MAX_STEP_RETRY_WINDOW_MS - retryWindowElapsedMs;

    if (retryableFailure && prevAttempts < maxRetries && retryDelayMs < retryWindowRemainingMs) {
      retryWindowStarts.set(taskId, retryWindowStartedAt);
      logger.info({
        taskId: task.id,
        status: 'waiting_retry',
        attempt: attempts,
        maxRetries,
        retryAfterMs: retryDelayMs,
      }, 'Recoverable task failure, re-queuing for retry');
      clearTaskGuardReason(task.id, task.tenant_id);
      const persisted = getById(task.id, task.tenant_id);
      updateTask(task.id, {
        constraints: {
          ...(persisted?.constraints ?? task.constraints),
          retry_window_started_at: retryWindowStartedAt,
        },
      }, task.tenant_id);
      state.set(taskId, { status: 'waiting_retry', attempts });
      updateStatus(task.id, 'pending', task.tenant_id, { reason: 'retry_backoff' });
      logEvent('task_retry_scheduled', 'task', task.id, {
        title: task.title,
        attempt: attempts,
        max_retries: maxRetries,
        retry_after_ms: retryDelayMs,
        reason: outcome.error,
      }, task.tenant_id);
      reportTaskRetryScheduled(dagId, task.id);

      const delay = new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs))
        .then(() => {
          const snapshot = state.get(taskId);
          if (snapshot?.status === 'waiting_retry') {
            state.set(taskId, { ...snapshot, status: 'pending' });
          }
        })
        .finally(() => retryDelays.delete(taskId));
      retryDelays.set(taskId, delay);
      return;
    }

    const retryWindowExhausted = retryableFailure && retryWindowRemainingMs <= retryDelayMs;
    const error = retryWindowExhausted
      ? `${outcome.error || 'Recoverable task error'} (15 minute retry window exhausted)`
      : outcome.error || 'Unknown task error';
    state.set(taskId, { status: 'failed', error, attempts });
    const persisted = getById(task.id, task.tenant_id);
    updateTask(task.id, {
      constraints: {
        ...(persisted?.constraints ?? task.constraints),
        failure_retryable: retryableFailure,
      },
    }, task.tenant_id);
    await emitTaskEvent({
      type: 'task_failed',
      taskId: task.id,
      taskTitle: task.title,
      elapsed_ms: outcome.elapsedMs,
      error,
    });
    await failDependents(taskId, `${task.title}: ${error}`);
    clearCancellationRequest(task.id, task.tenant_id);
  };

  const startReadyTask = (taskId: string): void => {
    const execution = (async () => {
      const release = await dagConcurrencyLimiter.acquire(maxParallel);
      try {
        const snapshot = state.get(taskId);
        if (!snapshot || snapshot.status !== 'ready') return;
        const outcome = await executeAttempt(taskId);
        await handleOutcome(outcome);
      } finally {
        release();
      }
    })().catch(async (err) => {
      const task = taskById.get(taskId)!;
      const snapshot = state.get(taskId);
      if (!snapshot || ['completed', 'failed', 'cancelled', 'blocked'].includes(snapshot.status)) return;
      const error = err instanceof Error ? err.message : String(err);
      state.set(taskId, { status: 'failed', error, attempts: snapshot.attempts + 1 });
      await emitTaskEvent({ type: 'task_failed', taskId, taskTitle: task.title, error });
      await failDependents(taskId, `${task.title}: ${error}`);
    });
    const tracked = execution.finally(() => inFlight.delete(taskId));
    inFlight.set(taskId, tracked);
  };

  const settleQueuedTasks = async (): Promise<void> => {
    for (const taskId of topoOrder) {
      const snapshot = state.get(taskId);
      if (!snapshot || !['pending', 'ready'].includes(snapshot.status)) continue;
      const task = taskById.get(taskId)!;

      if (isTaskCancellationRequested(task.id, task.tenant_id)) {
        const error = 'Task cancelled';
        state.set(taskId, { status: 'cancelled', error, attempts: snapshot.attempts });
        await emitTaskEvent({ type: 'task_cancelled', taskId: task.id, taskTitle: task.title, error });
        await cancelDependents(taskId, `${task.title}: ${error}`);
        clearCancellationRequest(task.id, task.tenant_id);
        continue;
      }

      const maxRetries = task.constraints.max_retries ?? 2;
      if (snapshot.attempts > maxRetries) {
        const error = `Task retry budget exhausted after ${snapshot.attempts} attempts`;
        state.set(taskId, { status: 'failed', error, attempts: snapshot.attempts });
        await emitTaskEvent({ type: 'task_failed', taskId: task.id, taskTitle: task.title, error });
        await failDependents(taskId, `${task.title}: ${error}`);
        clearCancellationRequest(task.id, task.tenant_id);
      }
    }
  };

  while (true) {
    await settleQueuedTasks();
    markNewlyReady();
    for (const taskId of topoOrder) {
      if (state.get(taskId)?.status === 'ready' && !inFlight.has(taskId)) {
        startReadyTask(taskId);
      }
    }

    const pendingWork = [...inFlight.values(), ...retryDelays.values()];
    if (pendingWork.length === 0) break;
    await Promise.race(pendingWork);
  }

  for (const taskId of topoOrder) {
    const snapshot = state.get(taskId);
    if (snapshot && ['pending', 'ready', 'waiting_retry', 'running'].includes(snapshot.status)) {
      const task = taskById.get(taskId)!;
      if (isTaskCancellationRequested(task.id, task.tenant_id)) {
        const error = 'Task cancelled';
        state.set(taskId, { status: 'cancelled', error, attempts: snapshot.attempts });
        await emitTaskEvent({
          type: 'task_cancelled',
          taskId: task.id,
          taskTitle: task.title,
          error,
        });
      } else {
        const error = 'Task was not executed due to unresolved dependencies';
        state.set(taskId, { status: 'blocked', error, attempts: snapshot.attempts });
        updateTask(task.id, {
          constraints: { ...task.constraints, blocked_reason: error },
        }, task.tenant_id);
        updateStatus(task.id, 'blocked', task.tenant_id, { reason: error });
        logEvent('task_blocked', 'task', task.id, {
          title: task.title,
          error,
          reason: 'unresolved_dependencies',
        }, task.tenant_id);
      }
      clearCancellationRequest(task.id, task.tenant_id);
    }
  }

  const aggregatedOutput = topoOrder.map((taskId, index) => {
    const task = taskById.get(taskId)!;
    const snapshot = state.get(taskId)!;

    const title = `Task ${index + 1}: ${task.title}`;
    if (snapshot.status === 'completed') {
      return `${title}\n${snapshot.result?.trim() || '(no output)'}`;
    }

    if (snapshot.status === 'cancelled') {
      return `${title}\nCancelled: ${snapshot.error || 'Task cancelled'}`;
    }

    if (snapshot.status === 'blocked') {
      return `${title}\nBlocked (not executed): ${snapshot.error || 'Waiting for dependencies'}`;
    }

    return `${title}\nError: ${snapshot.error || 'Unknown error'}`;
  }).join('\n\n---\n\n');

  stopTracking(dagId);
  logger.info({ totalTasks: tasks.length }, 'DAG execution completed');
  return aggregatedOutput;
}

function isRetryableTaskError(err: unknown): boolean {
  if (err instanceof ProviderRuntimeError) {
    return err.kind === 'transient' || err.kind === 'rate_limit';
  }
  if (err && typeof err === 'object' && 'retryable' in err && (err as { retryable?: unknown }).retryable === true) {
    return true;
  }
  const providerError = normalizeProviderError(err);
  return providerError.kind === 'transient' || providerError.kind === 'rate_limit';
}

function retryAfterMs(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/try again in\s+([0-9.]+)\s*(ms|s)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return match[2].toLowerCase() === 's' ? Math.ceil(value * 1000) : Math.ceil(value);
}

/**
 * Search for relevant lessons and append them to the dependency context.
 * Called on retry attempts so the LLM can learn from past failures.
 */
function appendLessonsContext(depContext: string, task: TaskRecord): string {
  try {
    // Search by task title keywords
    const keywords = task.title.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
    const matched = new Map<number, string>();

    for (const kw of keywords) {
      for (const lesson of searchLessons(kw, task.tenant_id)) {
        matched.set(lesson.id, lesson.lesson);
      }
    }

    if (matched.size === 0) return depContext;

    // Mark lessons as applied
    for (const id of matched.keys()) {
      incrementApplied(id);
    }

    const lessonsBlock = [...matched.values()].slice(0, 5).map(l => `- ${l}`).join('\n');
    return `${depContext}\n\nLessons from past attempts:\n${lessonsBlock}`;
  } catch {
    return depContext;
  }
}

/**
 * Build context string from completed dependency task results.
 * This allows downstream tasks to see what upstream tasks discovered.
 *
 * Resume support: dependencies completed in a PREVIOUS run are excluded from
 * the current execution scope (buildDependencyMap filters to in-scope tasks),
 * so their results are loaded from the persisted task workspace instead of
 * in-memory state. This is what lets a resumed DAG continue with full context.
 */
function buildDependencyContext(
  task: TaskRecord,
  dependencies: Map<string, string[]>,
  state: Map<string, ExecutionState>,
  taskById: Map<string, TaskRecord>,
): string {
  const parts: string[] = [];

  for (const depId of dependencies.get(task.id) || []) {
    const depState = state.get(depId);
    const depTask = taskById.get(depId);
    if (depState?.status === 'completed' && depState.result && depTask) {
      parts.push(`--- Result from "${depTask.title}" ---\n${depState.result}`);
    } else if (depState?.status === 'failed' && depTask) {
      parts.push(`--- "${depTask.title}" FAILED ---\n${depState.error || 'Unknown error'}`);
    }
  }

  // Out-of-scope deps (completed before this run) — recover persisted results.
  try {
    const inScope = new Set(dependencies.get(task.id) || []);
    const allDepIds = getDependencies(task.id, task.tenant_id);
    for (const depId of allDepIds) {
      if (inScope.has(depId)) continue;
      const persisted = loadTaskResult(depId);
      if (persisted?.output) {
        const depTitle = getById(depId, task.tenant_id)?.title ?? depId;
        parts.push(`--- Result from "${depTitle}" (previous run) ---\n${persisted.output}`);
      }
    }
  } catch {
    // Persisted-result recovery is best-effort; execution proceeds without it.
  }

  return parts.length > 0
    ? `\n\nContext from previous tasks:\n${parts.join('\n\n')}`
    : '';
}

/**
 * Attempt SubAgent dispatch; fall back to in-process execution on failure.
 */
async function executeViaSubAgentOrFallback(
  task: TaskRecord,
  systemPrompt: string,
  chatId: string,
  depContext: string,
  fallbackClient?: LLMClient,
  turnId?: string,
  startedAt?: number,
  taskAbortSignal?: AbortSignal,
  fallbackMetadata?: SubagentFallbackMetadata,
): Promise<TaskExecutionOutcome> {
  const t0 = startedAt ?? Date.now();

  try {
    throwIfTaskCancelled(taskAbortSignal, task.id);
    const subResult = await dispatchToSubAgent(
      task,
      systemPrompt,
      depContext || undefined,
      {
        abortSignal: taskAbortSignal,
        chatId,
        sessionId: fallbackMetadata?.sessionId,
        permissionLevel: fallbackMetadata?.toolContext?.permissionLevel,
        turnId,
        runtimeSource: fallbackMetadata?.runtimeSource,
        runtimeSessionKey: fallbackMetadata?.runtimeSessionKey,
      },
    );

    if (subResult.cancelled) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: subResult.output || 'Task cancelled',
        elapsedMs: Date.now() - t0,
      };
    }

    if (subResult.success) {
      // Write result to Blackboard for inter-task context sharing
      try {
        writeBlackboard(`task:${task.id}:result`, subResult.output, {
          scope: `dag:${chatId}`,
          written_by: `subagent:${task.id}`,
          ttl_seconds: 3600,
          tenant_id: task.tenant_id,
        });
      } catch (bbErr) {
        logger.warn({ taskId: task.id, err: bbErr instanceof Error ? bbErr.message : String(bbErr) },
          'Failed to write SubAgent result to Blackboard');
      }

      return {
        taskId: task.id,
        success: true,
        result: subResult.output,
        elapsedMs: Date.now() - t0,
      };
    }

    // SubAgent returned failure — fall back to in-process
    throwIfTaskCancelled(taskAbortSignal, task.id);
    const lowerOutput = subResult.output.toLowerCase();
    if (lowerOutput.includes('timeout') || lowerOutput.includes('timed out') || lowerOutput.includes('aborted')) {
      reportTimeoutAndMaybeTune({
        scope: 'subagent',
        tenantId: task.tenant_id,
        chatId,
        taskId: task.id,
        detail: subResult.output,
      });
    }
    recordSubagentFallbackForTask(task, chatId, 'subagent_dispatch_failed', {
      ...fallbackMetadata,
      detail: subResult.output.slice(0, 400),
    });
    logger.warn({ taskId: task.id, output: subResult.output }, 'SubAgent dispatch failed, falling back to in-process');
  } catch (err) {
    if (err instanceof TaskCancelledError || taskAbortSignal?.aborted) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: err instanceof Error ? err.message : 'Task cancelled',
        elapsedMs: Date.now() - t0,
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    const lowerDetail = detail.toLowerCase();
    if (lowerDetail.includes('timeout') || lowerDetail.includes('timed out') || lowerDetail.includes('aborted')) {
      reportTimeoutAndMaybeTune({
        scope: 'subagent',
        tenantId: task.tenant_id,
        chatId,
        taskId: task.id,
        detail,
      });
    }
    recordSubagentFallbackForTask(task, chatId, 'subagent_dispatch_exception', {
      ...fallbackMetadata,
      detail: detail.slice(0, 400),
    });
    logger.warn({
      taskId: task.id,
      err: detail,
    }, 'SubAgent dispatch threw, falling back to in-process');
  }

  // Fallback: in-process execution
  try {
    const fallbackToolContext = buildExecutionToolContext('subagent_fallback', {
      ...fallbackMetadata?.toolContext,
      chatId: task.id,
      taskId: task.id,
      tenantId: task.tenant_id,
      agentId: task.assigned_agent || task.id,
      permissionLevel: fallbackMetadata?.toolContext?.permissionLevel,
      systemPrompt,
    });
    const result = await executeSingleTask(
      task,
      systemPrompt,
      chatId,
      fallbackClient,
      depContext,
      turnId,
      taskAbortSignal,
      fallbackToolContext,
    );
    if (isInterruptedFallbackResult(result)) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: result,
        elapsedMs: Date.now() - t0,
      };
    }
    const timedOut = isTimeoutFallbackResult(result);
    return {
      taskId: task.id,
      success: !timedOut,
      result: timedOut ? undefined : result,
      error: timedOut ? 'Task timed out' : undefined,
      elapsedMs: Date.now() - t0,
      timedOut,
    };
  } catch (err) {
    if (err instanceof TaskCancelledError || taskAbortSignal?.aborted) {
      return {
        taskId: task.id,
        success: false,
        cancelled: true,
        error: err instanceof Error ? err.message : 'Task cancelled',
        elapsedMs: Date.now() - t0,
      };
    }
    return {
      taskId: task.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - t0,
      retryable: isRetryableTaskError(err),
      retryAfterMs: retryAfterMs(err),
    };
  }
}
