import type { ChatMessage, ChatOptions, LLMClient, ModelThinkSetting } from './llm.js';
import type { ToolContext } from '../tools/types.js';
import type { ProgressCallback } from './brain-progress.js';
import type { CompletionGateDecision } from './completion-gates.js';
import type { TaskToolProfile } from '../tools/tool-shaping.js';
import type { RuntimeAdmission } from './durable-plan-admission.js';

export interface BrainExecutionResult {
  responseText: string;
  model?: string;
  totalTokens?: number;
  toolIterations: number;
  recovered: boolean;
  recoveryMode?: 'self_heal' | 'hard_recovery' | 'brain_intervention' | 'fallback';
  completionGateDecision: CompletionGateDecision;
  completionGateBlocked?: boolean;
  durablePlanRequired: boolean;
  durablePlanAdmissionBlocked?: boolean;
  runtimeAdmissionBlocked?: boolean;
  /** Detached plan created by this turn, when decompose_task ended it. */
  detachedPlanRootId?: string;
  taskToolProfile: TaskToolProfile;
  exposedToolCount: number;
  toolSchemaTokensEstimate: number;
}

export interface BrainExecutionOptions {
  client: LLMClient;
  contextMessages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  think?: ModelThinkSetting;
  toolContext: ToolContext;
  tenantId: string;
  progress: ProgressCallback;
  chatId: string;
  turnId: string;
  taskId: string;
  channelType?: string;
  abortSignal?: AbortSignal;
  usageCollector?: ChatOptions['usageCollector'];
  modelProvider?: string;
  modelId?: string;
  promptCacheKey?: string;
  runtimeAdmission?: RuntimeAdmission;
  maxIterations: number;
  llmCallTimeoutMs: number;
  maxLoopElapsedMs: number;
  repeatedBatchThreshold: number;
  maxFailedToolBatches: number;
  selfHealRetries: number;
  selfHealBackoffMs: number;
}
