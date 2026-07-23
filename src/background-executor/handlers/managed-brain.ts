import type { BackgroundTask } from '../../core/background-tasks.js';
import { mergeBackgroundTaskHandlerParams } from '../../core/background-tasks.js';
import { getById } from '../../store/task-dag.js';
import {
  isPlanRunActive,
  restartPlanFromMetadata,
  waitForPlanRun,
} from '../../core/plan-runner.js';
import { getBrainClient } from '../../core/model-router.js';
import { getConfig } from '../../config/index.js';
import {
  adaptPromptForChannel,
  loadDelegationSystemPrompt,
  loadSystemPrompt,
} from '../../system-prompt.js';
import { handleMessage, type ProgressCallback } from '../../gateway/handler.js';
import type { IncomingMessage } from '../../channels/telegram.js';
import { getTurnEnvelope } from '../../memory/turn-envelopes.js';
import { PermanentBackgroundTaskError } from '../registry.js';
import { openCronRunSession } from '../../scheduler/cron-tasks.js';
import { durablePlanBlockedResponse } from '../../core/durable-plan-admission.js';

interface ManagedBrainParams {
  prompt?: unknown;
  source_request?: unknown;
  managed_plan_root_id?: unknown;
}

function parseParams(task: BackgroundTask): ManagedBrainParams {
  try {
    const parsed = task.handler_params ? JSON.parse(task.handler_params) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ManagedBrainParams
      : {};
  } catch {
    throw new PermanentBackgroundTaskError('Managed scheduled task has invalid handler parameters.');
  }
}

async function waitForExistingPlan(
  rootTaskId: string,
  task: BackgroundTask,
  delegationSystemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const root = getById(rootTaskId, task.tenant_id);
  if (!root) throw new PermanentBackgroundTaskError(`Managed scheduled plan ${rootTaskId} no longer exists.`);
  if (!isPlanRunActive(rootTaskId) && root.status === 'failed') {
    const previous = await waitForPlanRun(rootTaskId, task.tenant_id, signal);
    if (!previous.retryableFailure) throw new PermanentBackgroundTaskError(previous.content);
    const restarted = restartPlanFromMetadata(rootTaskId, {
      tenantId: task.tenant_id,
      systemPrompt: delegationSystemPrompt,
      fallbackClient: getBrainClient({ tenantId: task.tenant_id, userId: task.user_id ?? undefined }).client,
      retryFailedSteps: true,
    });
    if (!restarted.started && !isPlanRunActive(rootTaskId)) {
      throw new Error(`Managed scheduled plan ${rootTaskId} could not retry: ${restarted.reason ?? 'unknown reason'}`);
    }
  } else if (!isPlanRunActive(rootTaskId) && !['completed', 'cancelled'].includes(root.status)) {
    const restarted = restartPlanFromMetadata(rootTaskId, {
      tenantId: task.tenant_id,
      systemPrompt: delegationSystemPrompt,
      fallbackClient: getBrainClient({ tenantId: task.tenant_id, userId: task.user_id ?? undefined }).client,
      normalizeStrandedSteps: true,
    });
    if (!restarted.started && !isPlanRunActive(rootTaskId)) {
      throw new Error(`Managed scheduled plan ${rootTaskId} could not resume: ${restarted.reason ?? 'unknown reason'}`);
    }
  }
  const outcome = await waitForPlanRun(rootTaskId, task.tenant_id, signal);
  if (!outcome.success) {
    if (outcome.retryableFailure) throw new Error(outcome.content);
    throw new PermanentBackgroundTaskError(outcome.content);
  }
  return outcome.content;
}

/**
 * Execute a scheduled workload through the same Brain and durable-plan kernel
 * as an interactive turn. The host scheduler never receives shell commands;
 * the persisted cron row owns identity, permissions, retries and delivery.
 */
export async function managedBrainHandler(task: BackgroundTask, signal: AbortSignal): Promise<string> {
  if (!task.cron_run_id || !task.source_cron_task_id) {
    throw new PermanentBackgroundTaskError('Managed scheduled execution requires persisted cron run identity.');
  }
  const params = parseParams(task);
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt) throw new PermanentBackgroundTaskError('Managed scheduled execution requires a non-empty workload prompt.');

  const run = openCronRunSession(task);
  task.session_id = run.sessionId;
  task.user_id = run.userId;
  task.channel_type = run.channelType;
  task.chat_id = run.chatId;
  task.permission_level = run.permissionLevel;
  void import('../../channels/websocket.js').then(({ broadcastSessionListChanged }) => {
    broadcastSessionListChanged({
      targetUserId: run.userId,
      tenantId: task.tenant_id,
      sessionId: run.sessionId,
    });
  });

  const config = getConfig();
  const delegationSystemPrompt = loadDelegationSystemPrompt(config, task.tenant_id);
  const existingRootId = typeof params.managed_plan_root_id === 'string'
    ? params.managed_plan_root_id.trim()
    : '';
  if (existingRootId) {
    return waitForExistingPlan(existingRootId, task, delegationSystemPrompt, signal);
  }

  const msg: IncomingMessage = {
    channelType: run.channelType,
    chatId: task.chat_id,
    tenantId: task.tenant_id,
    userId: run.userId,
    username: 'scheduler',
    text: prompt,
    isCommand: false,
    attachments: [],
    sessionId: run.sessionId,
    suppressUserMessagePersistence: true,
    timestamp: new Date(),
  };
  let rootTaskId = '';
  const progress: ProgressCallback = {
    onToolStart: () => {},
    onToolEnd: () => {},
    onProcessingStart: () => {},
    onArtifact: (event) => {
      if (!msg.turnId) return;
      void import('../../channels/websocket.js').then(({ broadcastArtifactEvent }) => {
        broadcastArtifactEvent(event, task.user_id!, task.session_id!, task.tenant_id, msg.turnId!);
      });
    },
  };
  const { client } = getBrainClient({ tenantId: task.tenant_id, userId: task.user_id });
  const response = await handleMessage(
    msg,
    adaptPromptForChannel(loadSystemPrompt(config, task.tenant_id), task.channel_type),
    client,
    progress,
    undefined,
    signal,
    delegationSystemPrompt,
    {
      origin: 'scheduler',
      permissionLevel: run.permissionLevel ?? undefined,
      originalRequest: prompt,
      planDeliveryMode: 'caller',
      suppressAssistantMessagePersistence: true,
      onDetachedPlanStarted: (id) => {
        rootTaskId = id;
        mergeBackgroundTaskHandlerParams(task.id, { managed_plan_root_id: id });
      },
    },
  );

  if (rootTaskId) {
    return waitForExistingPlan(rootTaskId, task, delegationSystemPrompt, signal);
  }
  const envelope = msg.turnId
    ? getTurnEnvelope(task.session_id, msg.turnId, task.tenant_id)
    : null;
  const content = response?.trim() || 'Managed scheduled execution returned no result.';
  if (content === durablePlanBlockedResponse(prompt)) {
    // No plan, no side effects, safe to re-enter through the bounded outer
    // runner: this retry is idempotent.
    throw new Error(content);
  }
  if (envelope?.status === 'failed') throw new PermanentBackgroundTaskError(content);
  if (/previous request is still running/i.test(content)) throw new Error(content);
  return content;
}
