import type { ChatMessage, ChatOptions, LLMClient, ModelThinkSetting, ToolDefinition } from './llm.js';
import type { ToolContext } from '../tools/types.js';
import type { ProgressCallback } from './brain-progress.js';
import type { CompletionGateDecision } from './completion-gates.js';

export interface BrainExecutionResult {
  responseText: string;
  model?: string;
  totalTokens?: number;
  toolIterations: number;
  recovered: boolean;
  recoveryMode?: 'self_heal' | 'hard_recovery' | 'brain_intervention' | 'fallback';
  completionGateDecision: CompletionGateDecision;
  completionGateBlocked?: boolean;
  /** Detached plan created by this turn, when decompose_task ended it. */
  detachedPlanRootId?: string;
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
  onToolSurfaceChanged?: (tools: ToolDefinition[], schemaTokensEstimate: number) => void;
  maxIterations: number;
  llmCallTimeoutMs: number;
  maxLoopElapsedMs: number;
  repeatedBatchThreshold: number;
  maxFailedToolBatches: number;
  selfHealRetries: number;
  selfHealBackoffMs: number;
}
