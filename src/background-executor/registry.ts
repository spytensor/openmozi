/**
 * Handler Registry — maps background task handler_type to execution functions.
 *
 * Handlers are registered at startup. When BackgroundJobRunner picks up a
 * pending task, it resolves the handler by type and executes it.
 */

import pino from 'pino';
import type { BackgroundTask } from '../core/background-tasks.js';

const logger = pino({ name: 'mozi:bg-registry' });

/**
 * A background task handler function.
 * @param task - The task to execute
 * @param signal - AbortSignal for timeout/cancellation
 * @returns Result string to store in task.result
 */
export type TaskHandler = (task: BackgroundTask, signal: AbortSignal) => Promise<string>;

/** A handler reached an authoritative terminal failure; retrying cannot repair it. */
export class PermanentBackgroundTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentBackgroundTaskError';
  }
}

const handlers = new Map<string, TaskHandler>();

/**
 * Register a handler for a given type.
 */
export function registerHandler(type: string, handler: TaskHandler): void {
  if (handlers.has(type)) {
    logger.warn({ type }, 'Overwriting existing handler');
  }
  handlers.set(type, handler);
  logger.info({ type }, 'Handler registered');
}

/**
 * Resolve a handler by type. Returns null if no handler is registered.
 */
export function resolveHandler(type: string | null): TaskHandler | null {
  if (!type) return null;
  return handlers.get(type) ?? null;
}

/**
 * List all registered handler types.
 */
export function listHandlerTypes(): string[] {
  return Array.from(handlers.keys());
}

/**
 * Clear all handlers (for testing).
 */
export function clearHandlers(): void {
  handlers.clear();
}
