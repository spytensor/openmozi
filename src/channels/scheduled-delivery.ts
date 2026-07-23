import { getSession } from '../memory/sessions.js';
import { notify } from './proactive-notifier.js';

export interface ScheduledDeliveryTarget {
  tenantId: string;
  chatId: string;
  userId?: string | null;
  sessionId?: string | null;
  channelType?: string | null;
}

export interface ScheduledDeliveryResult {
  persisted: boolean;
  liveRecipients: number;
}

/**
 * Deliver out-of-turn work through the owning channel contract.
 *
 * Web/App delivery is durable first: an offline socket is still a successful
 * delivery because the assistant message and timeline item are persisted and
 * restored on the next launch. External channels must acknowledge a sender.
 */
export async function deliverScheduledMessage(
  target: ScheduledDeliveryTarget,
  content: string,
): Promise<ScheduledDeliveryResult> {
  const channelType = target.channelType?.trim() || undefined;
  if (channelType === 'websocket') {
    const sessionId = target.sessionId?.trim();
    if (!sessionId) {
      throw new Error('WebSocket scheduled delivery requires session_id');
    }
    const session = getSession(sessionId, target.tenantId);
    if (!session) {
      throw new Error(`Scheduled delivery session not found: ${sessionId}`);
    }
    if (target.userId && session.user_id !== target.userId) {
      throw new Error('Scheduled delivery session owner mismatch');
    }
    const { deliverAssistantMessage } = await import('./websocket.js');
    const { delivered } = deliverAssistantMessage({
      tenantId: target.tenantId,
      chatId: target.chatId,
      sessionId,
      content,
      origin: 'background',
    });
    return { persisted: true, liveRecipients: delivered };
  }

  await notify(target.chatId, content, {
    channelKey: channelType,
    requireDelivery: true,
  });
  return { persisted: false, liveRecipients: 1 };
}
