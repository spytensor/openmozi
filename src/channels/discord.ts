/**
 * Discord L0 channel adapter.
 *
 * Uses discord.js v14 with the Gateway intents required to read direct
 * messages and guild messages addressed to the bot. Messages are normalized
 * into MOZI's shared `IncomingMessage` shape; outbound text is chunked to
 * Discord's 2000-char per-message limit before sending.
 *
 * chatId convention: `discord:<channelId>` — unambiguous vs Telegram/WeChat.
 */

import pino from 'pino';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextBasedChannel,
} from 'discord.js';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:discord' });

/** Discord's per-message text limit. */
const DISCORD_MAX_LENGTH = 2000;

/** Unique prefix we use in chatIds so the router can distinguish Discord. */
export const DISCORD_CHATID_PREFIX = 'discord:';

export interface DiscordAdapter {
  client: Client;
  /** Graceful disconnect. Safe to call multiple times. */
  stop(): Promise<void>;
}

/**
 * Validate a Discord bot token by logging in and immediately destroying the
 * client. Returns the bot's user tag on success.
 */
export async function validateBotToken(
  token: string,
): Promise<{ valid: boolean; tag?: string; error?: string }> {
  if (!token || token.trim().length < 20) {
    return { valid: false, error: 'Token looks too short — did you paste the full bot token?' };
  }
  const probe = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await probe.login(token.trim());
    const tag = probe.user?.tag;
    await probe.destroy();
    return tag ? { valid: true, tag } : { valid: false, error: 'Login succeeded but user info was empty.' };
  } catch (err) {
    try {
      await probe.destroy();
    } catch {
      // ignore
    }
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Split a long reply into Discord-sized chunks (<=2000 chars each),
 * preferring newline/whitespace boundaries.
 */
export function splitMessage(text: string, maxLength = DISCORD_MAX_LENGTH): string[] {
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

/** Determine whether a chatId belongs to the Discord channel. */
export function isDiscordChatId(value: string): boolean {
  return value.startsWith(DISCORD_CHATID_PREFIX);
}

/** Extract Discord channel snowflake from a MOZI chatId. */
export function chatIdToChannelId(chatId: string): string | null {
  if (!chatId.startsWith(DISCORD_CHATID_PREFIX)) return null;
  const raw = chatId.slice(DISCORD_CHATID_PREFIX.length);
  return /^\d{5,}$/.test(raw) ? raw : null;
}

/** Build a MOZI chatId from a Discord channel snowflake. */
export function channelIdToChatId(channelId: string): string {
  return `${DISCORD_CHATID_PREFIX}${channelId}`;
}

/**
 * Convert a Discord message into MOZI's IncomingMessage shape. Returns null
 * for messages we should ignore (bot echoes, empty content, DMs from the
 * bot itself).
 */
export function normalizeDiscordMessage(
  msg: DiscordMessage,
  selfId: string | null,
): IncomingMessage | null {
  if (msg.author.bot) return null;
  if (selfId && msg.author.id === selfId) return null;

  const text = msg.content?.trim() ?? '';
  if (!text && (msg.attachments?.size ?? 0) === 0) return null;

  const isCommand = text.startsWith('/');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  return {
    channelType: 'discord',
    chatId: channelIdToChatId(msg.channelId),
    userId: msg.author.id,
    username: msg.author.username || msg.author.globalName || msg.author.id,
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: new Date(msg.createdTimestamp ?? Date.now()),
  };
}

/** Send a string to a Discord channel, chunking as required. */
export async function sendDirectMessage(
  client: Client,
  chatId: string,
  text: string,
): Promise<void> {
  const channelId = chatIdToChannelId(chatId);
  if (!channelId) {
    throw new Error(`Invalid Discord chatId: ${chatId}`);
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Discord channel ${channelId} is not text-based or inaccessible`);
  }
  const writable = channel as TextBasedChannel & {
    send: (content: string) => Promise<unknown>;
  };
  if (typeof writable.send !== 'function') {
    throw new Error(`Discord channel ${channelId} is not writable`);
  }
  for (const chunk of splitMessage(text)) {
    await writable.send(chunk);
  }
}

/**
 * Create and start a Discord adapter. Logs in with the provided bot token
 * and dispatches every qualifying message to `handler`.
 */
export async function createDiscordAdapter(
  token: string,
  handler: MessageHandler,
): Promise<DiscordAdapter> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on(Events.ClientReady, (c) => {
    logger.info({ tag: c.user.tag }, 'Discord bot ready');
  });

  client.on(Events.Error, (err) => {
    logger.error({ err: err.message }, 'Discord client error');
  });

  client.on(Events.MessageCreate, async (msg) => {
    const normalized = normalizeDiscordMessage(msg, client.user?.id ?? null);
    if (!normalized) return;
    try {
      const reply = await handler(normalized);
      if (!reply) return;
      for (const chunk of splitMessage(reply)) {
        await msg.channel.send(chunk).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Discord reply failed');
        });
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Discord handler threw');
    }
  });

  await client.login(token);

  return {
    client,
    async stop() {
      try {
        await client.destroy();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Discord stop error');
      }
    },
  };
}
