import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isFeishuChatId,
  chatIdToFeishuChatId,
  feishuChatIdToChatId,
  extractFeishuText,
  normalizeFeishuMessage,
  FEISHU_CHATID_PREFIX,
} from './feishu.js';

describe('channels/feishu', () => {
  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('hi')).toEqual(['hi']);
    });
    it('caps at 3000 chars by default', () => {
      const body = 'a'.repeat(5000);
      const chunks = splitMessage(body);
      expect(chunks[0].length).toBeLessThanOrEqual(3000);
    });
  });

  describe('chatId routing', () => {
    it('recognises feishu-prefixed values', () => {
      expect(isFeishuChatId(`${FEISHU_CHATID_PREFIX}oc_abc`)).toBe(true);
      expect(isFeishuChatId('slack:C123')).toBe(false);
    });

    it('round-trips chat ids', () => {
      expect(feishuChatIdToChatId('oc_abc123')).toBe(`${FEISHU_CHATID_PREFIX}oc_abc123`);
      expect(chatIdToFeishuChatId(`${FEISHU_CHATID_PREFIX}oc_abc123`)).toBe('oc_abc123');
    });

    it('returns null for the empty suffix', () => {
      expect(chatIdToFeishuChatId('feishu:')).toBeNull();
    });
  });

  describe('extractFeishuText', () => {
    it('parses JSON text content', () => {
      expect(extractFeishuText(JSON.stringify({ text: 'hello' }))).toBe('hello');
    });
    it('returns empty string on malformed JSON', () => {
      expect(extractFeishuText('not-json')).toBe('');
    });
    it('returns empty string when field missing', () => {
      expect(extractFeishuText(JSON.stringify({ other: 'x' }))).toBe('');
    });
  });

  describe('normalizeFeishuMessage', () => {
    function textEvent(overrides: Record<string, unknown> = {}) {
      return {
        event: {
          message: {
            chat_id: 'oc_chat_1',
            message_id: 'om_1',
            create_time: '1700000000000',
            message_type: 'text',
            content: JSON.stringify({ text: 'hi' }),
          },
          sender: {
            sender_id: { open_id: 'ou_1' },
            sender_type: 'user',
          },
          ...overrides,
        },
      };
    }

    it('produces IncomingMessage for a user text', () => {
      const out = normalizeFeishuMessage(textEvent());
      expect(out).toMatchObject({
        channelType: 'feishu',
        chatId: 'feishu:oc_chat_1',
        userId: 'ou_1',
        text: 'hi',
      });
    });

    it('detects /commands', () => {
      const out = normalizeFeishuMessage(
        textEvent({
          message: {
            chat_id: 'oc_chat_1',
            message_id: 'om_1',
            create_time: '1700000000000',
            message_type: 'text',
            content: JSON.stringify({ text: '/status now' }),
          },
        }),
      );
      expect(out?.isCommand).toBe(true);
      expect(out?.command).toBe('status');
      expect(out?.commandArgs).toBe('now');
    });

    it('drops non-text messages', () => {
      const out = normalizeFeishuMessage(
        textEvent({
          message: {
            chat_id: 'oc_chat_1',
            message_id: 'om_1',
            create_time: '1700000000000',
            message_type: 'image',
            content: JSON.stringify({ image_key: 'k' }),
          },
        }),
      );
      expect(out).toBeNull();
    });

    it('drops bot senders', () => {
      const out = normalizeFeishuMessage(
        textEvent({
          sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' },
        }),
      );
      expect(out).toBeNull();
    });
  });
});
