/**
 * Converts queued /steer texts into runtime messages for the next brain pass.
 */
import pino from 'pino';
import type { ChatMessage } from '../core/llm.js';
import { detectPromptInjection } from '../tools/executor.js';
import { createRuntimeMessage } from './runtime-message-ir.js';
import { buildRuntimeInterjection } from '../core/runtime-interjection.js';
import { log as logEvent } from '../store/events.js';

const logger = pino({ name: 'mozi:gateway:steer-injection' });

/**
 * Extra injection patterns for short steers (< 20 chars). The generic
 * `detectPromptInjection` skips short input to avoid false positives on
 * brief tool output; user-supplied steers are bounded but may be very short,
 * so we run a focused subset on short strings.
 */
const SHORT_STEER_INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/<\/?\s*system\s*>/i, 'system-tags'],
  [/^\s*system\s*:/i, 'fake-system-prefix'],
  [/ignore\s+(all\s+)?previous/i, 'ignore-previous-instructions'],
  [/you\s+are\s+now\s+/i, 'role-override-you-are-now'],
  [/\[INST\]|\[\/INST\]/i, 'inst-markers'],
];

function detectShortSteerInjection(text: string): string | null {
  for (const [re, name] of SHORT_STEER_INJECTION_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

/**
 * Convert drained /steer texts into ChatMessages to append before the next
 * brain iteration.
 *
 * Security-rejected entries are logged to event_log under
 * `security.steer_rejected` and surfaced as runtime metadata, without
 * forwarding the original rejected payload.
 */
export function prepareSteerInjection(
  chatId: string,
  tenantId: string,
  queuedSteers: string[],
): ChatMessage[] {
  const injected: ChatMessage[] = [];
  for (const steerText of queuedSteers) {
    const injection = detectPromptInjection(steerText) ?? detectShortSteerInjection(steerText);
    if (injection) {
      logger.warn({ chatId, pattern: injection }, 'steer blocked by injection detector');
      try {
        logEvent('security.steer_rejected', 'steer', chatId, { pattern: injection }, tenantId);
      } catch {
        // Audit logging is non-critical; the steer still must not pass through.
      }
      // Runtime-authored notice (NOT the user's words) — must ride the unified
      // interjection channel so the standing invisibility rules travel with it
      // (H批 review finding 1: this was the one mid-turn runtime message left
      // outside the channel).
      injected.push(buildRuntimeInterjection(
        'kernel_directive',
        `User steer rejected (suspected prompt injection: ${injection}).`,
      ) as ChatMessage);
    } else {
      const steerMsg = createRuntimeMessage('user_steer', steerText, { source: `chat:${chatId}` });
      injected.push({ role: steerMsg.role, content: steerMsg.content } as ChatMessage);
      logger.info({ chatId, len: steerText.length }, 'Steer injected into next iteration');
    }
  }
  return injected;
}
