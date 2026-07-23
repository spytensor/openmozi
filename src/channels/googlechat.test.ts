import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isGoogleChatId,
  resolveWebhookUrl,
  hasAnyWebhookConfigured,
  GCHAT_CHATID_PREFIX,
  GCHAT_MAX_LENGTH,
} from './googlechat.js';

describe('channels/googlechat', () => {
  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('hi')).toEqual(['hi']);
    });
    it('caps at 4000 chars', () => {
      const body = 'a'.repeat(5500);
      const chunks = splitMessage(body);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toHaveLength(GCHAT_MAX_LENGTH);
    });
  });

  describe('chatId routing', () => {
    it('recognises gchat-prefixed values', () => {
      expect(isGoogleChatId(`${GCHAT_CHATID_PREFIX}team`)).toBe(true);
      expect(isGoogleChatId('slack:C1')).toBe(false);
    });
  });

  describe('resolveWebhookUrl', () => {
    it('maps gchat:<key> to GCHAT_WEBHOOK_<UPPERCASE_ALPHANUMERIC>', () => {
      expect(resolveWebhookUrl('gchat:team-ops', { GCHAT_WEBHOOK_TEAMOPS: 'https://x' })).toBe('https://x');
    });
    it('returns null when no matching env var exists', () => {
      expect(resolveWebhookUrl('gchat:missing', {})).toBeNull();
    });
    it('returns null for the empty suffix', () => {
      expect(resolveWebhookUrl('gchat:', { GCHAT_WEBHOOK_: 'x' })).toBeNull();
    });
    it('rejects non-gchat prefixes', () => {
      expect(resolveWebhookUrl('telegram:1', { GCHAT_WEBHOOK_TELEGRAM1: 'x' })).toBeNull();
    });
  });

  describe('hasAnyWebhookConfigured', () => {
    it('returns true when at least one GCHAT_WEBHOOK_* has a value', () => {
      expect(hasAnyWebhookConfigured({ GCHAT_WEBHOOK_OPS: 'https://x' })).toBe(true);
    });
    it('returns false for empty/whitespace values', () => {
      expect(hasAnyWebhookConfigured({ GCHAT_WEBHOOK_OPS: '   ' })).toBe(false);
    });
    it('returns false when no matching keys exist', () => {
      expect(hasAnyWebhookConfigured({ OTHER: 'x' })).toBe(false);
    });
  });
});
