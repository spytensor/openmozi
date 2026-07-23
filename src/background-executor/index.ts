/**
 * Background Executor — Entry point.
 *
 * Registers built-in handlers and exports the runner.
 */

export { BackgroundJobRunner } from './runner.js';
export { registerHandler, resolveHandler, listHandlerTypes, clearHandlers } from './registry.js';
export type { TaskHandler } from './registry.js';

import { registerHandler } from './registry.js';
import { shellBackgroundHandler } from './handlers/shell-background.js';
import { llmBackgroundHandler } from './handlers/llm-background.js';
import { pollUrlHandler } from './handlers/poll-url.js';
import { dailySummaryHandler } from './handlers/daily-summary.js';
import { notifyHandler } from './handlers/notify.js';
import { managedBrainHandler } from './handlers/managed-brain.js';

/**
 * Register all built-in handlers. Call once at startup.
 */
export function registerBuiltinHandlers(): void {
  registerHandler('notify', notifyHandler);
  registerHandler('managed_brain', managedBrainHandler);
  registerHandler('shell_background', shellBackgroundHandler);
  registerHandler('llm_background', llmBackgroundHandler);
  registerHandler('poll_url', pollUrlHandler);
  registerHandler('daily_summary', dailySummaryHandler);
}
