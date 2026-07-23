/**
 * Handler helper utilities — types, worker follow-up, tool output recovery,
 * and miscellaneous pure functions extracted from handler.ts.
 */
import pino from 'pino';
import { getProvider, detectConfiguredProviders } from '../core/providers.js';
import { sanitizeVisibleOutput } from './output-sanitizer.js';
import type { getConfig } from '../config/index.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import type { ChatMessage } from '../core/llm.js';
import type { OutputChannel } from '../channels/output-channel.js';
import type { ExternalWorkerJob } from '../workers/job-state.js';

const logger = pino({ name: 'mozi:gateway:helpers' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback interface for real-time progress updates to channels */
export interface ProgressCallback {
  onToolStart: (toolName: string) => void;
  onToolEnd: (toolName: string) => void;
  onProcessingStart: () => void;
  /** Called with accumulated text during LLM streaming */
  onStreamChunk?: (accumulated: string) => void;
  /** Called when LLM streaming completes with full text */
  onStreamEnd?: (fullText: string) => void;
  /** Called when a partial stream must be removed before retry. */
  onStreamReset?: () => void;
  /** Called when an artifact should be opened/patched/closed in rich-capable clients */
  onArtifact?: (event: ArtifactEvent) => void;
}

/** No-op progress callback for when no progress tracking is needed */
export const NOOP_PROGRESS: ProgressCallback = {
  onToolStart: () => {},
  onToolEnd: () => {},
  onProcessingStart: () => {},
  onArtifact: () => {},
};

/** Mutable accumulator for trace metrics shared across execution paths */
export interface TraceAccumulator {
  llmInputTokens: number;
  llmOutputTokens: number;
  costUsd: number;
  toolCallCount: number;
  toolFailureCount: number;
}

// ---------------------------------------------------------------------------
// Worker follow-up utilities
// ---------------------------------------------------------------------------

const LOW_INFORMATION_FOLLOW_UP_PATTERNS = [
  /^(再试一次|再试|重试|继续|接着|接着来|继续刚才的|继续这个|还是这个|就这个|再来一次)$/,
  /^(retry|tryagain|again|continue|goahead|proceed|keepgoing)$/i,
];

const WORKER_STATUS_FOLLOW_UP_PATTERNS = [
  /^(进展呢|啥进展|什么进展|进度呢|结果呢|状态呢|查一下|看一下|怎么样了|完成了吗|好了没|还在跑吗|审查结果呢)$/,
  /^(status|update|progress|result|doneyet|isitrunning|stillrunning|howisitgoing)$/i,
];
const EXTERNAL_WORKER_FOLLOW_UP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeFollowUpText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[`"'""''.,!?;:~\-_=+()[\]{}<>/\\|@#$%^&*，。！？；：、…～]+/g, '');
}

export function isLowInformationFollowUp(text: string): boolean {
  const normalized = normalizeFollowUpText(text);
  if (!normalized || normalized.length > 24) return false;
  return LOW_INFORMATION_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isWorkerStatusFollowUp(text: string): boolean {
  const normalized = normalizeFollowUpText(text);
  if (!normalized || normalized.length > 24) return false;
  return WORKER_STATUS_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isRecentExternalWorkerJob(job: ExternalWorkerJob | null | undefined): job is ExternalWorkerJob {
  if (!job) return false;
  const updatedMs = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedMs)) return false;
  return Date.now() - updatedMs <= EXTERNAL_WORKER_FOLLOW_UP_MAX_AGE_MS;
}

export function isInFlightExternalWorkerJobStatus(status: ExternalWorkerJob['status']): boolean {
  return status === 'queued' || status === 'launching' || status === 'running' || status === 'completed_pending_verify';
}

export function buildExternalWorkerFactsPrompt(job: ExternalWorkerJob): string {
  const verifyStatus = job.verify_report?.status ?? 'not_recorded';
  const summary =
    job.verify_report?.summary
    || job.result_envelope?.summary
    || job.last_error
    || '';

  return [
    '[RUNTIME MANAGED WORKER FACTS — authoritative]',
    `job_id=${job.id}`,
    `adapter_id=${job.adapter_id}`,
    `runtime_label=${job.runtime_label ?? job.adapter_id}`,
    `status=${job.status}`,
    `verify_status=${verifyStatus}`,
    `updated_at=${job.updated_at}`,
    summary ? `summary=${summary.slice(0, 1000)}` : 'summary=',
    'If the user asks for progress, status, or results of delegated work, answer strictly from these facts.',
    'Do not reference shell process IDs or claim background execution paths outside managed worker jobs.',
  ].join('\n');
}

export function buildExternalWorkerFollowUpResponse(userMessage: string, job: ExternalWorkerJob): string {
  const isZh = hasCjkText(userMessage);
  const runtimeLabel = job.runtime_label ?? job.adapter_id;
  const verifyStatus = job.verify_report?.status ?? 'not_recorded';
  const summary =
    job.verify_report?.summary
    || job.result_envelope?.summary
    || job.last_error
    || 'No summary available.';

  if (isZh) {
    if (job.status === 'queued' || job.status === 'launching' || job.status === 'running') {
      return `上一个托管任务还在运行中。worker: ${runtimeLabel}。job_id: ${job.id}。当前状态: ${job.status}。`;
    }
    if (job.status === 'completed_pending_verify') {
      return `上一个托管任务已完成执行，正在等待验证。worker: ${runtimeLabel}。job_id: ${job.id}。验证状态: ${verifyStatus}。`;
    }
    if (job.status === 'succeeded') {
      return `上一个托管任务已完成。worker: ${runtimeLabel}。job_id: ${job.id}。验证状态: ${verifyStatus}。结果摘要: ${summary}`;
    }
    if (job.status === 'failed' || job.status === 'timed_out' || job.status === 'cancelled') {
      return `上一个托管任务没有成功完成。worker: ${runtimeLabel}。job_id: ${job.id}。当前状态: ${job.status}。原因: ${summary}`;
    }
    return `上一个托管任务的当前状态是 ${job.status}。worker: ${runtimeLabel}。job_id: ${job.id}。`;
  }

  if (job.status === 'queued' || job.status === 'launching' || job.status === 'running') {
    return `The last managed worker job is still running. worker: ${runtimeLabel}. job_id: ${job.id}. Current status: ${job.status}.`;
  }
  if (job.status === 'completed_pending_verify') {
    return `The last managed worker job finished execution and is waiting for verification. worker: ${runtimeLabel}. job_id: ${job.id}. verify_status: ${verifyStatus}.`;
  }
  if (job.status === 'succeeded') {
    return `The last managed worker job completed successfully. worker: ${runtimeLabel}. job_id: ${job.id}. verify_status: ${verifyStatus}. Summary: ${summary}`;
  }
  if (job.status === 'failed' || job.status === 'timed_out' || job.status === 'cancelled') {
    return `The last managed worker job did not complete successfully. worker: ${runtimeLabel}. job_id: ${job.id}. Current status: ${job.status}. Reason: ${summary}`;
  }
  return `The last managed worker job is in status ${job.status}. worker: ${runtimeLabel}. job_id: ${job.id}.`;
}

export function buildMissingManagedWorkerFollowUpResponse(userMessage: string): string {
  if (hasCjkText(userMessage)) {
    return '当前没有可查询的托管任务。这个会话里旧的 shell 后台任务已经失效，不能再继续查询。请重新发起一次任务。';
  }
  return 'There is no active managed worker job to inspect for this chat. The old shell-based background task is stale and cannot be queried anymore. Please start a new task.';
}

// ---------------------------------------------------------------------------
// Background agent completion context
// ---------------------------------------------------------------------------

export interface BackgroundAgentCompletion {
  task_id: string;
  task_title: string;
  success: boolean;
  summary: string;
  result_path?: string;
  result_ref?: string;
  elapsed_ms?: number;
  completed_at: string;
}

/**
 * Build a system prompt section that informs the Brain about recently
 * completed background agents. Brain can use `read_task_result` tool
 * to recover full details if needed.
 */
export function buildBackgroundAgentFactsPrompt(completions: BackgroundAgentCompletion[]): string {
  if (completions.length === 0) return '';

  const lines = [
    '[BACKGROUND AGENT COMPLETIONS — authoritative, since your last turn]',
    '',
  ];

  for (const c of completions) {
    const status = c.success ? '✅ succeeded' : '❌ failed';
    const elapsed = c.elapsed_ms ? ` (${Math.round(c.elapsed_ms / 1000)}s)` : '';
    lines.push(`- task_id=${c.task_id} "${c.task_title}" ${status}${elapsed}`);
    lines.push(`  summary: ${c.summary.slice(0, 200)}`);
    if (c.result_ref) {
      lines.push(`  ${c.result_ref}`);
    }
    lines.push('');
  }

  lines.push('If you need full task results, use the read_task_result tool with the task_id.');
  lines.push('Acknowledge completions to the user when relevant to the current conversation.');

  return lines.join('\n');
}

export function buildFollowUpExecutionDirective(userMessage: string, originalRequest: string): string {
  return [
    '[FOLLOW-UP RESOLUTION — authoritative]',
    `Current user message: ${userMessage}`,
    'This is a low-information follow-up that refers to the last substantive user request below.',
    `Last substantive request: ${originalRequest}`,
    'Interpret the user intent as: continue or retry that substantive request now.',
    'Do the work immediately using tools when needed.',
    'Do NOT reply with a plan, a promise to start, or a restatement of intent unless you are blocked.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool output recovery
// ---------------------------------------------------------------------------

export function buildRecoveredToolOutputSynthesisPrompt(userMessage: string, recoveredText: string): ChatMessage[] {
  const cappedRecoveredText = recoveredText.length > 12_000
    ? `${recoveredText.slice(0, 12_000)}\n\n[TRUNCATED TOOL OUTPUT]`
    : recoveredText;

  return [
    {
      role: 'system',
      content: [
        'You are writing the final user-facing answer after tools already ran.',
        'Use only the recovered tool output below.',
        'Do not call tools again.',
        'Do not paste site navigation, login UI, or unrelated page chrome.',
        'Extract only the parts relevant to the user request and answer directly.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Original user request:\n${userMessage}`,
        `Recovered tool output:\n${cappedRecoveredText}`,
      ].join('\n\n'),
    },
  ];
}

