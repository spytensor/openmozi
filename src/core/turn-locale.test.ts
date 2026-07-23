import { describe, it, expect } from 'vitest';
import { inferTurnLocale, isTurnLocale } from './turn-locale.js';

describe('inferTurnLocale (Issue #628 authoritative locale)', () => {
  it('classifies Simplified Chinese prompts as zh-CN', () => {
    expect(inferTurnLocale('帮我查一下天气')).toBe('zh-CN');
    expect(inferTurnLocale('总结这份报告')).toBe('zh-CN');
  });

  it('classifies English prompts as en', () => {
    expect(inferTurnLocale('summarize this report')).toBe('en');
    expect(inferTurnLocale('Run the tests, please.')).toBe('en');
  });

  it('keeps a Chinese prompt Chinese even when it embeds English tool nouns', () => {
    // The acceptance criterion: a Chinese prompt whose text quotes English
    // identifiers stays zh-CN because Han characters are present.
    expect(inferTurnLocale('用 Python 写一个 web_search 脚本')).toBe('zh-CN');
  });

  it('refuses Japanese and Korean rather than mislabeling them zh-CN', () => {
    expect(inferTurnLocale('こんにちは、元気ですか')).toBeUndefined(); // kana present
    expect(inferTurnLocale('안녕하세요')).toBeUndefined(); // hangul present
  });

  it('returns undefined when there is no reliable language signal', () => {
    expect(inferTurnLocale('')).toBeUndefined();
    expect(inferTurnLocale('   ')).toBeUndefined();
    expect(inferTurnLocale('12345 !!! ??? ...')).toBeUndefined();
    expect(inferTurnLocale(null)).toBeUndefined();
    expect(inferTurnLocale(undefined)).toBeUndefined();
  });

  it('is a pure function of its input (deterministic)', () => {
    const value = '请把这段代码重构一下';
    expect(inferTurnLocale(value)).toBe(inferTurnLocale(value));
  });
});

describe('isTurnLocale', () => {
  it('accepts only the supported locales', () => {
    expect(isTurnLocale('en')).toBe(true);
    expect(isTurnLocale('zh-CN')).toBe(true);
    expect(isTurnLocale('fr')).toBe(false);
    expect(isTurnLocale(undefined)).toBe(false);
    expect(isTurnLocale(null)).toBe(false);
  });
});
