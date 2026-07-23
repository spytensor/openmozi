import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isTwitchChatId,
  twitchChannelToChatId,
  chatIdToTwitchChannel,
  parseTwitchChannels,
  normalizeTwitchMessage,
  TWITCH_CHATID_PREFIX,
} from './twitch.js';

describe('channels/twitch', () => {
  describe('splitMessage', () => {
    it('keeps short text intact', () => {
      expect(splitMessage('hello')).toEqual(['hello']);
    });
    it('splits long single lines on spaces', () => {
      const body = 'word '.repeat(120);
      const chunks = splitMessage(body);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(450);
    });
  });

  describe('chatId routing', () => {
    it('recognises twitch-prefixed values', () => {
      expect(isTwitchChatId(`${TWITCH_CHATID_PREFIX}alice`)).toBe(true);
      expect(isTwitchChatId('slack:C1')).toBe(false);
    });
    it('normalises channel form on the way in', () => {
      expect(twitchChannelToChatId('#Alice')).toBe(`${TWITCH_CHATID_PREFIX}alice`);
      expect(twitchChannelToChatId('Alice')).toBe(`${TWITCH_CHATID_PREFIX}alice`);
    });
    it('returns #channel form on the way out', () => {
      expect(chatIdToTwitchChannel('twitch:alice')).toBe('#alice');
    });
    it('rejects invalid logins', () => {
      expect(chatIdToTwitchChannel('twitch:ab')).toBeNull();
      expect(chatIdToTwitchChannel('twitch:Invalid With Spaces')).toBeNull();
    });
  });

  describe('parseTwitchChannels', () => {
    it('parses comma-separated logins with and without #', () => {
      expect(parseTwitchChannels('#alice, bob ,  CAROL ')).toEqual(['#alice', '#bob', '#carol']);
    });
    it('returns empty for undefined', () => {
      expect(parseTwitchChannels(undefined)).toEqual([]);
    });
  });

  describe('normalizeTwitchMessage', () => {
    const userstate = { 'user-id': 'u1', username: 'alice', 'display-name': 'Alice', 'message-type': 'chat' };

    it('produces IncomingMessage for a chat message', () => {
      const out = normalizeTwitchMessage('#stream', userstate, 'hi', false, 'mozi_bot');
      expect(out).toMatchObject({
        channelType: 'twitch',
        chatId: 'twitch:stream',
        userId: 'u1',
        username: 'Alice',
      });
    });
    it('drops self-echo (self=true)', () => {
      expect(normalizeTwitchMessage('#stream', userstate, 'hi', true, 'mozi_bot')).toBeNull();
    });
    it('drops self-login username', () => {
      const selfState = { ...userstate, username: 'mozi_bot' };
      expect(normalizeTwitchMessage('#stream', selfState, 'hi', false, 'mozi_bot')).toBeNull();
    });
    it('drops empty text', () => {
      expect(normalizeTwitchMessage('#stream', userstate, '   ', false, 'mozi_bot')).toBeNull();
    });
    it('detects ! commands', () => {
      const out = normalizeTwitchMessage('#stream', userstate, '!lurk quietly', false, 'mozi_bot');
      expect(out?.command).toBe('lurk');
      expect(out?.commandArgs).toBe('quietly');
    });
  });
});
