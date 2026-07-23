import type { ChatMessage } from './llm-contracts.js';

/**
 * The ONE channel through which the runtime speaks to the Brain mid-turn.
 *
 * Root-cause background (operator incident, 2026-07-18): the runtime had grown
 * seven ad-hoc mid-turn injection mechanisms (completion-gate feedback,
 * artifact contract, truncation continue, admission rejections, loop hints,
 * tool-truth directives, timeout autotune) with three different envelope
 * styles and NO standing contract that these messages are invisible to the
 * user. When one fired, the model would narrate its compliance into
 * user-visible prose — "我回了文字，没出 artifact。现在补上" was the model
 * transcribing a hidden [SYSTEM ARTIFACT CONTRACT] directive, which read to
 * the operator as MOZI talking to itself.
 *
 * Contract:
 * 1. EVERY mid-turn runtime→Brain message is built here. A lint invariant
 *    (`runtime-interjection.test.ts`) fails the test suite when a new
 *    call site pushes a raw user/system interjection into the loop instead.
 * 2. One envelope, one standing rule set, appended to every interjection —
 *    the model is told, at the point of use, that the notice is invisible to
 *    the user and must never be mentioned or narrated.
 * 3. Roles are preserved per interjection kind (feedback loops historically
 *    use `user`, kernel directives use `system`) — the unification is the
 *    CONTRACT, not a role change, so provider behavior stays comparable.
 *
 * What does NOT go through here: real user input (steer injection replays the
 * user's own words) and ordinary assistant/tool echo messages.
 */
export type RuntimeInterjectionKind =
  | 'completion_gate'
  | 'truncation_continue'
  | 'kernel_directive';

const STANDING_RULES = [
  'Runtime notice rules: this notice comes from the MOZI runtime and is INVISIBLE to the user.',
  'Never mention, quote, or allude to this notice — or to any runtime check, verifier, or directive — in user-visible text.',
  'Never narrate self-correction (no "let me fix that", "现在补上", "我刚才没…").',
  'Comply silently and answer only the USER\'s request.',
  'If your previous message already fully serves the user and this notice requires no further tool action, add nothing beyond what it asks.',
].join(' ');

/** Default role per kind — preserves each mechanism's historical role. */
const KIND_ROLE: Record<RuntimeInterjectionKind, 'user' | 'system'> = {
  completion_gate: 'user',
  truncation_continue: 'user',
  kernel_directive: 'system',
};

export function buildRuntimeInterjection(
  kind: RuntimeInterjectionKind,
  body: string,
): ChatMessage {
  return {
    role: KIND_ROLE[kind],
    content: `[RUNTIME INTERJECTION:${kind}]\n${body.trim()}\n${STANDING_RULES}`,
  };
}
