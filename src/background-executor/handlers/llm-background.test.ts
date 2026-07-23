import { describe, expect, it, vi } from 'vitest';
import type { BackgroundTask } from '../../core/background-tasks.js';

const chat = vi.fn(async () => ({
  content: 'background result',
  usage: { input_tokens: 1, output_tokens: 1 },
  model: 'test',
  stop_reason: 'end_turn',
}));

vi.mock('../../core/model-router.js', () => ({
  getBrainClient: () => ({ client: { chat } }),
}));

import { llmBackgroundHandler } from './llm-background.js';

describe('llmBackgroundHandler', () => {
  it('normalizes the numeric database task id for LLM billing context', async () => {
    const task: BackgroundTask = {
      id: 42,
      tenant_id: 'tenant-background',
      chat_id: 'chat-background',
      objective: 'Summarize the report',
      status: 'running',
      result: null,
      handler_type: 'llm_background',
      handler_params: null,
      running_since: null,
      last_error: null,
      retry_count: 0,
      retry_after: null,
      max_retries: 3,
      timeout_ms: 30_000,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    const controller = new AbortController();

    await expect(llmBackgroundHandler(task, controller.signal)).resolves.toBe('background result');
    expect(chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Summarize the report' }],
      expect.objectContaining({
        execution_scope: 'worker',
        billing: { tenantId: 'tenant-background', taskId: '42', agentId: undefined },
        abort_signal: controller.signal,
      }),
    );
  });
});
