import type {
  ManagedWorkerTaskInput,
  ManagedWorkerTaskResult,
  WorkerAdapterRegistry,
} from './adapter.js';
import {
  buildManagedWorkerFailureEnvelope,
  isTerminalWorkerState,
  WorkerLaunchRequestSchema,
} from './adapter.js';
import { getDefaultWorkerAdapterRegistry } from './index.js';
import {
  buildExternalWorkerResultEnvelope,
  createSynchronousVerifyReport,
  createExternalWorkerJob,
  createPendingVerifyReport,
  deriveFailureCategory,
  persistExternalWorkerJob,
  transitionExternalWorkerJob,
} from './job-state.js';
import {
  inspectManagedWorkerPreflight,
  reportManagedWorkerFailure,
  reportManagedWorkerSuccess,
} from './preflight.js';
import { emit as emitProgress } from '../progress/event-bus.js';

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_WORKER_HEARTBEAT_MS = 30_000;
/** Default multiplier for wall clock ceiling relative to inactivity timeout */
const DEFAULT_WALL_CLOCK_MULTIPLIER = 10;
/** Absolute maximum wall clock time (2 hours) as safety net */
const ABSOLUTE_MAX_WALL_CLOCK_MS = 7_200_000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAbortReason(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return 'Managed worker cancelled by abort signal';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveHeartbeatIntervalMs(metadata: Record<string, unknown> | undefined): number {
  const raw = metadata?.progress_heartbeat_interval_ms;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_WORKER_HEARTBEAT_MS;
  return Math.max(1000, Math.floor(numeric));
}

/**
 * Resolve the wall clock ceiling from metadata or derive it from the inactivity timeout.
 * `max_wall_clock_ms` can be set explicitly; otherwise it's inactivity_timeout * multiplier,
 * capped at ABSOLUTE_MAX_WALL_CLOCK_MS.
 */
function resolveWallClockCeilingMs(inactivityTimeoutMs: number, metadata: Record<string, unknown> | undefined): number {
  const raw = metadata?.max_wall_clock_ms;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(Math.floor(numeric), ABSOLUTE_MAX_WALL_CLOCK_MS);
  }
  return Math.min(inactivityTimeoutMs * DEFAULT_WALL_CLOCK_MULTIPLIER, ABSOLUTE_MAX_WALL_CLOCK_MS);
}

function elapsedSince(startedAt: string | null): number | undefined {
  if (!startedAt) return undefined;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return undefined;
  return Math.max(0, Date.now() - startedMs);
}

function emitManagedWorkerStatus(
  input: ManagedWorkerTaskInput,
  job: ReturnType<typeof createExternalWorkerJob>,
  workerStatus: string,
  options: {
    heartbeat?: boolean;
    summary?: string;
  } = {},
): void {
  const metadata = input.metadata ?? {};
  const chatId = asNonEmptyString(metadata.chat_id);
  const sessionId = asNonEmptyString(metadata.session_id);
  const turnId = asNonEmptyString(metadata.turn_id);
  const parentTaskId = asNonEmptyString(metadata.parent_task_id);
  if (!chatId && !turnId) return;

  emitProgress({
    type: 'worker_status',
    chatId,
    tenantId: input.tenant_id,
    turnId,
    taskId: input.task.task_id,
    parentTaskId,
    jobId: job.id,
    adapterId: job.adapter_id,
    runtimeLabel: job.runtime_label ?? input.worker.model ?? job.adapter_id,
    workerStatus,
    lane: asNonEmptyString(job.metadata.worker_lane),
    sandboxProfile: asNonEmptyString(job.metadata.worker_sandbox_profile),
    summary: options.summary,
    heartbeat: options.heartbeat,
    elapsed_ms: elapsedSince(job.started_at),
    sessionId,
  });
}

