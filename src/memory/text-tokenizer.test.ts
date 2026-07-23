import { afterEach, describe, expect, it } from 'vitest';
import {
  __setWordSegmenterForTests,
  hanTokenLength,
  isHanToken,
  tokenizeText,
  type WordSegmenter,
} from './text-tokenizer.js';

afterEach(() => {
  __setWordSegmenterForTests(undefined);
});

describe('memory/text-tokenizer', () => {
  it('keeps ASCII tokens ordered, lowercased, and de-duplicated', () => {
    expect(tokenizeText('TypeScript 22, typescript FASTIFY')).toEqual([
      'typescript',
      '22',
      'fastify',
    ]);
  });

  it('segments mixed Chinese text into meaningful multi-character words', () => {
    const tokens = tokenizeText('我的报告格式偏好 TypeScript!');
    expect(tokens).toContain('报告');
    expect(tokens).toContain('格式');
    expect(tokens).toContain('偏好');
    expect(tokens).toContain('typescript');
  });

  it('uses code-point-safe Han bigrams when Intl.Segmenter is unavailable', () => {
    __setWordSegmenterForTests(null);
    expect(tokenizeText('报告格式')).toEqual(['报告', '告格', '格式']);
    expect(tokenizeText('\u{20000}报告')).toEqual(['\u{20000}报', '报告']);
    expect(tokenizeText('㐀报告')).toEqual(['㐀报', '报告']);
  });

  it('uses bigrams when a segmenter emits only single-Han tokens', () => {
    const perCharacterSegmenter: WordSegmenter = {
      segment(input) {
        return [...input].map(segment => ({ segment, isWordLike: true }));
      },
    };
    __setWordSegmenterForTests(perCharacterSegmenter);
    expect(tokenizeText('㐀报')).toEqual(['㐀报']);
    expect(tokenizeText('\u{20000}报')).toEqual(['\u{20000}报']);
    expect(tokenizeText('龘靐')).toEqual(['龘靐']);
  });

  it('preserves two-code-point Han queries under the current Node 22 segmenter', () => {
    expect(tokenizeText('㐀报')).toEqual(['㐀报']);
    expect(tokenizeText('\u{20000}报')).toEqual(['\u{20000}报']);
  });

  it('falls back to bigrams when a segmenter leaves a long Han run whole', () => {
    const wholeRunSegmenter: WordSegmenter = {
      segment(input) {
        return [{ segment: input, isWordLike: true }];
      },
    };
    __setWordSegmenterForTests(wholeRunSegmenter);
    expect(tokenizeText('报告格式')).toEqual(['报告', '告格', '格式']);
  });

  it('handles empty and punctuation-only input', () => {
    expect(tokenizeText('')).toEqual([]);
    expect(tokenizeText('，。！？---')).toEqual([]);
  });

  it('recognizes Han tokens by code point rather than UTF-16 unit', () => {
    expect(isHanToken('\u{20000}报')).toBe(true);
    expect(hanTokenLength('\u{20000}报')).toBe(2);
    expect(hanTokenLength('report')).toBe(0);
  });
});
