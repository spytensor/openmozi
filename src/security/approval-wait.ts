export type ApprovalWaitDecision = 'approved' | 'rejected';
export type ApprovalWaitResult = ApprovalWaitDecision | 'timeout';

export const DEFAULT_APPROVAL_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

interface Waiter {
  finish: (decision: ApprovalWaitResult) => void;
}

const pendingApprovalWaits = new Map<string, { waiters: Set<Waiter> }>();

export interface ApprovalWaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function getOrCreateEntry(requestId: string): { waiters: Set<Waiter> } {
  const existing = pendingApprovalWaits.get(requestId);
  if (existing) return existing;
  const entry = { waiters: new Set<Waiter>() };
  pendingApprovalWaits.set(requestId, entry);
  return entry;
}

export async function waitForApprovalDecision(
  requestId: string,
  options: ApprovalWaitOptions = {},
): Promise<ApprovalWaitResult> {
  let cleanup: (() => void) | undefined;
  const promise = new Promise<ApprovalWaitResult>((resolve) => {
    const signal = options.signal;
    const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_APPROVAL_WAIT_TIMEOUT_MS);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = {
      finish: (decision) => {
        if (settled) return;
        settled = true;
        cleanup?.();
        resolve(decision);
      },
    };
    const onAbort = (): void => waiter.finish('timeout');
    cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      const entry = pendingApprovalWaits.get(requestId);
      entry?.waiters.delete(waiter);
      if (entry && entry.waiters.size === 0) {
        pendingApprovalWaits.delete(requestId);
      }
    };

    getOrCreateEntry(requestId).waiters.add(waiter);
    timeout = setTimeout(() => waiter.finish('timeout'), timeoutMs);

    if (signal?.aborted) {
      waiter.finish('timeout');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await promise;
  } finally {
    cleanup?.();
  }
}

export function settleApprovalDecision(requestId: string, decision: ApprovalWaitDecision): boolean {
  const entry = pendingApprovalWaits.get(requestId);
  if (!entry || entry.waiters.size === 0) return false;
  for (const waiter of [...entry.waiters]) {
    waiter.finish(decision);
  }
  return true;
}
