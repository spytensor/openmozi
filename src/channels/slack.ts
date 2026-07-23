/**
 * Slack L0 channel adapter.
 *
 * Uses Socket Mode so MOZI does not need a public webhook URL. Events flow
 * in over WebSocket from Slack; replies are sent with `chat.postMessage`
 * on the Web API. We require two tokens:
 *   - SLACK_APP_TOKEN (xapp-...) with `connections:write` — for Socket Mode
 *   - SLACK_BOT_TOKEN (xoxb-...) — for chat.postMessage
 *
 * chatId convention: `slack:<channelId>` (C..., D..., G...).
 */

import pino from 'pino';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:slack' });

/** Slack soft limit for a single message is 40k chars; we chunk at 3500 to be polite. */
export const SLACK_MAX_LENGTH = 3500;
export const SLACK_CHATID_PREFIX = 'slack:';

export interface SlackAdapter {
  socket: SocketModeClient;
  web: WebClient;
  stop(): Promise<void>;
}

export function isSlackChatId(value: string): boolean {
  return value.startsWith(SLACK_CHATID_PREFIX);
}

export function chatIdToSlackChannelId(chatId: string): string | null {
  if (!chatId.startsWith(SLACK_CHATID_PREFIX)) return null;
  const raw = chatId.slice(SLACK_CHATID_PREFIX.length);
  return /^[A-Z][A-Z0-9]{6,}$/.test(raw) ? raw : null;
}

export function slackChannelIdToChatId(channelId: string): string {
  return `${SLACK_CHATID_PREFIX}${channelId}`;
}

export function splitMessage(text: string, maxLength = SLACK_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** Validate a bot token via `auth.test`. */
export async function validateBotToken(
  botToken: string,
): Promise<{ valid: boolean; teamName?: string; user?: string; error?: string }> {
  const trimmed = botToken.trim();
  if (!trimmed.startsWith('xoxb-')) {
    return { valid: false, error: 'Bot token should start with `xoxb-`.' };
  }
  try {
    const web = new WebClient(trimmed);
    const result = await web.auth.test();
    if (!result.ok) return { valid: false, error: result.error ?? 'auth.test failed' };
    return { valid: true, teamName: result.team ?? undefined, user: result.user ?? undefined };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Slack event payload shape we care about (a subset of messages.channels/im). */
interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  bot_id?: string;
}

/**
 * Convert a Slack message event into an IncomingMessage. Returns null for
 * bot echoes, message_changed/deleted, or empty bodies.
 */
export function normalizeSlackMessage(
  event: SlackMessageEvent,
  botUserId: string | null,
): IncomingMessage | null {
  if (event.type !== 'message') return null;
  if (event.subtype && event.subtype !== 'file_share') return null; // ignore edits, joins, etc.
  if (event.bot_id) return null;
  if (botUserId && event.user === botUserId) return null;
  const text = event.text?.trim() ?? '';
  if (!text) return null;

  const isCommand = text.startsWith('/') || text.startsWith('!');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand
    ? firstSpace === -1
      ? text.slice(1)
      : text.slice(1, firstSpace)
    : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  return {
    channelType: 'slack',
    chatId: slackChannelIdToChatId(event.channel),
    userId: event.user ?? 'unknown',
    username: event.user ?? 'unknown',
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: new Date(Number(event.ts) * 1000),
  };
}

export async function sendDirectMessage(
  web: WebClient,
  chatId: string,
  text: string,
): Promise<void> {
  const channelId = chatIdToSlackChannelId(chatId);
  if (!channelId) throw new Error(`Invalid Slack chatId: ${chatId}`);
  for (const chunk of splitMessage(text)) {
    await web.chat.postMessage({ channel: channelId, text: chunk });
  }
}

/**
 * Create a Socket Mode client + Web API client and dispatch message events
 * to `handler`.
 */
export async function createSlackAdapter(
  appToken: string,
  botToken: string,
  handler: MessageHandler,
): Promise<SlackAdapter> {
  if (!appToken.startsWith('xapp-')) {
    throw new Error('Slack app token must start with `xapp-` (Socket Mode).');
  }
  if (!botToken.startsWith('xoxb-')) {
    throw new Error('Slack bot token must start with `xoxb-`.');
  }

  const web = new WebClient(botToken);
  const auth = await web.auth.test();
  if (!auth.ok) throw new Error(`Slack auth.test failed: ${auth.error ?? 'unknown'}`);
  const botUserId = auth.user_id ?? null;
  logger.info({ team: auth.team, user: auth.user }, 'Slack bot authenticated');

  const socket = new SocketModeClient({ appToken });

  socket.on('connected', () => logger.info('Slack Socket Mode connected'));
  socket.on('disconnected', () => logger.warn('Slack Socket Mode disconnected'));
  socket.on('error', (err: Error) => logger.error({ err: err.message }, 'Slack socket error'));

  socket.on('message', async ({ event, ack }: { event: SlackMessageEvent; ack: () => Promise<void> }) => {
    await ack();
    const normalized = normalizeSlackMessage(event, botUserId);
    if (!normalized) return;
    try {
      const reply = await handler(normalized);
      if (!reply) return;
      for (const chunk of splitMessage(reply)) {
        await web.chat.postMessage({ channel: event.channel, text: chunk, thread_ts: event.ts });
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Slack handler threw');
    }
  });

  await socket.start();

  return {
    socket,
    web,
    async stop() {
      try {
        await socket.disconnect();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Slack stop error');
      }
    },
  };
}
