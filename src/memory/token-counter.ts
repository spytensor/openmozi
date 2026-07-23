import type { ChatMessage } from '../core/llm.js';
import { getTextContent } from '../core/llm.js';

/** Approximate image token cost (~85 tokens per 512×512 tile, rough heuristic from bytes). */
const IMAGE_TOKENS_PER_BYTE = 85 / (512 * 512 * 3);

/**
 * Approximate token count with CJK-aware estimation.
 *
 * Latin/space/punctuation: ~0.25 tokens per character (4 chars ≈ 1 token).
 * CJK ideographs, Hangul, Kana: ~1.5 tokens per character (each char
 * is typically encoded as 1–2 tokens by modern BPE tokenizers).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Extension A
      (code >= 0x3040 && code <= 0x30FF) ||  // Hiragana + Katakana
      (code >= 0xAC00 && code <= 0xD7AF)     // Hangul Syllables
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(Math.max(tokens, 1));
}

/**
 * Estimate total tokens across an array of chat messages.
 * Includes a small overhead per message for role/formatting tokens.
 * Also counts tool_calls arguments and tool_call_id content.
 * Supports multimodal messages (ContentPart[] with images).
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // ~4 tokens overhead per message for role, delimiters, etc.
    total += 4;

    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      // Multimodal content — estimate text parts + image token cost
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += estimateTokens(part.text);
        } else if (part.type === 'image') {
          total += Math.ceil(part.image.byteLength * IMAGE_TOKENS_PER_BYTE);
        }
      }
    }

    // Count tool call arguments (can be large JSON payloads)
    const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
        if (fn) {
          total += estimateTokens(String(fn.name ?? '')) + estimateTokens(String(fn.arguments ?? ''));
        }
      }
    }
  }
  return total;
}
