/**
 * Turn locale — server-authoritative user-language for one turn (Issue #628).
 * ---------------------------------------------------------------------------
 * A turn's presentation language belongs on the authoritative path, not to a
 * per-render character scan in the UI. The runtime infers the locale ONCE from
 * the turn's own text (the user prompt for interactive turns, the delivered
 * content for background/proactive turns), stamps it on the Turn Envelope, and
 * Web/App presentation consumes that carried value instead of re-guessing.
 * Non-Web channels share the producer/persistence path, but do not consume the
 * rich Web timeline contract.
 *
 * The inference is deliberately identical to the UI's legacy `inferMessageLocale`
 * so migrated sessions and live turns agree byte-for-byte. It is pure and cheap:
 *  - Japanese kana / Korean Hangul present → undefined (not a locale we localize
 *    to; the caller keeps its default rather than mislabelling CJK as Chinese).
 *  - Han characters present → 'zh-CN'.
 *  - Latin letters present → 'en'.
 *  - Otherwise undefined (digits/punctuation/emoji only — no reliable signal).
 */

/** Locales MOZI localizes user-facing progress into. Mirrors the UI `Locale`. */
export type TurnLocale = 'en' | 'zh-CN';

// Ranges are kept identical to the UI's legacy `inferMessageLocale` so the
// carried locale matches what the frozen renderer would have guessed.
const KANA_OR_HANGUL = /[぀-ヿ가-힯]/u;
const HAN = /[一-鿿]/u;
const LATIN = /[A-Za-z]/;

/**
 * Infer the presentation locale from a turn's text. Returns `undefined` when
 * there is no reliable signal, so the caller decides its own fallback rather
 * than being handed a guess.
 */
export function inferTurnLocale(text?: string | null): TurnLocale | undefined {
  const value = (text ?? '').trim();
  if (!value) return undefined;
  // Japanese/Korean share Han characters with Chinese; if kana/Hangul appear the
  // text is not Simplified Chinese, so refuse rather than mislabel it 'zh-CN'.
  if (KANA_OR_HANGUL.test(value)) return undefined;
  if (HAN.test(value)) return 'zh-CN';
  if (LATIN.test(value)) return 'en';
  return undefined;
}

/** Type guard for a persisted/deserialized locale value. */
export function isTurnLocale(value: unknown): value is TurnLocale {
  return value === 'en' || value === 'zh-CN';
}
