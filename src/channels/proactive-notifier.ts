/**
 * Proactive Notifier — channel-agnostic notification bus.
 *
 * Channels (Telegram, WebSocket, etc.) register sender functions at startup.
 * Other modules call `notify()` to fan out messages to all registered channels.
 */

import pino from 'pino';

const logger = pino({ name: 'mozi:proactive-notifier' });

type SenderFn = (chatId: string, text: string) => Promise<boolean | void>;

export interface NotifyOptions {
  channelKey?: string;
  requireDelivery?: boolean;
}

const anonymousSenders: SenderFn[] = [];
const keyedSenders = new Map<string, SenderFn>();

/**
 * Register a sender function that will be called for every notification.
 * Typically called once per channel at startup. Provide `key` to make the
 * registration idempotent (later calls replace the previous sender).
 */
export function registerSender(fn: SenderFn, key?: string): void {
  if (key && key.trim().length > 0) {
    keyedSenders.set(key.trim(), fn);
    return;
  }
  anonymousSenders.push(fn);
}

function resolveSenders(channelKey?: string): SenderFn[] {
  if (channelKey && channelKey.trim().length > 0) {
    const sender = keyedSenders.get(channelKey.trim());
    return sender ? [sender] : [];
  }
  return [
    ...anonymousSenders,
    ...keyedSenders.values(),
  ];
}

/**
 * Send a notification to a specific chat across all registered channels.
 * When `channelKey` is set, only that sender is used.
 */
export async function notify(chatId: string, text: string, options: NotifyOptions = {}): Promise<void> {
  const senders = resolveSenders(options.channelKey);
  const hasTargetedSender = senders.length > 0;
  if (senders.length === 0) {
    if (options.requireDelivery) {
      if (options.channelKey) {
        throw new Error(`No proactive sender registered for channel "${options.channelKey}"`);
      }
      throw new Error('No proactive notification senders registered');
    }
    return;
  }

  const results = await Promise.allSettled(
    senders.map(fn => fn(chatId, text)),
  );
  let delivered = 0;
  let firstFailure: unknown;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value === false) {
        continue;
      }
      delivered += 1;
      continue;
    }
    if (firstFailure === undefined) {
      firstFailure = result.reason;
    }
    logger.warn(
      {
        chatId,
        channelKey: options.channelKey,
        err: result.reason instanceof Error ? result.reason.message : String(result.reason),
      },
      'Proactive notification sender failed',
    );
  }

  if (options.requireDelivery && delivered === 0) {
    if (firstFailure instanceof Error) {
      throw firstFailure;
    }
    if (firstFailure !== undefined) {
      throw new Error(String(firstFailure));
    }
    if (options.channelKey) {
      throw new Error(
        hasTargetedSender
          ? `Proactive sender for channel "${options.channelKey}" did not deliver`
          : `No proactive sender registered for channel "${options.channelKey}"`,
      );
    }
    throw new Error('No proactive notification senders registered');
  }
}

/**
 * Remove all registered senders. Used in tests.
 */
export function clearSenders(): void {
  anonymousSenders.length = 0;
  keyedSenders.clear();
}
