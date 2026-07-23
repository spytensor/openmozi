/** Shared lexical tokenization primitive for memory consumers. */

export interface WordSegment {
  segment: string;
  isWordLike?: boolean;
}

export interface WordSegmenter {
  segment(input: string): Iterable<WordSegment>;
}

const TOKEN_RUN_RE = /[a-z0-9]+|\p{Script=Han}+/gu;
const HAN_TOKEN_RE = /^\p{Script=Han}+$/u;

let cachedSegmenter: WordSegmenter | null | undefined;
let segmenterOverride: WordSegmenter | null | undefined;

function getSegmenter(): WordSegmenter | null {
  if (segmenterOverride !== undefined) return segmenterOverride;
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    cachedSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

function codePoints(value: string): string[] {
  return [...value];
}

function hanBigrams(run: string): string[] {
  const points = codePoints(run);
  if (points.length < 2) return points;
  return points.slice(0, -1).map((point, index) => point + points[index + 1]);
}

function segmentHanRun(run: string): string[] {
  const points = codePoints(run);
  const segmenter = getSegmenter();
  if (!segmenter) return hanBigrams(run);

  const segmented = [...segmenter.segment(run)]
    .filter(part => part.isWordLike !== false && isHanToken(part.segment))
    .map(part => part.segment);
  if (segmented.length === 0) return hanBigrams(run);
  if (points.length >= 2 && segmented.every(part => hanTokenLength(part) === 1)) {
    return hanBigrams(run);
  }
  if (points.length >= 4 && segmented.length === 1 && segmented[0] === run) {
    return hanBigrams(run);
  }
  return segmented;
}

/** Lowercase, ordered, de-duplicated ASCII/digit and locale-aware Han tokens. */
export function tokenizeText(text: string): string[] {
  const runs = text.toLowerCase().match(TOKEN_RUN_RE) ?? [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const parts = isHanToken(run) ? segmentHanRun(run) : [run];
    for (const part of parts) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      tokens.push(part);
    }
  }
  return tokens;
}

export function isHanToken(token: string): boolean {
  return HAN_TOKEN_RE.test(token);
}

export function hanTokenLength(token: string): number {
  return isHanToken(token) ? codePoints(token).length : 0;
}

/** Test-only override. `null` forces deterministic fallback; `undefined` resets. */
export function __setWordSegmenterForTests(segmenter?: WordSegmenter | null): void {
  segmenterOverride = segmenter;
  cachedSegmenter = undefined;
}
