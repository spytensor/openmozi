/**
 * IRC L0 channel adapter.
 *
 * Uses irc-framework for a resilient TCP/TLS client with reconnect and
 * CTCP handling built in. The bot auto-joins a configured list of
 * channels on connect; incoming PRIVMSGs (channel + direct) are
 * normalized. Outbound replies go to the same target.
 *
 * chatId convention: `irc:<lowercased-channel-or-nick>`.
 */

import pino from 'pino';
import IrcFrameworkPackage from 'irc-framework';
import type { IncomingMessage, MessageHandler } from './telegram.js';

// irc-framework ships CommonJS; reach into .default for ESM interop.
const IrcFramework = (IrcFrameworkPackage as unknown as { default?: typeof IrcFrameworkPackage })?.default ?? IrcFrameworkPackage;
type IrcClient = InstanceType<typeof IrcFrameworkPackage.Client>;
type IrcMessageEvent = {
  nick: string;
  ident?: string;
  hostname?: string;
  target: string;
  message: string;
  type?: string;
  tags?: Record<string, string>;
};

const logger = pino({ name: 'mozi:irc' });

export const IRC_MAX_LENGTH = 400; // safe for 512-byte IRC lines
export const IRC_CHATID_PREFIX = 'irc:';

export interface IrcAdapter {
  client: IrcClient;
  stop(): Promise<void>;
}

export function isIrcChatId(value: string): boolean {
  return value.startsWith(IRC_CHATID_PREFIX);
}

export function ircTargetToChatId(target: string): string {
  return `${IRC_CHATID_PREFIX}${target.toLowerCase()}`;
}

export function chatIdToIrcTarget(chatId: string): string | null {
  if (!chatId.startsWith(IRC_CHATID_PREFIX)) return null;
  const raw = chatId.slice(IRC_CHATID_PREFIX.length);
  return raw.length > 0 ? raw : null;
}

export function splitMessage(text: string, maxLength = IRC_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= maxLength) {
      chunks.push(line);
      continue;
    }
    let remaining = line;
    while (remaining.length > maxLength) {
      let cut = remaining.lastIndexOf(' ', maxLength);
      if (cut <= 0) cut = maxLength;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^\s+/, '');
    }
    if (remaining.length > 0) chunks.push(remaining);
  }
  return chunks;
}

/** Normalize an irc-framework message event into IncomingMessage. */
export function normalizeIrcMessage(
  event: IrcMessageEvent,
  selfNick: string | null,
): IncomingMessage | null {
  if (selfNick && event.nick.toLowerCase() === selfNick.toLowerCase()) return null;
  const text = event.message?.trim();
  if (!text) return null;
  const isDirect = !!selfNick && event.target.toLowerCase() === selfNick.toLowerCase();
  const target = isDirect ? event.nick : event.target;

  const isCommand = text.startsWith('/') || text.startsWith('!');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  return {
    channelType: 'irc',
    chatId: ircTargetToChatId(target),
    userId: event.nick,
    username: event.nick,
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: new Date(),
  };
}

export interface IrcConfig {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  password?: string;
  channels: string[];
  sasl?: { user: string; password: string };
}

/** Parse the IRC_CHANNELS env var ("#a,#b,#c") into a string[]. */
export function parseIrcChannels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Connect once and capture the server's MOTD/welcome as a credential probe. */
export async function validateConnection(
  config: IrcConfig,
): Promise<{ valid: boolean; error?: string }> {
  const client = new IrcFramework.Client();
  return new Promise<{ valid: boolean; error?: string }>((resolve) => {
    const cleanup = () => {
      try {
        client.quit('MOZI validation complete');
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ valid: false, error: 'timeout waiting for IRC welcome' });
    }, 15_000);

    client.on('registered', () => {
      clearTimeout(timer);
      cleanup();
      resolve({ valid: true });
    });
    client.on('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      resolve({ valid: false, error: err.message });
    });
    client.on('socket close', () => {
      clearTimeout(timer);
      resolve({ valid: false, error: 'socket closed during handshake' });
    });

    try {
      client.connect({
        host: config.host,
        port: config.port,
        tls: config.tls,
        nick: config.nick,
        password: config.password,
        ...(config.sasl
          ? { sasl: { account: config.sasl.user, password: config.sasl.password } }
          : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ valid: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export async function sendDirectMessage(
  client: IrcClient,
  chatId: string,
  text: string,
): Promise<void> {
  const target = chatIdToIrcTarget(chatId);
  if (!target) throw new Error(`Invalid IRC chatId: ${chatId}`);
  for (const chunk of splitMessage(text)) {
    client.say(target, chunk);
  }
}

export async function createIrcAdapter(
  config: IrcConfig,
  handler: MessageHandler,
): Promise<IrcAdapter> {
  const client: IrcClient = new IrcFramework.Client();

  client.connect({
    host: config.host,
    port: config.port,
    tls: config.tls,
    nick: config.nick,
    password: config.password,
    ...(config.sasl ? { sasl: { account: config.sasl.user, password: config.sasl.password } } : {}),
  });

  client.on('registered', () => {
    logger.info({ host: config.host, nick: config.nick }, 'IRC connected');
    for (const ch of config.channels) {
      try {
        client.join(ch);
      } catch (err) {
        logger.warn({ channel: ch, err: err instanceof Error ? err.message : String(err) }, 'IRC join failed');
      }
    }
  });

  client.on('error', (err: Error) => {
    logger.error({ err: err.message }, 'IRC error');
  });

  client.on('message', async (event: IrcMessageEvent) => {
    const normalized = normalizeIrcMessage(event, client.user?.nick ?? config.nick);
    if (!normalized) return;
    try {
      const reply = await handler(normalized);
      if (!reply) return;
      const target = chatIdToIrcTarget(normalized.chatId);
      if (!target) return;
      for (const chunk of splitMessage(reply)) {
        client.say(target, chunk);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'IRC handler threw');
    }
  });

  return {
    client,
    async stop() {
      try {
        client.quit('MOZI shutting down');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'IRC quit error');
      }
    },
  };
}
