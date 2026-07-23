import { describe, it, expect, beforeEach } from 'vitest';
import { registerSender, notify, clearSenders } from './proactive-notifier.js';

beforeEach(() => {
  clearSenders();
});

describe('channels/proactive-notifier', () => {
  describe('notify', () => {
    it('calls all registered senders with chatId and text', async () => {
      const calls1: Array<[string, string]> = [];
      const calls2: Array<[string, string]> = [];

      registerSender(async (chatId, text) => { calls1.push([chatId, text]); });
      registerSender(async (chatId, text) => { calls2.push([chatId, text]); });

      await notify('chat-123', 'Hello world');

      expect(calls1).toEqual([['chat-123', 'Hello world']]);
      expect(calls2).toEqual([['chat-123', 'Hello world']]);
    });

    it('failed sender does not block other senders', async () => {
      const successCalls: Array<[string, string]> = [];

      registerSender(async () => { throw new Error('sender 1 failed'); });
      registerSender(async (chatId, text) => { successCalls.push([chatId, text]); });

      // Should not throw
      await notify('chat-456', 'Test message');

      // Second sender should still be called
      expect(successCalls).toEqual([['chat-456', 'Test message']]);
    });

    it('targets a specific keyed sender when channelKey is provided', async () => {
      const telegramCalls: Array<[string, string]> = [];
      const websocketCalls: Array<[string, string]> = [];

      registerSender(async (chatId, text) => { telegramCalls.push([chatId, text]); }, 'telegram');
      registerSender(async (chatId, text) => { websocketCalls.push([chatId, text]); }, 'websocket');

      await notify('local-user', 'Targeted', { channelKey: 'websocket', requireDelivery: true });

      expect(telegramCalls).toEqual([]);
      expect(websocketCalls).toEqual([['local-user', 'Targeted']]);
    });

    it('throws when requireDelivery is set and the target sender is missing', async () => {
      await expect(notify('chat-1', 'Hello', { channelKey: 'acp', requireDelivery: true }))
        .rejects
        .toThrow('No proactive sender registered for channel "acp"');
    });

    it('does not count an explicit false return value as delivered', async () => {
      registerSender(async () => false, 'telegram');

      await expect(notify('local-user', 'Hello', { channelKey: 'telegram', requireDelivery: true }))
        .rejects
        .toThrow('Proactive sender for channel "telegram" did not deliver');
    });

    it('works with no registered senders', async () => {
      // Should not throw
      await notify('chat-789', 'No senders registered');
    });

    it('keyed sender registration is idempotent by key', async () => {
      const calls1: Array<[string, string]> = [];
      const calls2: Array<[string, string]> = [];

      registerSender(async (chatId, text) => { calls1.push([chatId, text]); }, 'telegram');
      registerSender(async (chatId, text) => { calls2.push([chatId, text]); }, 'telegram');

      await notify('chat-keyed', 'Hello keyed');

      expect(calls1).toEqual([]);
      expect(calls2).toEqual([['chat-keyed', 'Hello keyed']]);
    });
  });

  describe('clearSenders', () => {
    it('removes all registered senders', async () => {
      const calls: string[] = [];
      registerSender(async (_chatId, text) => { calls.push(text); });

      await notify('chat', 'before clear');
      expect(calls).toHaveLength(1);

      clearSenders();
      await notify('chat', 'after clear');
      expect(calls).toHaveLength(1); // No new calls after clear
    });
  });
});
