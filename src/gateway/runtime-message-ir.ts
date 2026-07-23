/**
 * Runtime Message IR — minimal implementation of the contract in
 * `docs/RUNTIME-PROMPT-ARCHITECTURE.md` §2.
 *
 * Annotates in-turn messages with a `runtime_kind` so downstream context
 * compression, provenance tracking, and trust gating can reason about origin
 * without string matching. Six kinds are defined in the spec; `user_steer` is
 * added here to represent out-of-band user nudges injected mid-turn by the
 * `/steer` command (#257). `user_steer` is always untrusted — the content is
 * user input that must not be treated as system policy.
 */

export type RuntimeKind =
  | 'user_input'
  | 'system_policy'
  | 'runtime_meta'
  | 'tool_truth'
  | 'memory_context'
  | 'verifier_feedback'
  | 'user_steer';

export type RuntimeRole = 'system' | 'user' | 'assistant' | 'tool';

export interface RuntimeMessage {
  runtime_kind: RuntimeKind;
  role: RuntimeRole;
  content: string;
  /** True when content originates from an untrusted source (user input, tool output, steer). */
  untrusted: boolean;
  /** Optional origin tag (e.g. channel id) for diagnostics. */
  source?: string;
}

const STEER_PREFIX_FALLBACK = '[USER STEER — untrusted]\n';

/**
 * Build the prefix for a user_steer message. When a `source` like `chat:<id>`
 * is provided, the prefix embeds the chat id so an attacker cannot forge the
 * prefix inside the message body (they do not know the current chat id).
 */
function buildSteerPrefix(source: string | undefined): string {
  if (source && /^chat:[A-Za-z0-9._-]+$/.test(source)) {
    return `[USER STEER ${source} — untrusted]\n`;
  }
  return STEER_PREFIX_FALLBACK;
}

/**
 * Build a runtime message for the given kind.
 *
 * `user_steer` content is wrapped with the `[USER STEER <source> — untrusted]`
 * prefix (source-bound when available) so downstream readers can identify the
 * origin. It remains `role: user`: a nudge is user input, never system policy.
 */
export function createRuntimeMessage(
  kind: RuntimeKind,
  content: string,
  options?: { source?: string },
): RuntimeMessage {
  const source = options?.source;
  switch (kind) {
    case 'user_steer':
      return {
        runtime_kind: 'user_steer',
        role: 'user',
        content: `${buildSteerPrefix(source)}${content}`,
        untrusted: true,
        ...(source ? { source } : {}),
      };
    case 'user_input':
      return {
        runtime_kind: 'user_input',
        role: 'user',
        content,
        untrusted: true,
        ...(source ? { source } : {}),
      };
    case 'tool_truth':
      return {
        runtime_kind: 'tool_truth',
        role: 'tool',
        content,
        untrusted: true,
        ...(source ? { source } : {}),
      };
    case 'system_policy':
    case 'runtime_meta':
    case 'memory_context':
    case 'verifier_feedback':
      return {
        runtime_kind: kind,
        role: 'system',
        content,
        untrusted: false,
        ...(source ? { source } : {}),
      };
  }
}
