/**
 * Hard timeout enforcement on tool executions (#243)
 *
 * Wraps any async operation with a configurable timeout.
 * Provides a typed error and per-tool-type default timeouts.
 */

import { kill } from 'node:process';
import pino from 'pino';

const logger = pino({ name: 'mozi:sandbox:timeout' });

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`Operation "${label}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Default timeouts by tool type
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUTS: Record<string, number> = {
  shell: 30_000,          // 30s for shell commands
  network: 60_000,        // 60s for HTTP/network tools
  long_running: 300_000,  // 5 min for background tasks
  default: 30_000,
};

/**
 * Get the default timeout in ms for a given tool type.
 */
export function getDefaultTimeout(toolType: keyof typeof DEFAULT_TIMEOUTS | string): number {
  return DEFAULT_TIMEOUTS[toolType] ?? DEFAULT_TIMEOUTS.default;
}

// ---------------------------------------------------------------------------
// Core wrapper
// ---------------------------------------------------------------------------

/**
 * Run `fn` and reject with TimeoutError if it doesn't resolve within `timeoutMs`.
 * Logs a warning on timeout.
 *
 * @param fn - Async operation to run
 * @param timeoutMs - Deadline in milliseconds
 * @param label - Human-readable label for logging and error messages
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      logger.warn({ label, timeoutMs }, 'operation timed out');
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (err) {
    clearTimeout(timer!);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Process kill helper
// ---------------------------------------------------------------------------

/**
 * Force-kill a process by PID.
 * Sends SIGKILL. Swallows ESRCH (process already gone).
 */
export function killProcess(pid: number): void {
  try {
    kill(pid, 'SIGKILL');
    logger.debug({ pid }, 'process killed');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      // Re-throw unexpected errors
      throw err;
    }
    // Process already exited — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Shell execution helper (integrates with capabilities/shell.ts)
// ---------------------------------------------------------------------------

/**
 * Wrap a shell execution function with a timeout scoped to the 'shell' tool type.
 * Usage:
 *   const result = await withShellTimeout(() => execShell(cmd, opts));
 */
export async function withShellTimeout<T>(
  fn: () => Promise<T>,
  label = 'shell',
  overrideMs?: number,
): Promise<T> {
  return withTimeout(fn, overrideMs ?? DEFAULT_TIMEOUTS.shell, label);
}

/**
 * Wrap a network operation with a timeout scoped to the 'network' tool type.
 */
export async function withNetworkTimeout<T>(
  fn: () => Promise<T>,
  label = 'network',
  overrideMs?: number,
): Promise<T> {
  return withTimeout(fn, overrideMs ?? DEFAULT_TIMEOUTS.network, label);
}
