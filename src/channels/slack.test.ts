import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isSlackChatId,
  chatIdToSlackChannelId,
  slackChannelIdToChatId,
  normalizeSlackMessage,
  SLACK_CHATID_PREFIX,
  SLACK_MAX_LENGTH,
} from './slack.js';

describe('channels/slack', () => {
  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('hi')).toEqual(['hi']);
    });
    it('splits on newline when available', () => {
      const body = `${'a'.repeat(3200)}\n${'b'.repeat(500)}`;
      const chunks = splitMessage(body);
      expect(chunks.length).toBe(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_LENGTH);
      }
    });
    it('hard-cuts when no whitespace exists', () => {
      const body = 'z'.repeat(5000);
      const chunks = splitMessage(body);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toHaveLength(SLACK_MAX_LENGTH);
    });
  });

  describe('chatId routing', () => {
    it('recognises only slack-prefixed values', () => {
      expect(isSlackChatId('slack:C12345678')).toBe(true);
      expect(isSlackChatId('discord:123')).toBe(false);
    });

    it('round-trips channel ids', () => {
      expect(slackChannelIdToChatId('C123ABC456')).toBe(`${SLACK_CHATID_PREFIX}C123ABC456`);
      expect(chatIdToSlackChannelId('slack:C123ABC456')).toBe('C123ABC456');
      expect(chatIdToSlackChannelId('slack:D123ABC456')).toBe('D123ABC456');
    });

    it('rejects malformed slack channel ids', () => {
      expect(chatIdToSlackChannelId('slack:lowercase')).toBeNull();
      expect(chatIdToSlackChannelId('slack:SHORT')).toBeNull();
    });
  });

  describe('normalizeSlackMessage', () => {
    const base = {
      type: 'message',
      channel: 'C123ABC456',
      user: 'U1',
      text: 'hi',
      ts: '1700000000.000100',
    } as const;

    it('produces IncomingMessage for plain text', () => {
      const out = normalizeSlackMessage({ ...base }, 'BOT');
      expect(out).toMatchObject({
        channelType: 'slack',
        chatId: 'slack:C123ABC456',
        userId: 'U1',
        text: 'hi',
        isCommand: false,
      });
    });

    it('drops non-message events', () => {
      expect(normalizeSlackMessage({ ...base, type: 'reaction_added' }, 'BOT')).toBeNull();
    });

    it('drops message edits and joins', () => {
      expect(normalizeSlackMessage({ ...base, subtype: 'message_changed' }, 'BOT')).toBeNull();
      expect(normalizeSlackMessage({ ...base, subtype: 'channel_join' }, 'BOT')).toBeNull();
    });

    it('drops bot echoes', () => {
      expect(normalizeSlackMessage({ ...base, bot_id: 'B1' }, 'BOT')).toBeNull();
      expect(normalizeSlackMessage({ ...base, user: 'BOT' }, 'BOT')).toBeNull();
    });

    it('parses / and ! as commands', () => {
      const out1 = normalizeSlackMessage({ ...base, text: '/status' }, 'BOT');
      const out2 = normalizeSlackMessage({ ...base, text: '!help me' }, 'BOT');
      expect(out1?.isCommand).toBe(true);
      expect(out1?.command).toBe('status');
      expect(out2?.isCommand).toBe(true);
      expect(out2?.command).toBe('help');
      expect(out2?.commandArgs).toBe('me');
    });

    it('preserves file_share subtype (images etc.)', () => {
      const out = normalizeSlackMessage({ ...base, subtype: 'file_share', text: 'caption' }, 'BOT');
      expect(out?.text).toBe('caption');
    });
  });
});
