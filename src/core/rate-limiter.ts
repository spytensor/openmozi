interface ProviderLimits {
  rpm: number;
  tpm: number;
  concurrent: number;
}

interface ProviderState {
  limits: ProviderLimits;
  requestsThisMinute: number;
  tokensThisMinute: number;
  concurrent: number;
  minuteStartMs: number;
  waitQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    priority: number;
    estimatedTokens: number;
    signal?: AbortSignal;
    onAbort?: () => void;
    interval?: ReturnType<typeof setInterval>;
    settled: boolean;
  }>;
}

const providers = new Map<string, ProviderState>();

/** Configure rate limits for a provider */
export function configure(provider: string, limits: ProviderLimits): void {
  const existing = providers.get(provider);
  providers.set(provider, {
    limits,
    requestsThisMinute: existing?.requestsThisMinute ?? 0,
    tokensThisMinute: existing?.tokensThisMinute ?? 0,
    concurrent: existing?.concurrent ?? 0,
    minuteStartMs: existing?.minuteStartMs ?? Date.now(),
    waitQueue: existing?.waitQueue ?? [],
  });
}

function abortError(signal: AbortSignal): Error {
  const message = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string' && signal.reason.trim()
      ? signal.reason
      : 'Provider admission cancelled';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Acquire a rate limit permit. Waits if over limit. Lower priority number = higher priority. */
export async function acquire(
  provider: string,
  estimatedTokens: number,
  priority = 1,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  let state = providers.get(provider);
  if (!state) return; // No limits configured, allow through

  resetMinuteIfNeeded(state);

  // Check if we can proceed immediately
  if (canProceed(state, estimatedTokens)) {
    state.requestsThisMinute++;
    state.tokensThisMinute += estimatedTokens;
    state.concurrent++;
    return;
  }

  // Wait in queue
  return new Promise<void>((resolve, reject) => {
    const queued = {
      resolve: () => {
        if (queued.settled) return;
        queued.settled = true;
        if (queued.interval) clearInterval(queued.interval);
        if (queued.signal && queued.onAbort) queued.signal.removeEventListener('abort', queued.onAbort);
        resolve();
      },
      reject: (error: Error) => {
        if (queued.settled) return;
        queued.settled = true;
        if (queued.interval) clearInterval(queued.interval);
        if (queued.signal && queued.onAbort) queued.signal.removeEventListener('abort', queued.onAbort);
        reject(error);
      },
      priority,
      estimatedTokens,
      signal,
      onAbort: undefined as (() => void) | undefined,
      interval: undefined as ReturnType<typeof setInterval> | undefined,
      settled: false,
    };
    queued.onAbort = () => {
      const current = providers.get(provider);
      const index = current?.waitQueue.indexOf(queued) ?? -1;
      if (index >= 0) current!.waitQueue.splice(index, 1);
      queued.reject(abortError(signal!));
    };
    state!.waitQueue.push(queued);
    // Sort by priority (lower = higher priority)
    state!.waitQueue.sort((a, b) => a.priority - b.priority);
    signal?.addEventListener('abort', queued.onAbort, { once: true });

    // Set up periodic check
    queued.interval = setInterval(() => {
      state = providers.get(provider);
      if (!state) {
        queued.resolve();
        return;
      }
      resetMinuteIfNeeded(state);
      processQueue(state);
    }, 100);
    queued.interval.unref?.();

    // Close the small race between the pre-check and listener registration.
    if (signal?.aborted) queued.onAbort();
  });
}

/** Release a concurrent slot after request completes */
export function release(provider: string): void {
  const state = providers.get(provider);
  if (!state) return;
  state.concurrent = Math.max(0, state.concurrent - 1);
  processQueue(state);
}

/** Get current state for a provider (for monitoring) */
export function getState(provider: string): { requestsThisMinute: number; tokensThisMinute: number; concurrent: number; queueLength: number } | null {
  const state = providers.get(provider);
  if (!state) return null;
  return {
    requestsThisMinute: state.requestsThisMinute,
    tokensThisMinute: state.tokensThisMinute,
    concurrent: state.concurrent,
    queueLength: state.waitQueue.length,
  };
}

function canProceed(state: ProviderState, estimatedTokens: number): boolean {
  return (
    state.requestsThisMinute < state.limits.rpm &&
    state.tokensThisMinute + estimatedTokens <= state.limits.tpm &&
    state.concurrent < state.limits.concurrent
  );
}

function resetMinuteIfNeeded(state: ProviderState): void {
  const now = Date.now();
  if (now - state.minuteStartMs >= 60_000) {
    state.requestsThisMinute = 0;
    state.tokensThisMinute = 0;
    state.minuteStartMs = now;
  }
}

function processQueue(state: ProviderState): void {
  while (state.waitQueue.length > 0) {
    const next = state.waitQueue[0];
    if (canProceed(state, next.estimatedTokens)) {
      state.waitQueue.shift();
      state.requestsThisMinute++;
      state.tokensThisMinute += next.estimatedTokens;
      state.concurrent++;
      next.resolve();
    } else {
      break;
    }
  }
}
