import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isMatrixChatId,
  matrixRoomIdToChatId,
  chatIdToMatrixRoomId,
  normalizeMatrixEvent,
  MATRIX_CHATID_PREFIX,
  MATRIX_MAX_LENGTH,
} from './matrix.js';

describe('channels/matrix', () => {
  describe('splitMessage', () => {
    it('keeps short text as one chunk', () => {
      expect(splitMessage('hi')).toEqual(['hi']);
    });
    it('chunks at maxLength', () => {
      const body = 'a'.repeat(MATRIX_MAX_LENGTH + 500);
      const chunks = splitMessage(body);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toHaveLength(MATRIX_MAX_LENGTH);
    });
  });

  describe('chatId routing', () => {
    it('recognises matrix-prefixed values', () => {
      expect(isMatrixChatId(`${MATRIX_CHATID_PREFIX}!abc:matrix.org`)).toBe(true);
      expect(isMatrixChatId('slack:C1')).toBe(false);
    });
    it('round-trips valid room ids', () => {
      expect(matrixRoomIdToChatId('!abc:matrix.org')).toBe(`${MATRIX_CHATID_PREFIX}!abc:matrix.org`);
      expect(chatIdToMatrixRoomId('matrix:!abc:matrix.org')).toBe('!abc:matrix.org');
    });
    it('rejects malformed room ids', () => {
      expect(chatIdToMatrixRoomId('matrix:invalid')).toBeNull();
      expect(chatIdToMatrixRoomId('matrix:abc:matrix.org')).toBeNull();
    });
  });

  describe('normalizeMatrixEvent', () => {
    function textEvent(overrides: Partial<{ sender: string; text: string; roomId: string; type: string; msgtype: string }> = {}) {
      const sender = overrides.sender ?? '@alice:matrix.org';
      const text = overrides.text ?? 'hi';
      const roomId = overrides.roomId ?? '!room:matrix.org';
      const type = overrides.type ?? 'm.room.message';
      const msgtype = overrides.msgtype ?? 'm.text';
      return {
        getType: () => type,
        getRoomId: () => roomId,
        getSender: () => sender,
        getContent: () => ({ msgtype, body: text }),
        getTs: () => 1_700_000_000_000,
      };
    }

    it('produces IncomingMessage for text', () => {
      const out = normalizeMatrixEvent(textEvent(), '@mozi:matrix.org');
      expect(out).toMatchObject({
        channelType: 'matrix',
        chatId: 'matrix:!room:matrix.org',
        userId: '@alice:matrix.org',
        text: 'hi',
      });
    });

    it('drops events from the bot itself', () => {
      expect(normalizeMatrixEvent(textEvent({ sender: '@mozi:matrix.org' }), '@mozi:matrix.org')).toBeNull();
    });

    it('drops non-message types', () => {
      expect(normalizeMatrixEvent(textEvent({ type: 'm.room.member' }), '@mozi:matrix.org')).toBeNull();
    });

    it('drops non-text msgtypes', () => {
      expect(normalizeMatrixEvent(textEvent({ msgtype: 'm.image' }), '@mozi:matrix.org')).toBeNull();
    });

    it('detects / and ! commands', () => {
      expect(normalizeMatrixEvent(textEvent({ text: '/status' }), '@mozi:matrix.org')?.command).toBe('status');
      expect(normalizeMatrixEvent(textEvent({ text: '!help me' }), '@mozi:matrix.org')?.commandArgs).toBe('me');
    });
  });
});
