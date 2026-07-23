import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  splitMessage,
  isLineChatId,
  chatIdToLineSourceId,
  lineSourceIdToChatId,
  verifyLineSignature,
  normalizeLineEvent,
  unsupportedLineMessageReply,
  LINE_CHATID_PREFIX,
} from './line.js';

describe('channels/line', () => {
  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('ok')).toEqual(['ok']);
    });
    it('respects 4900-char cap', () => {
      const body = 'a'.repeat(6000);
      const chunks = splitMessage(body);
      expect(chunks[0]).toHaveLength(4900);
      expect(chunks.length).toBe(2);
    });
  });

  describe('chatId routing', () => {
    const fake = 'U' + '0'.repeat(32);
    it('recognises line-prefixed chatIds', () => {
      expect(isLineChatId(`${LINE_CHATID_PREFIX}${fake}`)).toBe(true);
      expect(isLineChatId(`discord:${fake}`)).toBe(false);
    });

    it('round-trips valid source ids', () => {
      expect(lineSourceIdToChatId(fake)).toBe(`line:${fake}`);
      expect(chatIdToLineSourceId(`line:${fake}`)).toBe(fake);
    });

    it('rejects ids with the wrong prefix or length', () => {
      expect(chatIdToLineSourceId('line:short')).toBeNull();
      expect(chatIdToLineSourceId('line:X' + '0'.repeat(32))).toBeNull();
    });
  });

  describe('verifyLineSignature', () => {
    const secret = 'super-secret';
    const body = JSON.stringify({ events: [] });
    const signature = createHmac('SHA256', secret).update(body).digest('base64');

    it('accepts a matching signature', () => {
      expect(verifyLineSignature(body, secret, signature)).toBe(true);
    });
    it('rejects a mismatched signature', () => {
      expect(verifyLineSignature(body, secret, 'xxx')).toBe(false);
    });
    it('rejects an empty signature', () => {
      expect(verifyLineSignature(body, secret, undefined)).toBe(false);
    });
  });

  describe('normalizeLineEvent', () => {
    const userId = 'U' + '1'.repeat(32);

    function textEvent(text = 'hello', replyToken = 'r1') {
      return {
        type: 'message' as const,
        mode: 'active' as const,
        timestamp: 1_700_000_000_000,
        webhookEventId: 'w1',
        deliveryContext: { isRedelivery: false },
        replyToken,
        source: { type: 'user' as const, userId },
        message: { type: 'text' as const, id: 'm1', text, quoteToken: 'q1' },
      };
    }

    it('produces IncomingMessage for text', () => {
      const out = normalizeLineEvent(textEvent() as never);
      expect(out).toMatchObject({
        channelType: 'line',
        chatId: `line:${userId}`,
        userId,
        text: 'hello',
        isCommand: false,
      });
    });

    it('parses /commands', () => {
      const out = normalizeLineEvent(textEvent('/status now') as never);
      expect(out?.isCommand).toBe(true);
      expect(out?.command).toBe('status');
      expect(out?.commandArgs).toBe('now');
    });

    it('rejects non-text messages with an explicit user-facing reason', () => {
      const event = {
        ...textEvent(),
        message: { type: 'image', id: 'i1', contentProvider: { type: 'line' } },
      } as unknown;
      expect(normalizeLineEvent(event as never)).toBeNull();
      expect(unsupportedLineMessageReply(event as never)).toContain('supports text messages only');
    });

    it('drops events with empty text', () => {
      expect(normalizeLineEvent(textEvent('   ') as never)).toBeNull();
    });
  });
});