export async function dispatchManagedWorkerTask(
  input: ManagedWorkerTaskInput,
  registry: WorkerAdapterRegistry = getDefaultWorkerAdapterRegistry(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): Promise<ManagedWorkerTaskResult> {
  let job = createExternalWorkerJob(input);
  persistExternalWorkerJob(job);
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs(input.metadata ?? {});

  const adapter = registry.get(input.worker.adapter);
  if (!adapter) {
    const message = `Unknown worker adapter: ${input.worker.adapter}`;
    job = transitionExternalWorkerJob(job, 'failed', {
      failure_category: deriveFailureCategory({ status: 'failed', launchFailed: true }),
      last_error: message,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'failed', { summary: message });
    throw new Error(message);
  }
  if (!adapter.supportsTransport(input.worker.transport)) {
    const message = `Worker adapter ${adapter.metadata.id} does not support transport: ${input.worker.transport}`;
    job = transitionExternalWorkerJob(job, 'failed', {
      failure_category: deriveFailureCategory({ status: 'failed', launchFailed: true }),
      last_error: message,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'failed', { summary: message });
    throw new Error(message);
  }

  const launchRequest = WorkerLaunchRequestSchema.parse({
    job_id: input.job_id,
    tenant_id: input.tenant_id,
    task: input.task,
    system_prompt: input.system_prompt,
    timeout_ms: input.timeout_ms,
    transport: input.worker.transport,
    adapter_config: input.worker,
    metadata: input.metadata ?? {},
  });

  const preflight = await inspectManagedWorkerPreflight(input, adapter);
  job = transitionExternalWorkerJob(job, 'queued', {
    metadata: {
      worker_lane: preflight.lane,
      worker_sandbox_profile: preflight.sandbox_profile,
      worker_preflight: preflight,
    },
  });
  persistExternalWorkerJob(job);
  emitManagedWorkerStatus(input, job, 'queued');
  if (preflight.status === 'blocked') {
    const message = `Managed worker preflight failed: ${preflight.summary}`;
    reportManagedWorkerFailure(adapter.metadata.id);
    job = transitionExternalWorkerJob(job, 'failed', {
      failure_category: deriveFailureCategory({ status: 'failed', launchFailed: true }),
      last_error: message,
      metadata: {
        worker_preflight: preflight,
      },
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'failed', { summary: message });
    throw new Error(message);
  }

  job = transitionExternalWorkerJob(job, 'launching');
  persistExternalWorkerJob(job);
  emitManagedWorkerStatus(input, job, 'launching');

  let launch;
  try {
    launch = await adapter.launch(launchRequest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportManagedWorkerFailure(adapter.metadata.id);
    job = transitionExternalWorkerJob(job, 'failed', {
      failure_category: deriveFailureCategory({ status: 'failed', launchFailed: true }),
      last_error: message,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'failed', { summary: message });
    throw err;
  }

  job = transitionExternalWorkerJob(job, 'running', {
    active_run_id: launch.handle.id,
    runtime_label: input.worker.model ?? adapter.metadata.display_name,
  });
  persistExternalWorkerJob(job);
  emitManagedWorkerStatus(input, job, 'running');

  let status = launch.status;
  const metadata = input.metadata ?? {};
  const inactivityTimeoutMs = input.timeout_ms > 0 ? input.timeout_ms : 0;
  const wallClockCeilingMs = inactivityTimeoutMs > 0
    ? resolveWallClockCeilingMs(inactivityTimeoutMs, metadata)
    : 0;
  const wallClockDeadline = wallClockCeilingMs > 0 ? Date.now() + wallClockCeilingMs : null;
  let lastActivityAt = Date.now();
  let lastHeartbeatAt = Date.now();
  let abortReason = '';
  const abortHandler = async () => {
    abortReason = formatAbortReason(input.abort_signal?.reason);
    await adapter.cancel(launch.handle, abortReason).catch(() => undefined);
  };
  const onAbort = () => {
    void abortHandler();
  };

  if (input.abort_signal) {
    if (input.abort_signal.aborted) {
      await abortHandler();
    } else {
      input.abort_signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (!isTerminalWorkerState(status.state)) {
      const now = Date.now();
      const idleMs = now - lastActivityAt;
      const isInactivityTimeout = inactivityTimeoutMs > 0 && idleMs >= inactivityTimeoutMs;
      const isWallClockTimeout = wallClockDeadline !== null && now >= wallClockDeadline;

      if (isInactivityTimeout || isWallClockTimeout) {
        const elapsedTotal = now - launch.handle.started_at;
        const reason = isInactivityTimeout
          ? `Managed worker inactive for ${idleMs}ms (inactivity timeout: ${inactivityTimeoutMs}ms)`
          : `Managed worker exceeded wall clock ceiling of ${wallClockCeilingMs}ms (elapsed: ${elapsedTotal}ms)`;
        const timeoutFailureCategory = deriveFailureCategory({ status: 'timed_out' });
        await adapter.cancel(launch.handle, reason);
        const result = await adapter.collectResult(launch.handle).catch(() => null);
        const envelope = result?.envelope ?? buildManagedWorkerFailureEnvelope(
          input.task.task_id,
          reason,
          elapsedTotal,
        );
        const runtimeLabel = result?.runtime_label || adapter.metadata.display_name;
        const persistedResult = buildExternalWorkerResultEnvelope({
          job,
          result: envelope,
          artifacts: result?.artifacts ?? [],
          runtime_label: runtimeLabel,
          stdout: result?.stdout,
          stderr: result?.stderr,
          failure_category: timeoutFailureCategory,
        });
        job = transitionExternalWorkerJob(job, 'timed_out', {
          failure_category: timeoutFailureCategory,
          last_error: reason,
          result_envelope: persistedResult,
          runtime_label: runtimeLabel,
        });
        persistExternalWorkerJob(job);
        reportManagedWorkerFailure(adapter.metadata.id);
        emitManagedWorkerStatus(input, job, 'timed_out', { summary: reason });

        return {
          job_id: job.id,
          envelope,
          run_id: launch.handle.id,
          runtime_label: runtimeLabel,
          adapter_id: adapter.metadata.id,
          verify_status: 'not_required',
          verify_summary: '',
          artifacts: result?.artifacts ?? [],
        };
      }

      if (typeof adapter.waitForCompletion === 'function') {
        const waitMs = inactivityTimeoutMs > 0
          ? Math.max(1, Math.min(heartbeatIntervalMs, inactivityTimeoutMs - idleMs))
          : heartbeatIntervalMs;
        const prevState = status.state;
        status = await adapter.waitForCompletion(launch.handle, waitMs);
        if (status.state !== prevState) {
          lastActivityAt = Date.now();
        }
      } else {
        await sleep(pollIntervalMs);
        const prevState = status.state;
        status = await adapter.poll(launch.handle);
        if (status.state !== prevState) {
          lastActivityAt = Date.now();
        }
      }

      if (!isTerminalWorkerState(status.state) && Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
        emitManagedWorkerStatus(input, job, 'running', { heartbeat: true });
        lastHeartbeatAt = Date.now();
        // Heartbeat emission counts as activity — the worker is still alive
        lastActivityAt = Date.now();
      }
    }
  } finally {
    if (input.abort_signal) {
      input.abort_signal.removeEventListener('abort', onAbort);
    }
  }

  let result;
  try {
    result = await adapter.collectResult(launch.handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportManagedWorkerFailure(adapter.metadata.id);
    job = transitionExternalWorkerJob(job, 'failed', {
      failure_category: deriveFailureCategory({ status: 'failed', resultMissing: true }),
      last_error: message,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'failed', { summary: message });
    throw err;
  }

  const resultFailureCategory =
    result.envelope.status === 'failed'
      ? deriveFailureCategory({ status: 'failed' })
      : null;

  const persistedResult = buildExternalWorkerResultEnvelope({
    job,
    result: result.envelope,
    artifacts: result.artifacts,
    runtime_label: result.runtime_label || adapter.metadata.display_name,
    stdout: result.stdout,
    stderr: result.stderr,
    failure_category: resultFailureCategory,
  });

  if (result.envelope.status === 'cancelled') {
    job = transitionExternalWorkerJob(job, 'cancelled', {
      last_error: result.envelope.summary || abortReason || null,
      result_envelope: persistedResult,
      runtime_label: result.runtime_label || adapter.metadata.display_name,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'cancelled', {
      summary: result.envelope.summary || abortReason || 'Managed worker cancelled.',
    });
  } else if (result.envelope.status === 'failed') {
    reportManagedWorkerFailure(adapter.metadata.id);
    job = transitionExternalWorkerJob(job, 'failed', {
      failure_category: resultFailureCategory,
      last_error: result.envelope.summary || null,
      result_envelope: persistedResult,
      runtime_label: result.runtime_label || adapter.metadata.display_name,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, 'failed', {
      summary: result.envelope.summary || 'Managed worker failed.',
    });
  } else {
    reportManagedWorkerSuccess(adapter.metadata.id, result.envelope.cost.elapsed_time);
    job = transitionExternalWorkerJob(job, 'completed_pending_verify', {
      result_envelope: persistedResult,
      verify_report: createPendingVerifyReport(job),
      runtime_label: result.runtime_label || adapter.metadata.display_name,
    });
    persistExternalWorkerJob(job);

    const finalVerifyReport = createSynchronousVerifyReport(job);
    const finalStatus = finalVerifyReport.status === 'passed' ? 'succeeded' : 'failed';
    job = transitionExternalWorkerJob(job, finalStatus, {
      verify_report: finalVerifyReport,
      failure_category: finalVerifyReport.status === 'failed'
        ? deriveFailureCategory({ status: 'failed', verifyFailed: true })
        : null,
      last_error: finalVerifyReport.status === 'failed' ? finalVerifyReport.summary : null,
    });
    persistExternalWorkerJob(job);
    emitManagedWorkerStatus(input, job, finalStatus, {
      summary: finalVerifyReport.summary,
    });
  }

  return {
    job_id: job.id,
    envelope: result.envelope,
    run_id: launch.handle.id,
    runtime_label: result.runtime_label || adapter.metadata.display_name,
    adapter_id: adapter.metadata.id,
    verify_status: job.verify_report?.status === 'passed'
      ? 'passed'
      : job.verify_report?.status === 'failed'
        ? 'failed'
        : 'not_required',
    verify_summary: job.verify_report?.summary ?? '',
    artifacts: result.artifacts,
  };
}
