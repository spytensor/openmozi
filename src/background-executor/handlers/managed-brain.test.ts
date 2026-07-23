import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTask } from '../../core/background-tasks.js';
import { PermanentBackgroundTaskError } from '../registry.js';

const hoisted = vi.hoisted(() => ({
  handleMessage: vi.fn(),
  mergeParams: vi.fn(),
  waitForPlanRun: vi.fn(),
  isPlanRunActive: vi.fn(() => true),
  restartPlanFromMetadata: vi.fn(),
  getById: vi.fn(),
  openCronRunSession: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
}));

vi.mock('../../config/index.js', () => ({ getConfig: () => ({}) }));
vi.mock('../../core/model-router.js', () => ({
  getBrainClient: () => ({ client: { chat: vi.fn() } }),
}));
vi.mock('../../system-prompt.js', () => ({
  loadSystemPrompt: () => 'system prompt',
  loadDelegationSystemPrompt: () => 'delegation prompt',
  adaptPromptForChannel: (prompt: string) => prompt,
}));
vi.mock('../../gateway/handler.js', () => ({ handleMessage: hoisted.handleMessage }));
vi.mock('../../core/background-tasks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/background-tasks.js')>();
  return { ...actual, mergeBackgroundTaskHandlerParams: hoisted.mergeParams };
});
vi.mock('../../core/plan-runner.js', () => ({
  waitForPlanRun: hoisted.waitForPlanRun,
  isPlanRunActive: hoisted.isPlanRunActive,
  restartPlanFromMetadata: hoisted.restartPlanFromMetadata,
}));
vi.mock('../../store/task-dag.js', () => ({ getById: hoisted.getById }));
vi.mock('../../memory/turn-envelopes.js', () => ({ getTurnEnvelope: () => null }));
vi.mock('../../scheduler/cron-tasks.js', () => ({ openCronRunSession: hoisted.openCronRunSession }));
vi.mock('../../channels/websocket.js', () => ({
  broadcastSessionListChanged: hoisted.broadcastSessionListChanged,
  broadcastArtifactEvent: vi.fn(),
}));

import { managedBrainHandler } from './managed-brain.js';

function task(params: Record<string, unknown>): BackgroundTask {
  return {
    id: 42,
    tenant_id: 'default',
    chat_id: 'local-user:sess-scheduled',
    user_id: 'local-user',
    session_id: 'sess-scheduled',
    channel_type: 'websocket',
    permission_level: 'L2_WRITE',
    source_cron_task_id: 'cron_test',
    cron_run_id: 'cronrun_test',
    objective: 'Scheduled market report',
    status: 'running',
    result: null,
    handler_type: 'managed_brain',
    handler_params: JSON.stringify(params),
    running_since: '2026-07-20 10:00:00',
    last_error: null,
    retry_count: 0,
    retry_after: null,
    max_retries: 3,
    timeout_ms: 60_000,
    delivery_status: 'none',
    delivery_attempts: 0,
    delivery_after: null,
    delivery_error: null,
    created_at: '2026-07-20 09:59:00',
    completed_at: null,
  };
}

