/**
 * Running Summary — compresses early dialogue turns into a summary.
 *
 * When dialogue exceeds a configurable turn threshold (default 5),
 * early turns are compressed using a cheap model. The summary is
 * capped at 2000 tokens with secondary compression if exceeded.
 */

import { getClientForTask, type RoutingContext } from './model-router.js';
import type { ChatMessage } from './llm.js';
import { getConfig } from '../config/index.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:running-summary' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressResult {
  /** Compressed summary of early turns */
  summary: string;
  /** Remaining recent turns that were not compressed */
  kept_turns: ChatMessage[];
  /** Key decisions/facts extracted */
  key_facts: string[];
  /** Estimated token count of the summary */
  summary_tokens: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TURN_THRESHOLD = 5;
const DEFAULT_KEEP_RECENT = 4;
const DEFAULT_SUMMARY_TOKEN_CAP = 2000;
// Rough estimate: 1 token ≈ 4 chars
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const COMPRESS_PROMPT = `You are a conversation summarizer. Given a conversation history, produce a concise summary that preserves:
1. Key decisions made
2. Important facts and context
3. User preferences/requirements
4. Action items and their status
5. Current execution state — what task is being worked on, which step, and what's planned next
6. Any [TaskResult:...] references verbatim; they are durable pointers and must never be rewritten or omitted

Output format:
SUMMARY: <concise summary of the conversation>
KEY_FACTS:
- <fact 1>
- <fact 2>
...

Keep the summary under 500 words. Focus on facts and decisions, discard pleasantries.`;

const RECOMPRESS_PROMPT = `Compress the following summary to be shorter while preserving all key decisions and facts. Keep it under 300 words.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress a dialogue history by summarizing early turns.
 *
 * @param turns - Full dialogue history
 * @param turnThreshold - Number of turns before compression triggers (default 5)
 * @param keepRecent - Number of recent turns to keep uncompressed (default 4)
 * @returns CompressResult with summary and kept turns
 */
export async function compress(
  turns: ChatMessage[],
  turnThreshold = DEFAULT_TURN_THRESHOLD,
  keepRecent = DEFAULT_KEEP_RECENT,
  routingContext?: RoutingContext,
): Promise<CompressResult> {
  const summaryTokenCap = getConfig().token_budget.running_summary_cap_tokens ?? DEFAULT_SUMMARY_TOKEN_CAP;
  // Not enough turns to compress
  if (turns.length <= turnThreshold) {
    return {
      summary: '',
      kept_turns: turns,
      key_facts: [],
      summary_tokens: 0,
    };
  }

  // Split turns: compress early, keep recent
  const splitIndex = turns.length - keepRecent;
  const earlyTurns = turns.slice(0, splitIndex);

  const toCompress = earlyTurns;
  const keptTurns = turns.slice(splitIndex);

  logger.info({ total_turns: turns.length, compressing: toCompress.length, keeping: keptTurns.length }, 'Compressing dialogue');

  // Build conversation text for compression
  const conversationText = toCompress
    .map(t => `${t.role}: ${t.content}`)
    .join('\n');

  // Use cheap model (summary role → maps to gpt-4.1-mini via model router)
  const { client, selection } = getClientForTask(
    { type: 'summary', complexity: 'low' },
    routingContext,
  );

  const response = await client.chat([
    { role: 'system', content: COMPRESS_PROMPT },
    { role: 'user', content: conversationText },
  ], { max_tokens: 800, temperature: 0.3, think: selection.think });

  let summary = response.content;
  const keyFacts = extractKeyFacts(summary);

  // Estimate token count
  let summaryTokens = Math.ceil(summary.length / CHARS_PER_TOKEN);

  // Secondary compression if over cap
  if (summaryTokens > summaryTokenCap) {
    logger.info({ tokens: summaryTokens, cap: summaryTokenCap }, 'Summary exceeds cap, recompressing');
    const recompressResponse = await client.chat([
      { role: 'system', content: RECOMPRESS_PROMPT },
      { role: 'user', content: summary },
    ], { max_tokens: 400, temperature: 0.2, think: selection.think });

    summary = recompressResponse.content;
    summaryTokens = Math.ceil(summary.length / CHARS_PER_TOKEN);
  }

  logger.info({ summary_tokens: summaryTokens, key_facts: keyFacts.length }, 'Compression complete');

  return {
    summary,
    kept_turns: keptTurns,
    key_facts: keyFacts,
    summary_tokens: summaryTokens,
  };
}

/**
 * Merge an existing running summary with a new summary segment.
 */
export async function mergeSummaries(
  existingSummary: string,
  newSummary: string,
  routingContext?: RoutingContext,
): Promise<string> {
  if (!existingSummary) return newSummary;
  if (!newSummary) return existingSummary;

  const combined = `Previous context:\n${existingSummary}\n\nNew context:\n${newSummary}`;
  const estimatedTokens = Math.ceil(combined.length / CHARS_PER_TOKEN);

  const summaryTokenCap = getConfig().token_budget.running_summary_cap_tokens ?? DEFAULT_SUMMARY_TOKEN_CAP;
  if (estimatedTokens <= summaryTokenCap) {
    return combined;
  }

  // Need to compress the merged summary
  const { client, selection } = getClientForTask(
    { type: 'summary', complexity: 'low' },
    routingContext,
  );
  const response = await client.chat([
    { role: 'system', content: RECOMPRESS_PROMPT },
    { role: 'user', content: combined },
  ], { max_tokens: 400, temperature: 0.2, think: selection.think });

  return response.content;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract key facts from a summary response.
 */
function extractKeyFacts(summary: string): string[] {
  const facts: string[] = [];
  const lines = summary.split('\n');
  let inKeyFacts = false;

  for (const line of lines) {
    if (line.trim().startsWith('KEY_FACTS:')) {
      inKeyFacts = true;
      continue;
    }
    if (inKeyFacts && line.trim().startsWith('- ')) {
      facts.push(line.trim().slice(2));
    } else if (inKeyFacts && line.trim() === '') {
      // End of key facts section
      break;
    }
  }

  return facts;
}
