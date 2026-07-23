/**
 * LLM Background Handler — Run LLM tasks in background.
 *
 * handler_params: { prompt: string, system?: string, max_tokens?: number }
 */

import type { BackgroundTask } from '../../core/background-tasks.js';
import { getBrainClient } from '../../core/model-router.js';
import { defaultChatOptionsForSurface } from '../../core/llm-surface.js';

export async function llmBackgroundHandler(task: BackgroundTask, signal: AbortSignal): Promise<string> {
  const params = task.handler_params ? JSON.parse(task.handler_params) : {};
  const prompt = params.prompt ?? task.objective;
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('llm_background handler requires "prompt" parameter or task objective');
  }

  if (signal.aborted) throw new Error('Task aborted');

  const { client } = getBrainClient();
  const messages = [
    ...(params.system ? [{ role: 'system' as const, content: params.system }] : []),
    { role: 'user' as const, content: prompt },
  ];

  const tenantId = task.tenant_id;
  const response = await client.chat(messages, {
    ...defaultChatOptionsForSurface('background_job', {
      tenantId,
      taskId: String(task.id),
      abort_signal: signal,
    }),
    max_tokens: params.max_tokens ?? 4096,
    temperature: params.temperature ?? 0.7,
  });

  return response.content;
}