export interface AISdkStepLike {
  text?: unknown;
  toolCalls?: unknown;
  toolResults?: unknown;
}

export function extractVisibleToolResultText(toolResult: unknown): string {
  if (Array.isArray(toolResult)) {
    return toolResult
      .map(extractVisibleToolResultText)
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (typeof toolResult === 'string') {
    return sanitizeVisibleOutput(toolResult).trim();
  }
  if (!toolResult || typeof toolResult !== 'object') {
    return '';
  }

  if ('result' in toolResult) {
    return extractVisibleToolResultText((toolResult as { result?: unknown }).result);
  }
  if ('output' in toolResult) {
    return extractVisibleToolResultText((toolResult as { output?: unknown }).output);
  }
  if ('content' in toolResult) {
    return extractVisibleToolResultText((toolResult as { content?: unknown }).content);
  }

  try {
    return sanitizeVisibleOutput(JSON.stringify(toolResult)).trim();
  } catch {
    return '';
  }
}

export function recoverVisibleTextFromAiSdkSteps(steps: AISdkStepLike[]): string {
  const postToolTexts: string[] = [];
  const toolResultTexts: string[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    const stepText = typeof step.text === 'string'
      ? sanitizeVisibleOutput(step.text).trim()
      : '';
    const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
    const hasToolCalls = toolCalls.length > 0;
    const hasToolResults = toolResults.length > 0;

    if (stepText && (!hasToolCalls || hasToolResults) && !seen.has(stepText)) {
      postToolTexts.push(stepText);
      seen.add(stepText);
    }

    if (!hasToolResults) continue;
    for (const toolResult of toolResults) {
      const recovered = extractVisibleToolResultText(toolResult);
      if (!recovered || seen.has(recovered)) continue;
      toolResultTexts.push(recovered);
      seen.add(recovered);
    }
  }

  return postToolTexts.length > 0
    ? postToolTexts.join('\n\n')
    : toolResultTexts.join('\n\n');
}

export function shouldSynthesizeRecoveredToolOutput(_steps: AISdkStepLike[], recoveredText: string): boolean {
  return recoveredText.length > 0;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export function buildRuntimeModelFactsPrompt(
  selectedProvider: string,
  selectedModel: string,
  runtimeConfig: ReturnType<typeof getConfig>,
): string {
  const providerIds = new Set<string>();
  const addProvider = (providerId: string | undefined) => {
    const normalized = (providerId ?? '').trim();
    if (normalized) providerIds.add(normalized);
  };

  addProvider(selectedProvider);
  addProvider(runtimeConfig.model_router?.brain_provider);
  addProvider(runtimeConfig.model_router?.fallback_brain_provider);

  const roleConfig = runtimeConfig.model_router?.roles ?? {};
  for (const role of Object.values(roleConfig)) {
    if (role && typeof role === 'object') {
      addProvider((role as { provider?: string }).provider);
    }
  }

  for (const configured of detectConfiguredProviders()) {
    addProvider(configured.id);
  }

  for (const configuredId of Object.keys(runtimeConfig.providers ?? {})) {
    addProvider(configuredId);
  }

  const configuredLines = Array.from(providerIds)
    .sort()
    .map((providerId) => {
      const def = getProvider(providerId);
      if (!def) return `- ${providerId}: (custom provider)`;
      const modelIds = def.models.map(m => m.id);
      const shown = modelIds.slice(0, 6);
      const suffix = modelIds.length > 6 ? ` (+${modelIds.length - 6} more)` : '';
      return `- ${providerId}: ${shown.join(', ')}${suffix}`;
    });

  return [
    '[RUNTIME MODEL FACTS — authoritative]',
    `current_provider=${selectedProvider || 'unknown'}`,
    `current_model=${selectedModel || 'unknown'}`,
    configuredLines.length > 0
      ? `configured_provider_models:\n${configuredLines.join('\n')}`
      : 'configured_provider_models: none',
    'If asked which model is running or what models are available, answer only from these facts.',
    'Do not claim missing permission for this question.',
  ].join('\n');
}

export function hasCjkText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

export function estimateTurnTokenDemand(userMessage: string): number {
  const promptAndReplyBudget = Math.ceil(userMessage.length / 4) * 3;
  return Math.max(256, promptAndReplyBudget);
}

export function buildQuotaMessage(
  userMessage: string,
  type: 'daily_or_monthly' | 'model_not_allowed' | 'task_tokens',
  modelName?: string,
): string {
  const isZh = hasCjkText(userMessage);
  if (type === 'model_not_allowed') {
    return isZh
      ? `当前租户不允许使用模型 ${modelName ?? 'unknown'}。请联系管理员调整 allowed_models 配置后重试。`
      : `Model ${modelName ?? 'unknown'} is not allowed for this tenant. Ask an admin to update allowed_models and retry.`;
  }

  if (type === 'task_tokens') {
    return isZh
      ? '当前请求已达到单任务 token 配额上限。请拆分任务后重试。'
      : 'This request reached the per-task token quota. Please split the task and retry.';
  }

  return isZh
    ? '当前租户 token 配额已达到上限。请稍后重试或联系管理员提升配额。'
    : 'This tenant reached its token quota limit. Retry later or ask an admin to increase the quota.';
}

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

export function isAbortLikeError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /aborted|cancelled|canceled/i.test(message);
}

export function buildAbortError(abortSignal: AbortSignal, fallbackMessage: string): Error {
  const reason = abortSignal.reason;
  if (reason instanceof Error) {
    reason.name = 'AbortError';
    return reason;
  }
  const message = typeof reason === 'string' && reason.trim().length > 0
    ? reason
    : fallbackMessage;
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(abortSignal: AbortSignal | undefined, fallbackMessage: string): void {
  if (!abortSignal?.aborted) return;
  throw buildAbortError(abortSignal, fallbackMessage);
}

// ---------------------------------------------------------------------------
// File sending
// ---------------------------------------------------------------------------

/**
 * Send tool-generated files to the output channel.
 */
export async function sendToolFilesToOutputChannel(
  outputChannel: OutputChannel | undefined,
  filePaths: string[],
): Promise<void> {
  if (!outputChannel?.sendFile || filePaths.length === 0) return;

  for (const fp of filePaths) {
    if (outputChannel.shouldAutoSendFile && !outputChannel.shouldAutoSendFile(fp)) {
      logger.debug({ filePath: fp, channelType: outputChannel.channelType }, 'Skipping auto-send of tool artifact for channel policy');
      continue;
    }
    try {
      await outputChannel.sendFile(fp);
    } catch (err) {
      logger.warn({ filePath: fp, error: err instanceof Error ? err.message : String(err) }, 'Failed to send file to channel');
    }
  }
}
