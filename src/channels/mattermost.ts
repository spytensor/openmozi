/**
 * Mattermost L0 channel adapter.
 *
 * @mattermost/client ships two clients: a REST `Client4` for HTTP API
 * calls (used to send messages), and a `WebSocketClient` that receives
 * server-side events (`posted` is the one we care about). A Personal
 * Access Token authenticates both.
 *
 * chatId convention: `mattermost:<channel_id>` — Mattermost channel
 * ids are 26-char base36 strings.
 */

import pino from 'pino';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:mattermost' });

export const MM_CHATID_PREFIX = 'mattermost:';
export const MM_MAX_LENGTH = 16_000; // Mattermost default is 16k

export function isMattermostChatId(value: string): boolean {
  return value.startsWith(MM_CHATID_PREFIX);
}

export function mmChannelIdToChatId(channelId: string): string {
  return `${MM_CHATID_PREFIX}${channelId}`;
}

export function chatIdToMmChannelId(chatId: string): string | null {
  if (!chatId.startsWith(MM_CHATID_PREFIX)) return null;
  const raw = chatId.slice(MM_CHATID_PREFIX.length);
  return /^[a-z0-9]{20,}$/.test(raw) ? raw : null;
}

export function splitMessage(text: string, maxLength = MM_MAX_LENGTH): string[] {
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

/** Validate credentials via /api/v4/users/me. */
export async function validateCredentials(params: {
  serverUrl: string;
  accessToken: string;
}): Promise<{ valid: boolean; username?: string; userId?: string; error?: string }> {
  const base = params.serverUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${params.accessToken.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { valid: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}` };
    }
    const data = (await response.json()) as { id?: string; username?: string };
    return { valid: true, userId: data.id, username: data.username };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mattermost `posted` event payload (partial). */
interface MattermostPostedEvent {
  event: 'posted';
  data?: {
    channel_name?: string;
    channel_type?: string;
    sender_name?: string;
    post?: string;
    team_id?: string;
  };
  broadcast?: { channel_id?: string };
}

interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at?: number;
  type?: string;
}

/** Parse the `post` field (JSON-encoded) and return the post object. */
export function extractPost(data: MattermostPostedEvent['data']): MattermostPost | null {
  if (!data?.post) return null;
  try {
    return JSON.parse(data.post) as MattermostPost;
  } catch {
    return null;
  }
}

export function normalizeMattermostEvent(
  event: MattermostPostedEvent,
  selfUserId: string | null,
): IncomingMessage | null {
  if (event.event !== 'posted') return null;
  const post = extractPost(event.data);
  if (!post) return null;
  if (selfUserId && post.user_id === selfUserId) return null;
  if (post.type && post.type.startsWith('system_')) return null;
  const text = post.message?.trim() ?? '';
  if (!text) return null;

  const isCommand = text.startsWith('/') || text.startsWith('!');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  return {
    channelType: 'mattermost',
    chatId: mmChannelIdToChatId(post.channel_id),
    userId: post.user_id,
    username: event.data?.sender_name ?? post.user_id,
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: post.create_at ? new Date(post.create_at) : new Date(),
  };
}

export interface MattermostAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rest: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws: any;
  stop(): Promise<void>;
}

export async function sendDirectMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rest: any,
  chatId: string,
  text: string,
): Promise<void> {
  const channelId = chatIdToMmChannelId(chatId);
  if (!channelId) throw new Error(`Invalid Mattermost chatId: ${chatId}`);
  for (const chunk of splitMessage(text)) {
    await rest.createPost({ channel_id: channelId, message: chunk });
  }
}

/**
 * Create a REST + WebSocket adapter. Dynamic import of @mattermost/client
 * so the SDK only loads when the channel is enabled.
 */
export async function createMattermostAdapter(params: {
  serverUrl: string;
  accessToken: string;
  handler: MessageHandler;
}): Promise<MattermostAdapter> {
  const mod = (await import('@mattermost/client')) as unknown as {
    Client4: new () => {
      setUrl(url: string): void;
      setToken(token: string): void;
      getMe(): Promise<{ id: string; username: string }>;
      createPost(post: { channel_id: string; message: string }): Promise<unknown>;
      getWebSocketUrl(): string;
    };
    WebSocketClient: new () => {
      initialize(url: string, token: string): void;
      addMessageListener(listener: (event: MattermostPostedEvent) => void): void;
      close(): void;
    };
  };

  const rest = new mod.Client4();
  rest.setUrl(params.serverUrl.replace(/\/+$/, ''));
  rest.setToken(params.accessToken);

  const me = await rest.getMe();
  logger.info({ username: me.username, userId: me.id }, 'Mattermost authenticated');

  const ws = new mod.WebSocketClient();
  const wsUrl = rest.getWebSocketUrl();
  ws.initialize(wsUrl, params.accessToken);

  ws.addMessageListener(async (raw) => {
    const normalized = normalizeMattermostEvent(raw, me.id);
    if (!normalized) return;
    try {
      const reply = await params.handler(normalized);
      if (!reply) return;
      const channelId = chatIdToMmChannelId(normalized.chatId);
      if (!channelId) return;
      for (const chunk of splitMessage(reply)) {
        await rest.createPost({ channel_id: channelId, message: chunk });
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Mattermost handler threw');
    }
  });

  return {
    rest,
    ws,
    async stop() {
      try {
        ws.close();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Mattermost stop error');
      }
    },
  };
}
