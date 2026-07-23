import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens } from './token-counter.js';
import type { ChatMessage } from '../core/llm.js';

describe('memory/token-counter', () => {
  describe('estimateTokens', () => {
    it('returns ~1 token per 4 Latin characters', () => {
      // 20 chars → ceil(20 * 0.25) = 5
      expect(estimateTokens('12345678901234567890')).toBe(5);
    });

    it('rounds up partial tokens', () => {
      // 5 chars → ceil(5 * 0.25) = ceil(1.25) = 2
      expect(estimateTokens('hello')).toBe(2);
    });

    it('returns 1 for empty string (minimum 1)', () => {
      expect(estimateTokens('')).toBe(1);
    });

    it('handles long Latin text', () => {
      const text = 'a'.repeat(4000);
      expect(estimateTokens(text)).toBe(1000);
    });

    it('counts CJK characters at 1.5 tokens each', () => {
      // 4 CJK chars → ceil(4 * 1.5) = ceil(6) = 6
      expect(estimateTokens('你好世界')).toBe(6);
    });

    it('handles mixed Latin and CJK text', () => {
      // "hello" = 5 * 0.25 = 1.25
      // "你好" = 2 * 1.5 = 3.0
      // total = ceil(4.25) = 5
      expect(estimateTokens('hello你好')).toBe(5);
    });

    it('counts Japanese Hiragana/Katakana at 1.5 tokens each', () => {
      // 4 chars → ceil(4 * 1.5) = 6
      expect(estimateTokens('こんにちは'.slice(0, 4))).toBe(6);
    });

    it('counts Korean Hangul at 1.5 tokens each', () => {
      // 2 Hangul chars → ceil(2 * 1.5) = 3
      expect(estimateTokens('한글')).toBe(3);
    });

    it('estimates Chinese text much higher than naive length/4', () => {
      const chinese = '这是一段测试文本用来验证中文的token估算';
      const estimate = estimateTokens(chinese);
      // Should be much higher than naive length/4
      const naiveEstimate = Math.ceil(chinese.length / 4);
      expect(estimate).toBeGreaterThan(naiveEstimate);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('sums token estimates across messages with overhead', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '12345678' },   // 2 tokens content + 4 overhead
        { role: 'user', content: '1234' },          // 1 token content + 4 overhead
      ];
      // (4 + 2) + (4 + 1) = 11
      expect(estimateMessagesTokens(messages)).toBe(11);
    });

    it('returns 0 for empty array', () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it('includes per-message overhead', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '' },
      ];
      // 4 overhead + 1 content (minimum 1 for empty string)
      expect(estimateMessagesTokens(messages)).toBe(5);
    });

    it('accounts for CJK content in messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '你好世界' }, // 6 tokens + 4 overhead = 10
      ];
      expect(estimateMessagesTokens(messages)).toBe(10);
    });
  });
});
