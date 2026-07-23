import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createSession } from '../memory/sessions.js';
import { getHistory } from '../memory/conversations.js';
import { deliverScheduledMessage } from './scheduled-delivery.js';

let tmpDir: string;

describe('scheduled delivery wiring', () => {
  beforeEach(() => {
    const setup = setupTestDb();
    tmpDir = setup.tmpDir;
  });

  afterEach(() => teardownTestDb(tmpDir));

  it('persists an offline Web/App delivery to the owning session', async () => {
    const session = createSession('owner-1', 'Scheduled target', 'tenant-a');
    const chatId = `owner-1:${session.id}`;

    const result = await deliverScheduledMessage({
      tenantId: 'tenant-a',
      chatId,
      userId: 'owner-1',
      sessionId: session.id,
      channelType: 'websocket',
    }, 'Reminder: durable while offline');

    expect(result).toEqual({ persisted: true, liveRecipients: 0 });
    const messages = getHistory(chatId, 10, 'tenant-a', session.id);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Reminder: durable while offline',
      session_id: session.id,
    });
  });

  it('fails closed when the session owner does not match', async () => {
    const session = createSession('owner-1', 'Scheduled target', 'tenant-a');
    await expect(deliverScheduledMessage({
      tenantId: 'tenant-a',
      chatId: `owner-2:${session.id}`,
      userId: 'owner-2',
      sessionId: session.id,
      channelType: 'websocket',
    }, 'should not persist')).rejects.toThrow(/owner mismatch/);
  });
});
