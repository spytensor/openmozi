/**
 * Twitch Chat L0 channel adapter.
 *
 * Uses tmi.js, which connects to Twitch's IRC-over-WSS gateway. Chat
 * messages arrive as regular IRC privmsgs; outbound messages go through
 * the same client. The bot joins a configured list of channels on
 * connect.
 *
 * chatId convention: `twitch:<lowercased-channel-without-hash>` —
 * matches Twitch's canonical channel identifier.
 */

import pino from 'pino';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:twitch' });

export const TWITCH_CHATID_PREFIX = 'twitch:';
export const TWITCH_MAX_LENGTH = 450; // Twitch chat limit is 500; leave headroom for /me etc.

export function isTwitchChatId(value: string): boolean {
  return value.startsWith(TWITCH_CHATID_PREFIX);
}

export function twitchChannelToChatId(channel: string): string {
  return `${TWITCH_CHATID_PREFIX}${channel.replace(/^#/, '').toLowerCase()}`;
}

export function chatIdToTwitchChannel(chatId: string): string | null {
  if (!chatId.startsWith(TWITCH_CHATID_PREFIX)) return null;
  const raw = chatId.slice(TWITCH_CHATID_PREFIX.length);
  return /^[a-z0-9_]{3,25}$/.test(raw) ? `#${raw}` : null;
}

export function splitMessage(text: string, maxLength = TWITCH_MAX_LENGTH): string[] {
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

export function parseTwitchChannels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean)
    .map((s) => `#${s}`);
}

/** Validate a Twitch OAuth token with Twitch's /oauth2/validate endpoint. */
export async function validateOAuthToken(
  token: string,
): Promise<{ valid: boolean; login?: string; error?: string }> {
  const stripped = token.replace(/^oauth:/, '').trim();
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${stripped}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { valid: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}` };
    }
    const data = (await response.json()) as { login?: string; scopes?: string[] };
    if (!data.scopes?.includes('chat:read') || !data.scopes?.includes('chat:edit')) {
      return {
        valid: false,
        error: `Missing scopes: need chat:read and chat:edit, got ${data.scopes?.join(',') ?? 'none'}`,
      };
    }
    return { valid: true, login: data.login };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Partial tmi.js userstate shape we rely on. */
interface TmiUserstate {
  'user-id'?: string;
  username?: string;
  'display-name'?: string;
  self?: boolean;
  'message-type'?: string;
}

export function normalizeTwitchMessage(
  channel: string,
  userstate: TmiUserstate,
  message: string,
  self: boolean,
  selfLogin: string | null,
): IncomingMessage | null {
  if (self) return null;
  if (userstate.self) return null;
  if (selfLogin && userstate.username?.toLowerCase() === selfLogin.toLowerCase()) return null;
  const text = message.trim();
  if (!text) return null;
  const isCommand = text.startsWith('/') || text.startsWith('!');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;
  return {
    channelType: 'twitch',
    chatId: twitchChannelToChatId(channel),
    userId: userstate['user-id'] ?? userstate.username ?? 'unknown',
    username: userstate['display-name'] ?? userstate.username ?? 'unknown',
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: new Date(),
  };
}

export interface TwitchAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  stop(): Promise<void>;
}

export async function sendDirectMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  chatId: string,
  text: string,
): Promise<void> {
  const channel = chatIdToTwitchChannel(chatId);
  if (!channel) throw new Error(`Invalid Twitch chatId: ${chatId}`);
  for (const chunk of splitMessage(text)) {
    await client.say(channel, chunk);
  }
}

export async function createTwitchAdapter(params: {
  username: string;
  oauthToken: string;
  channels: string[];
  handler: MessageHandler;
}): Promise<TwitchAdapter> {
  const tmi = (await import('tmi.js')) as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Client: new (opts: Record<string, unknown>) => any;
  };

  const oauthToken = params.oauthToken.startsWith('oauth:')
    ? params.oauthToken
    : `oauth:${params.oauthToken}`;

  const client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: {
      username: params.username,
      password: oauthToken,
    },
    channels: params.channels,
  });

  client.on('connected', (_: string, __: number) => logger.info({ username: params.username }, 'Twitch chat connected'));
  client.on('disconnected', (reason: string) => logger.warn({ reason }, 'Twitch chat disconnected'));
  client.on('message', async (channel: string, userstate: TmiUserstate, message: string, self: boolean) => {
    const normalized = normalizeTwitchMessage(channel, userstate, message, self, params.username);
    if (!normalized) return;
    try {
      const reply = await params.handler(normalized);
      if (!reply) return;
      for (const chunk of splitMessage(reply)) {
        await client.say(channel, chunk);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Twitch handler threw');
    }
  });

  await client.connect();

  return {
    client,
    async stop() {
      try {
        await client.disconnect();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Twitch stop error');
      }
    },
  };
}
