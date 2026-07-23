import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  isTeamsChatId,
  resolveWebhookUrl,
  hasAnyWebhookConfigured,
  TEAMS_CHATID_PREFIX,
  TEAMS_MAX_LENGTH,
} from './msteams.js';

describe('channels/msteams', () => {
  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      expect(splitMessage('hello')).toEqual(['hello']);
    });
    it('splits very long text', () => {
      const body = 'a'.repeat(TEAMS_MAX_LENGTH + 500);
      const chunks = splitMessage(body);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TEAMS_MAX_LENGTH);
    });
  });

  describe('chatId routing', () => {
    it('recognises teams-prefixed values', () => {
      expect(isTeamsChatId(`${TEAMS_CHATID_PREFIX}alerts`)).toBe(true);
      expect(isTeamsChatId('slack:C1')).toBe(false);
    });
  });

  describe('resolveWebhookUrl', () => {
    it('maps teams:<key> to TEAMS_WEBHOOK_<UPPER>', () => {
      expect(resolveWebhookUrl('teams:eng-alerts', { TEAMS_WEBHOOK_ENGALERTS: 'https://x' })).toBe('https://x');
    });
    it('returns null for unknown nicknames', () => {
      expect(resolveWebhookUrl('teams:unknown', {})).toBeNull();
    });
  });

  describe('hasAnyWebhookConfigured', () => {
    it('true when any TEAMS_WEBHOOK_* set', () => {
      expect(hasAnyWebhookConfigured({ TEAMS_WEBHOOK_A: 'x' })).toBe(true);
    });
    it('false for whitespace-only values', () => {
      expect(hasAnyWebhookConfigured({ TEAMS_WEBHOOK_A: '   ' })).toBe(false);
    });
    it('false when none configured', () => {
      expect(hasAnyWebhookConfigured({})).toBe(false);
    });
  });
});