describe('managed Brain scheduled handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.isPlanRunActive.mockReturnValue(true);
    hoisted.getById.mockReturnValue({ id: 'plan-root', status: 'running' });
    hoisted.waitForPlanRun.mockResolvedValue({ rootTaskId: 'plan-root', success: true, content: 'Durable report ready.' });
    hoisted.openCronRunSession.mockReturnValue({
      sessionId: 'sess-run', userId: 'local-user', channelType: 'websocket',
      chatId: 'local-user:sess-scheduled', permissionLevel: 'L2_WRITE',
    });
  });

  it('runs with scheduler origin and caller-owned delivery', async () => {
    hoisted.handleMessage.mockResolvedValue('Inline scheduled result.');
    const scheduled = task({ prompt: 'Generate today\'s verified market report.' });

    const result = await managedBrainHandler(scheduled, new AbortController().signal);

    expect(result).toBe('Inline scheduled result.');
    expect(hoisted.handleMessage).toHaveBeenCalledTimes(1);
    const [message, , , , , , , options] = hoisted.handleMessage.mock.calls[0];
    expect(message).toMatchObject({
      channelType: 'websocket',
      chatId: 'local-user:sess-scheduled',
      userId: 'local-user',
      sessionId: 'sess-run',
      suppressUserMessagePersistence: true,
    });
    expect(options).toMatchObject({
      origin: 'scheduler',
      permissionLevel: 'L2_WRITE',
      originalRequest: 'Generate today\'s verified market report.',
      planDeliveryMode: 'caller',
      suppressAssistantMessagePersistence: true,
    });
    await vi.waitFor(() => expect(hoisted.broadcastSessionListChanged).toHaveBeenCalledWith({
      targetUserId: 'local-user', tenantId: 'default', sessionId: 'sess-run',
    }));
  });

  it('persists a detached plan id and waits for its completion before returning', async () => {
    hoisted.handleMessage.mockImplementation(async (...args: unknown[]) => {
      const options = args[7] as { onDetachedPlanStarted?: (id: string) => void };
      options.onDetachedPlanStarted?.('plan-root');
      return 'Plan started.';
    });
    const scheduled = task({ prompt: 'Generate a complex verified dashboard.' });

    const result = await managedBrainHandler(scheduled, new AbortController().signal);

    expect(hoisted.mergeParams).toHaveBeenCalledWith(42, { managed_plan_root_id: 'plan-root' });
    expect(hoisted.waitForPlanRun).toHaveBeenCalledWith('plan-root', 'default', expect.any(AbortSignal));
    expect(result).toBe('Durable report ready.');
  });

  it('rejects a scheduled row without durable run identity', async () => {
    const scheduled = task({ prompt: 'Do work.' });
    scheduled.cron_run_id = null;
    await expect(managedBrainHandler(scheduled, new AbortController().signal))
      .rejects.toThrow('requires persisted cron run identity');
    expect(hoisted.handleMessage).not.toHaveBeenCalled();
  });

  it('leaves a transient-only plan failure retryable for the outer runner', async () => {
    hoisted.waitForPlanRun.mockResolvedValue({
      rootTaskId: 'plan-root',
      success: false,
      content: 'Provider retries exhausted.',
      retryableFailure: true,
    });

    const failure = managedBrainHandler(
      task({ prompt: 'Generate report.', managed_plan_root_id: 'plan-root' }),
      new AbortController().signal,
    ).catch((error: unknown) => error);

    await expect(failure).resolves.toBeInstanceOf(Error);
    await expect(failure).resolves.not.toBeInstanceOf(PermanentBackgroundTaskError);
  });

  it('leaves plan-never-created admission failure retryable and re-enters without a plan row', async () => {
    const blocked = 'MOZI could not create the required durable plan, so the runtime blocked inline execution. No plan was started and no result is being claimed. Please retry.';
    hoisted.handleMessage
      .mockResolvedValueOnce(blocked)
      .mockResolvedValueOnce('Completed after clean re-entry.');
    const scheduled = task({ prompt: 'Generate today\'s detailed market analysis and verified PDF report.' });

    const failure = managedBrainHandler(scheduled, new AbortController().signal)
      .catch((error: unknown) => error);
    await expect(failure).resolves.toBeInstanceOf(Error);
    await expect(failure).resolves.not.toBeInstanceOf(PermanentBackgroundTaskError);

    await expect(managedBrainHandler(scheduled, new AbortController().signal))
      .resolves.toBe('Completed after clean re-entry.');
    expect(hoisted.mergeParams).not.toHaveBeenCalled();
    expect(hoisted.waitForPlanRun).not.toHaveBeenCalled();
  });

  it('keeps non-retryable plan failures permanent', async () => {
    hoisted.waitForPlanRun.mockResolvedValue({
      rootTaskId: 'plan-root',
      success: false,
      content: 'Invalid parameters.',
      retryableFailure: false,
    });

    await expect(managedBrainHandler(
      task({ prompt: 'Generate report.', managed_plan_root_id: 'plan-root' }),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PermanentBackgroundTaskError);
  });

  it('restarts a terminal transient plan on outer retry re-entry', async () => {
    hoisted.isPlanRunActive.mockReturnValue(false);
    hoisted.getById.mockReturnValue({ id: 'plan-root', status: 'failed' });
    hoisted.restartPlanFromMetadata.mockReturnValue({ started: true });
    hoisted.waitForPlanRun
      .mockResolvedValueOnce({
        rootTaskId: 'plan-root',
        success: false,
        content: 'Provider retries exhausted.',
        retryableFailure: true,
      })
      .mockResolvedValueOnce({ rootTaskId: 'plan-root', success: true, content: 'Recovered report.' });

    const result = await managedBrainHandler(
      task({ prompt: 'Generate report.', managed_plan_root_id: 'plan-root' }),
      new AbortController().signal,
    );

    expect(result).toBe('Recovered report.');
    expect(hoisted.restartPlanFromMetadata).toHaveBeenCalledWith(
      'plan-root', expect.objectContaining({ retryFailedSteps: true }),
    );
  });
});
