import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isIrcChatId,
  ircTargetToChatId,
  chatIdToIrcTarget,
  parseIrcChannels,
  normalizeIrcMessage,
  IRC_CHATID_PREFIX,
} from './irc.js';

describe('channels/irc', () => {
  describe('splitMessage', () => {
    it('keeps short text as one chunk', () => {
      expect(splitMessage('hi')).toEqual(['hi']);
    });
    it('breaks on newlines first when text exceeds maxLength', () => {
      const body = `${'a'.repeat(300)}\n${'b'.repeat(300)}`;
      const chunks = splitMessage(body);
      expect(chunks).toEqual(['a'.repeat(300), 'b'.repeat(300)]);
    });
    it('splits long single lines on word boundaries', () => {
      const body = 'word '.repeat(200);
      const chunks = splitMessage(body);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    });
  });

  describe('chatId routing', () => {
    it('recognises irc-prefixed values', () => {
      expect(isIrcChatId(`${IRC_CHATID_PREFIX}#mozi`)).toBe(true);
      expect(isIrcChatId('slack:C1')).toBe(false);
    });
    it('lowercases targets on the way in', () => {
      expect(ircTargetToChatId('#MOZI')).toBe(`${IRC_CHATID_PREFIX}#mozi`);
    });
    it('round-trips target -> chatId -> target', () => {
      expect(chatIdToIrcTarget(ircTargetToChatId('#chan'))).toBe('#chan');
      expect(chatIdToIrcTarget(ircTargetToChatId('Alice'))).toBe('alice');
    });
    it('rejects empty suffix', () => {
      expect(chatIdToIrcTarget('irc:')).toBeNull();
    });
  });

  describe('parseIrcChannels', () => {
    it('parses comma-separated values', () => {
      expect(parseIrcChannels('#a, #b , #c ')).toEqual(['#a', '#b', '#c']);
    });
    it('returns empty for undefined', () => {
      expect(parseIrcChannels(undefined)).toEqual([]);
    });
  });

  describe('normalizeIrcMessage', () => {
    it('routes direct messages back to the sender', () => {
      const out = normalizeIrcMessage(
        { nick: 'alice', target: 'mozi-bot', message: 'hi' } as never,
        'mozi-bot',
      );
      expect(out?.chatId).toBe(`${IRC_CHATID_PREFIX}alice`);
    });
    it('uses the channel as chatId for channel messages', () => {
      const out = normalizeIrcMessage(
        { nick: 'alice', target: '#mozi', message: 'hi' } as never,
        'mozi-bot',
      );
      expect(out?.chatId).toBe(`${IRC_CHATID_PREFIX}#mozi`);
    });
    it('drops messages the bot sent itself', () => {
      const out = normalizeIrcMessage(
        { nick: 'mozi-bot', target: '#mozi', message: 'hi' } as never,
        'mozi-bot',
      );
      expect(out).toBeNull();
    });
    it('drops empty bodies', () => {
      const out = normalizeIrcMessage(
        { nick: 'alice', target: '#mozi', message: '   ' } as never,
        'mozi-bot',
      );
      expect(out).toBeNull();
    });
    it('detects / and ! commands', () => {
      const out = normalizeIrcMessage(
        { nick: 'alice', target: '#mozi', message: '!help me' } as never,
        'mozi-bot',
      );
      expect(out?.isCommand).toBe(true);
      expect(out?.command).toBe('help');
      expect(out?.commandArgs).toBe('me');
    });
  });
});
