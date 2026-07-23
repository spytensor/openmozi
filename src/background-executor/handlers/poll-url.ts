/**
 * URL Polling Handler — Poll a URL until condition is met.
 *
 * handler_params: {
 *   url: string,
 *   method?: 'GET' | 'HEAD',
 *   headers?: Record<string, string>,
 *   expected_status?: number,
 *   match_body?: string,  // regex pattern to match in response body
 *   poll_interval_ms?: number,  // default 30000
 *   max_polls?: number,  // default 200
 * }
 */

import type { BackgroundTask } from '../../core/background-tasks.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:bg-poll-url' });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

export async function pollUrlHandler(task: BackgroundTask, signal: AbortSignal): Promise<string> {
  const params = task.handler_params ? JSON.parse(task.handler_params) : {};
  const url = params.url;
  if (!url || typeof url !== 'string') {
    throw new Error('poll_url handler requires "url" parameter');
  }

  const method = (params.method ?? 'GET').toUpperCase();
  const headers = params.headers ?? {};
  const expectedStatus = params.expected_status ?? 200;
  const matchBody = params.match_body ? new RegExp(params.match_body, 'i') : null;
  const pollIntervalMs = Math.max(5_000, Math.min(params.poll_interval_ms ?? 30_000, 600_000)); // 5s-10min
  const maxPolls = Math.max(1, Math.min(params.max_polls ?? 200, 1000)); // 1-1000

  for (let i = 0; i < maxPolls; i++) {
    if (signal.aborted) throw new Error('Task aborted');

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(15_000), // 15s per request
      });

      const body = await response.text();
      const statusMatch = response.status === expectedStatus;
      const bodyMatch = matchBody ? matchBody.test(body) : true;

      if (statusMatch && bodyMatch) {
        logger.info({ taskId: task.id, url, polls: i + 1, status: response.status }, 'URL condition met');
        return `Condition met after ${i + 1} polls.\nStatus: ${response.status}\nBody preview: ${body.slice(0, 500)}`;
      }

      logger.debug({ taskId: task.id, url, poll: i + 1, status: response.status }, 'Condition not met, waiting');
    } catch (err) {
      if (signal.aborted) throw new Error('Task aborted');
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId: task.id, url, poll: i + 1, err: errMsg }, 'Poll request failed');
      // Continue polling despite errors
    }

    // Wait before next poll
    await sleep(pollIntervalMs, signal);
  }

  throw new Error(`URL condition not met after ${maxPolls} polls (${Math.round(maxPolls * pollIntervalMs / 60000)} minutes)`);
}
