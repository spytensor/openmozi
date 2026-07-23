import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isMattermostChatId,
  chatIdToMmChannelId,
  mmChannelIdToChatId,
  extractPost,
  normalizeMattermostEvent,
  MM_CHATID_PREFIX,
} from './mattermost.js';

describe('channels/mattermost', () => {
  describe('splitMessage', () => {
    it('keeps short text intact', () => {
      expect(splitMessage('ok')).toEqual(['ok']);
    });
    it('chunks on newlines for long text', () => {
      const body = `${'a'.repeat(8000)}\n${'b'.repeat(9000)}`;
      const chunks = splitMessage(body);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('chatId routing', () => {
    const valid = 'abcdefghij1234567890abcdef';
    it('recognises mattermost-prefixed values', () => {
      expect(isMattermostChatId(`${MM_CHATID_PREFIX}${valid}`)).toBe(true);
      expect(isMattermostChatId('slack:C1')).toBe(false);
    });
    it('round-trips channel ids', () => {
      expect(mmChannelIdToChatId(valid)).toBe(`${MM_CHATID_PREFIX}${valid}`);
      expect(chatIdToMmChannelId(`mattermost:${valid}`)).toBe(valid);
    });
    it('rejects short ids', () => {
      expect(chatIdToMmChannelId('mattermost:abc')).toBeNull();
    });
  });

  describe('extractPost', () => {
    it('parses JSON post field', () => {
      const data = { post: JSON.stringify({ id: 'p1', channel_id: 'c1', user_id: 'u1', message: 'hi' }) };
      expect(extractPost(data)).toMatchObject({ id: 'p1', message: 'hi' });
    });
    it('returns null on malformed JSON', () => {
      expect(extractPost({ post: 'not-json' })).toBeNull();
    });
    it('returns null when post field missing', () => {
      expect(extractPost({})).toBeNull();
    });
  });

  describe('normalizeMattermostEvent', () => {
    const channelId = 'abcdefghij1234567890abcdef';

    function postedEvent(overrides: Partial<{ userId: string; message: string; postType: string }> = {}) {
      return {
        event: 'posted' as const,
        data: {
          channel_name: 'town-square',
          sender_name: '@alice',
          post: JSON.stringify({
            id: 'p1',
            channel_id: channelId,
            user_id: overrides.userId ?? 'user-alice',
            message: overrides.message ?? 'hello',
            create_at: 1_700_000_000_000,
            type: overrides.postType ?? '',
          }),
        },
        broadcast: { channel_id: channelId },
      };
    }

    it('produces IncomingMessage for a posted message', () => {
      const out = normalizeMattermostEvent(postedEvent(), 'user-bot');
      expect(out).toMatchObject({
        channelType: 'mattermost',
        chatId: `mattermost:${channelId}`,
        userId: 'user-alice',
        text: 'hello',
      });
    });

    it('drops self-authored posts', () => {
      expect(normalizeMattermostEvent(postedEvent({ userId: 'user-bot' }), 'user-bot')).toBeNull();
    });

    it('drops system posts (join/leave/...)', () => {
      expect(normalizeMattermostEvent(postedEvent({ postType: 'system_join_channel' }), 'user-bot')).toBeNull();
    });

    it('drops non-posted events', () => {
      const event = { event: 'typing', data: {}, broadcast: {} } as never;
      expect(normalizeMattermostEvent(event, 'user-bot')).toBeNull();
    });

    it('detects / and ! commands', () => {
      const out = normalizeMattermostEvent(postedEvent({ message: '!status now' }), 'user-bot');
      expect(out?.command).toBe('status');
      expect(out?.commandArgs).toBe('now');
    });
  });
});
