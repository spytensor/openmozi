/**
 * Matrix L0 channel adapter.
 *
 * Uses matrix-js-sdk in non-crypto mode (end-to-end encryption would
 * need Olm/vodozemac and a persistent sqlite store — deferred). Users
 * supply a homeserver URL, full userId, and a pre-generated access
 * token (from Element's *Help & About → Access Token*, or via login
 * scripts).
 *
 * chatId convention: `matrix:<roomId>` where roomId is the `!xxx:host`
 * room identifier.
 */

import pino from 'pino';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:matrix' });

export const MATRIX_CHATID_PREFIX = 'matrix:';
export const MATRIX_MAX_LENGTH = 16_000; // Matrix has no hard per-message limit, but servers throttle very large events

export function isMatrixChatId(value: string): boolean {
  return value.startsWith(MATRIX_CHATID_PREFIX);
}

export function matrixRoomIdToChatId(roomId: string): string {
  return `${MATRIX_CHATID_PREFIX}${roomId}`;
}

export function chatIdToMatrixRoomId(chatId: string): string | null {
  if (!chatId.startsWith(MATRIX_CHATID_PREFIX)) return null;
  const raw = chatId.slice(MATRIX_CHATID_PREFIX.length);
  return /^![A-Za-z0-9]+:[A-Za-z0-9.-]+$/.test(raw) ? raw : null;
}

export function splitMessage(text: string, maxLength = MATRIX_MAX_LENGTH): string[] {
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

/** Validate credentials with a `whoami` call. */
export async function validateCredentials(params: {
  homeserver: string;
  accessToken: string;
}): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const base = params.homeserver.replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${params.accessToken.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { valid: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}` };
    }
    const data = (await response.json()) as { user_id?: string };
    return { valid: true, userId: data.user_id };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Subset of the matrix-js-sdk event shape we use. */
interface MatrixTimelineEvent {
  getType(): string;
  getRoomId(): string | undefined;
  getSender(): string | undefined;
  getContent(): { msgtype?: string; body?: string };
  getTs(): number;
}

/** Subset of the matrix-js-sdk room shape we use. */
interface MatrixRoomLike {
  roomId: string;
}

interface MatrixClientLike {
  sendTextMessage(roomId: string, text: string): Promise<unknown>;
  stopClient(): void;
}

export interface MatrixAdapter {
  client: MatrixClientLike;
  stop(): Promise<void>;
}

export function normalizeMatrixEvent(
  event: MatrixTimelineEvent,
  selfUserId: string | null,
): IncomingMessage | null {
  if (event.getType() !== 'm.room.message') return null;
  const sender = event.getSender();
  if (!sender) return null;
  if (selfUserId && sender === selfUserId) return null;
  const content = event.getContent();
  if (content.msgtype !== 'm.text') return null;
  const text = content.body?.trim() ?? '';
  if (!text) return null;
  const roomId = event.getRoomId();
  if (!roomId) return null;

  const isCommand = text.startsWith('/') || text.startsWith('!');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  return {
    channelType: 'matrix',
    chatId: matrixRoomIdToChatId(roomId),
    userId: sender,
    username: sender,
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: new Date(event.getTs()),
  };
}

export async function sendDirectMessage(
  client: MatrixClientLike,
  chatId: string,
  text: string,
): Promise<void> {
  const roomId = chatIdToMatrixRoomId(chatId);
  if (!roomId) throw new Error(`Invalid Matrix chatId: ${chatId}`);
  for (const chunk of splitMessage(text)) {
    await client.sendTextMessage(roomId, chunk);
  }
}

/**
 * Create and start a Matrix adapter. Imports the SDK dynamically so the
 * SDK's ~5 MB worth of deps is only loaded when the channel is actually
 * enabled.
 */
export async function createMatrixAdapter(params: {
  homeserver: string;
  accessToken: string;
  userId: string;
  handler: MessageHandler;
}): Promise<MatrixAdapter> {
  const sdk = (await import('matrix-js-sdk')) as typeof import('matrix-js-sdk');
  const { handler } = params;
  const client = sdk.createClient({
    baseUrl: params.homeserver.replace(/\/+$/, ''),
    accessToken: params.accessToken,
    userId: params.userId,
  });

  client.on(sdk.RoomEvent.Timeline, async (event: MatrixTimelineEvent, room: MatrixRoomLike | undefined, toStartOfTimeline?: boolean) => {
    if (toStartOfTimeline) return;
    const normalized = normalizeMatrixEvent(event, params.userId);
    if (!normalized) return;
    // Sync replays older events on connect; only reply to fresh ones.
    if (event.getTs() < Date.now() - 60_000) return;
    try {
      const reply = await handler(normalized);
      if (!reply) return;
      for (const chunk of splitMessage(reply)) {
        await client.sendTextMessage(event.getRoomId()!, chunk);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Matrix handler threw');
    }
  });

  client.on(sdk.ClientEvent.Sync, (state: string) => {
    if (state === 'PREPARED' || state === 'SYNCING') {
      logger.info({ state }, 'Matrix sync state');
    } else if (state === 'ERROR') {
      logger.error({ state }, 'Matrix sync error');
    }
  });

  await client.startClient({ initialSyncLimit: 10 });
  logger.info({ userId: params.userId, homeserver: params.homeserver }, 'Matrix client started');

  return {
    client,
    async stop() {
      try {
        client.stopClient();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Matrix stop error');
      }
    },
  };
}
