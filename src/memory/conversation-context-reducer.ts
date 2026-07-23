import pino from 'pino';
import type { ChatMessage } from '../core/llm.js';
import { compress, mergeSummaries } from '../core/running-summary.js';
import { emit } from '../progress/event-bus.js';
import { estimateMessagesTokens, estimateTokens } from './token-counter.js';
import { assembleHistory, type HistoryAssemblyResult } from './context-history.js';
import type { ChatMessage as StoredChatMessage } from './conversations.js';
import {
  beginContextCheckpoint,
  completeContextCheckpoint,
  failContextCheckpoint,
  getLatestContextCheckpoint,
  updateContextCheckpointStage,
  type ContextCheckpointStage,
} from './context-checkpoints.js';

const logger = pino({ name: 'mozi:conversation-context-reducer' });

export interface ReducerMessage {
  stored: StoredChatMessage;
  message: ChatMessage;
}

export interface ReduceSessionContextInput {
  tenantId: string;
  userId: string;
  sessionId: string;
  chatId: string;
  messages: ReducerMessage[];
  historyTokenBudget: number;
  baseTokenCount?: number;
  modelContextWindow: number;
  threshold: number;
}

const sessionReductionTails = new Map<string, Promise<void>>();

function lifecycle(input: ReduceSessionContextInput, stage: ContextCheckpointStage, sourceTokens: number, summaryTokens?: number): void {
  emit({
    type: 'context_compression',
    compressionStage: stage,
    sourceTokens,
    summaryTokens,
    contextWindow: input.modelContextWindow,
    chatId: input.chatId,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
  });
}

/**
 * Canonical, durable reducer for a session's conversation projection.
 * Raw conversation rows remain immutable; only completed checkpoints are read.
 */
export async function reduceSessionContext(input: ReduceSessionContextInput): Promise<HistoryAssemblyResult> {
  const lockKey = `${input.tenantId}:${input.sessionId}`;
  const predecessor = sessionReductionTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = predecessor.then(() => gate);
  sessionReductionTails.set(lockKey, tail);
  await predecessor;
  try {
    return await reduceSessionContextLocked(input);
  } finally {
    release();
    if (sessionReductionTails.get(lockKey) === tail) sessionReductionTails.delete(lockKey);
  }
}

async function reduceSessionContextLocked(input: ReduceSessionContextInput): Promise<HistoryAssemblyResult> {
  if (input.historyTokenBudget <= 0) {
    return { messages: [], rawTokens: 0, usedTokens: 0, itemCount: 0, fallbackApplied: 'omitted' };
  }

  const latest = getLatestContextCheckpoint(input.sessionId, input.tenantId, 'completed');
  const newMessages = latest
    ? input.messages.filter(entry => entry.stored.id > latest.source_message_id)
    : input.messages;
  const prefix: ChatMessage[] = latest?.summary
    ? [{ role: 'system', content: `[Conversation Summary]\n${latest.summary}` }]
    : [];
  const candidate = [...prefix, ...newMessages.map(entry => entry.message)];
  const rawTokens = estimateMessagesTokens(candidate);
  const measuredContextTokens = rawTokens + (input.baseTokenCount ?? 0);

  if (rawTokens <= input.historyTokenBudget) {
    return {
      messages: candidate,
      rawTokens,
      usedTokens: rawTokens,
      itemCount: candidate.length,
      fallbackApplied: latest ? 'summary' : 'none',
    };
  }

  // Keep a measured recent tail with room for the durable summary. Never split
  // a tool result away from the assistant tool call that precedes it.
  const recentBudget = Math.max(64, Math.floor(input.historyTokenBudget * 0.6));
  let split = newMessages.length;
  let recentTokens = 0;
  for (let i = newMessages.length - 1; i >= 0; i--) {
    const cost = estimateMessagesTokens([newMessages[i].message]);
    if (recentTokens + cost > recentBudget && newMessages.length - i >= 2) break;
    recentTokens += cost;
    split = i;
  }
  while (split > 0 && newMessages[split]?.message.role === 'tool') split--;
  const toReduce = newMessages.slice(0, split);
  const kept = newMessages.slice(split);

  if (toReduce.length === 0) {
    return assembleHistory(candidate, input.historyTokenBudget);
  }

  const sourceMessageId = toReduce[toReduce.length - 1].stored.id;
  const retainedFromMessageId = kept[0]?.stored.id ?? null;
  const checkpoint = beginContextCheckpoint({
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
    chatId: input.chatId,
    sourceMessageId,
    retainedFromMessageId,
    sourceTokenCount: measuredContextTokens,
    modelContextWindow: input.modelContextWindow,
    threshold: input.threshold,
  });

  try {
    lifecycle(input, 'preparing', measuredContextTokens);
    updateContextCheckpointStage(checkpoint.id, 'summarizing');
    lifecycle(input, 'summarizing', measuredContextTokens);
    const segment = await compress(toReduce.map(entry => entry.message), 0, 0);
    const summary = await mergeSummaries(latest?.summary ?? '', segment.summary);
    updateContextCheckpointStage(checkpoint.id, 'saving');
    lifecycle(input, 'saving', measuredContextTokens);
    const summaryTokens = estimateTokens(summary);
    completeContextCheckpoint(checkpoint.id, summary, summaryTokens);
    lifecycle(input, 'completed', measuredContextTokens, summaryTokens);
    const reduced = [
      { role: 'system' as const, content: `[Conversation Summary]\n${summary}` },
      ...kept.map(entry => entry.message),
    ];
    return {
      messages: reduced,
      rawTokens,
      usedTokens: estimateMessagesTokens(reduced),
      itemCount: reduced.length,
      fallbackApplied: 'summary',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failContextCheckpoint(checkpoint.id, message);
    lifecycle(input, 'failed', measuredContextTokens);
    logger.warn({ err: message, sessionId: input.sessionId }, 'Durable context reduction failed; using safe transient fallback');
    return assembleHistory(candidate, input.historyTokenBudget);
  }
}
