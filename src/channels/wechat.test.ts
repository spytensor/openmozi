import { describe, it, expect } from 'vitest';
import { normalizeILinkMessage, splitMessage, isWeChatUserId, generateWeChatUin } from './wechat.js';

describe('channels/wechat (iLink Bot)', () => {
  // ── generateWeChatUin ─────────────────────────────────────────────

  describe('generateWeChatUin', () => {
    it('returns a base64-encoded string', () => {
      const uin = generateWeChatUin();
      expect(typeof uin).toBe('string');
      expect(uin.length).toBeGreaterThan(0);
      // Should be valid base64
      const decoded = Buffer.from(uin, 'base64').toString('utf8');
      expect(/^\d+$/.test(decoded)).toBe(true);
    });

    it('generates different values on each call', () => {
      const values = new Set(Array.from({ length: 10 }, () => generateWeChatUin()));
      // With 4 bytes of randomness, collisions are extremely unlikely
      expect(values.size).toBeGreaterThan(1);
    });
  });

  // ── normalizeILinkMessage ─────────────────────────────────────────

  describe('normalizeILinkMessage', () => {
    const baseMsg = {
      msg_type: 1,
      context_token: 'ctx_abc123',
      from_user: 'user_abc123def456ghi789',
      create_time: 1700000000,
    };

    it('normalizes a text message', () => {
      const result = normalizeILinkMessage({ ...baseMsg, content: 'Hello MOZI' });
      expect(result).not.toBeNull();
      expect(result!.channelType).toBe('wechat');
      expect(result!.chatId).toBe('user_abc123def456ghi789');
      expect(result!.userId).toBe('user_abc123def456ghi789');
      expect(result!.text).toBe('Hello MOZI');
      expect(result!.isCommand).toBe(false);
    });

    it('normalizes a command message', () => {
      const result = normalizeILinkMessage({ ...baseMsg, content: '/help arg1 arg2' });
      expect(result).not.toBeNull();
      expect(result!.isCommand).toBe(true);
      expect(result!.command).toBe('help');
      expect(result!.commandArgs).toBe('arg1 arg2');
    });

    it('normalizes a command without arguments', () => {
      const result = normalizeILinkMessage({ ...baseMsg, content: '/start' });
      expect(result).not.toBeNull();
      expect(result!.isCommand).toBe(true);
      expect(result!.command).toBe('start');
      expect(result!.commandArgs).toBe('');
    });

    it('normalizes a voice message with recognition (msg_type=3)', () => {
      const result = normalizeILinkMessage({
        ...baseMsg,
        msg_type: 3,
        content: '帮我查一下天气',
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('帮我查一下天气');
    });

    it('returns null for voice without content', () => {
      const result = normalizeILinkMessage({
        ...baseMsg,
        msg_type: 3,
      });
      expect(result).toBeNull();
    });

    it('returns null for unsupported message types (image=2, file=4, video=5)', () => {
      for (const msgType of [2, 4, 5]) {
        const result = normalizeILinkMessage({
          ...baseMsg,
          msg_type: msgType,
          content: 'some content',
        });
        expect(result).toBeNull();
      }
    });

    it('returns null for empty/whitespace text', () => {
      expect(normalizeILinkMessage({ ...baseMsg, content: '' })).toBeNull();
      expect(normalizeILinkMessage({ ...baseMsg, content: '   ' })).toBeNull();
    });

    it('parses timestamp correctly', () => {
      const result = normalizeILinkMessage({ ...baseMsg, content: 'test' });
      expect(result).not.toBeNull();
      expect(result!.timestamp).toEqual(new Date(1700000000 * 1000));
    });

    it('handles missing from_user gracefully', () => {
      const result = normalizeILinkMessage({
        msg_type: 1,
        context_token: 'ctx_abc',
        content: 'hello',
      });
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('unknown');
    });
  });

  // ── splitMessage ──────────────────────────────────────────────────

  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('hello')).toEqual(['hello']);
    });

    it('returns single chunk at exactly max length', () => {
      const text = 'a'.repeat(2048);
      expect(splitMessage(text)).toEqual([text]);
    });

    it('splits long text into multiple chunks', () => {
      const text = 'a'.repeat(3000);
      const chunks = splitMessage(text);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('')).toBe(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2048);
      }
    });

    it('prefers splitting at newlines', () => {
      const line = 'x'.repeat(1000);
      const text = `${line}\n${line}\n${line}`;
      const chunks = splitMessage(text);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(`${line}\n${line}`);
    });

    it('falls back to space split when no good newline', () => {
      const word = 'x'.repeat(100);
      const words = Array(25).fill(word).join(' '); // ~2525 chars
      const chunks = splitMessage(words);
      expect(chunks.length).toBe(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2048);
      }
    });

    it('hard cuts when no space or newline available', () => {
      const text = 'x'.repeat(5000);
      const chunks = splitMessage(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2048);
      }
    });

    it('respects custom maxLength', () => {
      const text = 'a'.repeat(100);
      const chunks = splitMessage(text, 30);
      expect(chunks.length).toBe(4); // 30+30+30+10
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(30);
      }
    });
  });

  // ── isWeChatUserId ────────────────────────────────────────────────

  describe('isWeChatUserId', () => {
    it('matches valid WeChat user IDs (28 chars)', () => {
      expect(isWeChatUserId('oABCDEFGH1234567890abcdefgh')).toBe(true);
    });

    it('matches user IDs of various valid lengths (20-40)', () => {
      expect(isWeChatUserId('a'.repeat(20))).toBe(true);
      expect(isWeChatUserId('a'.repeat(28))).toBe(true);
      expect(isWeChatUserId('a'.repeat(40))).toBe(true);
    });

    it('rejects too-short strings', () => {
      expect(isWeChatUserId('abc')).toBe(false);
      expect(isWeChatUserId('a'.repeat(19))).toBe(false);
    });

    it('rejects too-long strings', () => {
      expect(isWeChatUserId('a'.repeat(41))).toBe(false);
    });

    it('rejects strings with special chars', () => {
      expect(isWeChatUserId('oABCDEFGH1234567890!@#$%^&*')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isWeChatUserId('')).toBe(false);
    });

    it('does not match Telegram numeric IDs', () => {
      expect(isWeChatUserId('123456789')).toBe(false);
    });

    it('allows hyphens and underscores', () => {
      expect(isWeChatUserId('oABC_DEF-1234567890abcdefgh')).toBe(true);
    });
  });
});
