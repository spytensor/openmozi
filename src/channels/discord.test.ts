import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isDiscordChatId,
  chatIdToChannelId,
  channelIdToChatId,
  normalizeDiscordMessage,
  DISCORD_CHATID_PREFIX,
} from './discord.js';

describe('channels/discord', () => {
  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('hello')).toEqual(['hello']);
    });

    it('splits at newline boundary when possible', () => {
      const body = `${'a'.repeat(1800)}\n${'b'.repeat(400)}`;
      const chunks = splitMessage(body);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBeLessThanOrEqual(2000);
      expect(chunks[0].endsWith('a')).toBe(true);
      expect(chunks[1].startsWith('b')).toBe(true);
    });

    it('splits at space boundary when no newline is close', () => {
      const body = 'x '.repeat(1200);
      const chunks = splitMessage(body);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    });

    it('falls back to hard cut when no whitespace exists', () => {
      const body = 'a'.repeat(3500);
      const chunks = splitMessage(body);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toHaveLength(2000);
      expect(chunks[1]).toHaveLength(1500);
    });
  });

  describe('chatId routing', () => {
    it('recognises only discord-prefixed values', () => {
      expect(isDiscordChatId('discord:123')).toBe(true);
      expect(isDiscordChatId('telegram:123')).toBe(false);
      expect(isDiscordChatId('123')).toBe(false);
    });

    it('round-trips channelId <-> chatId', () => {
      const id = '987654321098765432';
      expect(channelIdToChatId(id)).toBe(`${DISCORD_CHATID_PREFIX}${id}`);
      expect(chatIdToChannelId(channelIdToChatId(id))).toBe(id);
    });

    it('rejects malformed chatIds', () => {
      expect(chatIdToChannelId('discord:not-numeric')).toBeNull();
      expect(chatIdToChannelId('telegram:123')).toBeNull();
    });
  });

  describe('normalizeDiscordMessage', () => {
    function makeDiscordMessage(overrides: Record<string, unknown> = {}) {
      return {
        author: { id: 'user-1', bot: false, username: 'alice', globalName: null },
        channelId: '111222333',
        content: 'hi',
        createdTimestamp: 1_700_000_000_000,
        attachments: new Map(),
        ...overrides,
      } as unknown as Parameters<typeof normalizeDiscordMessage>[0];
    }

    it('produces IncomingMessage shape for plain text', () => {
      const out = normalizeDiscordMessage(makeDiscordMessage(), 'bot-id');
      expect(out).toMatchObject({
        channelType: 'discord',
        chatId: 'discord:111222333',
        userId: 'user-1',
        username: 'alice',
        text: 'hi',
        isCommand: false,
      });
      expect(out?.timestamp).toBeInstanceOf(Date);
    });

    it('detects /commands and splits args', () => {
      const out = normalizeDiscordMessage(
        makeDiscordMessage({ content: '/status verbose trace' }),
        'bot-id',
      );
      expect(out?.isCommand).toBe(true);
      expect(out?.command).toBe('status');
      expect(out?.commandArgs).toBe('verbose trace');
    });

    it('drops bot authors', () => {
      const out = normalizeDiscordMessage(
        makeDiscordMessage({ author: { id: 'x', bot: true, username: 'botty', globalName: null } }),
        'bot-id',
      );
      expect(out).toBeNull();
    });

    it('drops our own bot echo messages', () => {
      const out = normalizeDiscordMessage(
        makeDiscordMessage({ author: { id: 'bot-id', bot: false, username: 'self', globalName: null } }),
        'bot-id',
      );
      expect(out).toBeNull();
    });

    it('drops empty text with no attachments', () => {
      const out = normalizeDiscordMessage(
        makeDiscordMessage({ content: '   ' }),
        'bot-id',
      );
      expect(out).toBeNull();
    });
  });
});
