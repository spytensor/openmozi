/**
 * LINE Messaging API adapter.
 *
 * Transport: webhook. MOZI registers `/webhooks/line` on the Fastify app;
 * LINE POSTs every event to that URL. Signature is verified with the
 * channel secret before any handling.
 *
 * Replies use the LINE REST API (reply message with replyToken for free,
 * push message for proactive notifications — push consumes quota and is
 * only used for `sendDirect`).
 *
 * chatId convention: `line:<sourceId>` where sourceId is the LINE
 * userId/roomId/groupId from the `source` block.
 */

import pino from 'pino';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { messagingApi, type webhook } from '@line/bot-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:line' });

declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}

export const LINE_MAX_LENGTH = 4900; // LINE limit is 5000; leave headroom
export const LINE_CHATID_PREFIX = 'line:';
export const LINE_WEBHOOK_PATH = '/webhooks/line';

export interface LineAdapter {
  client: messagingApi.MessagingApiClient;
  stop(): Promise<void>;
}

export function isLineChatId(value: string): boolean {
  return value.startsWith(LINE_CHATID_PREFIX);
}

export function chatIdToLineSourceId(chatId: string): string | null {
  if (!chatId.startsWith(LINE_CHATID_PREFIX)) return null;
  const raw = chatId.slice(LINE_CHATID_PREFIX.length);
  // LINE ids are 33 chars, [Uu/Rr/Cc] + 32 hex
  return /^[URCG][0-9a-f]{32}$/.test(raw) ? raw : null;
}

export function lineSourceIdToChatId(sourceId: string): string {
  return `${LINE_CHATID_PREFIX}${sourceId}`;
}

export function splitMessage(text: string, maxLength = LINE_MAX_LENGTH): string[] {
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

/**
 * Validate the channel access token by calling /v2/bot/info. Returns the
 * bot's display name on success.
 */
export async function validateAccessToken(
  token: string,
): Promise<{ valid: boolean; botName?: string; error?: string }> {
  const trimmed = token.trim();
  if (trimmed.length < 40) {
    return { valid: false, error: 'Access token looks too short.' };
  }
  try {
    const response = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { displayName?: string };
    return { valid: true, botName: data.displayName };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify a LINE webhook signature. */
export function verifyLineSignature(
  body: string,
  channelSecret: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const computed = createHmac('SHA256', channelSecret).update(body).digest('base64');
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Source id extraction (handles user / group / room). */
function sourceIdFrom(event: webhook.Event): string | null {
  const src = event.source;
  if (!src) return null;
  if (src.type === 'user') return src.userId ?? null;
  if (src.type === 'group') return src.groupId ?? null;
  if (src.type === 'room') return src.roomId ?? null;
  return null;
}

/**
 * Convert a LINE webhook event into MOZI's IncomingMessage shape. Only
 * handles text messages; images/audio/video are dropped (a future task
 * can extend this with media download).
 */
export function normalizeLineEvent(event: webhook.Event): IncomingMessage | null {
  if (event.type !== 'message') return null;
  if (event.message.type !== 'text') return null;
  const sourceId = sourceIdFrom(event);
  if (!sourceId) return null;
  const text = event.message.text?.trim() ?? '';
  if (!text) return null;

  const isCommand = text.startsWith('/');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  return {
    channelType: 'line',
    chatId: lineSourceIdToChatId(sourceId),
    userId: event.source?.userId ?? sourceId,
    username: event.source?.userId ?? sourceId,
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: new Date(event.timestamp),
  };
}

export function unsupportedLineMessageReply(event: webhook.Event): string | null {
  if (event.type !== 'message' || event.message.type === 'text') return null;
  return 'This bot currently supports text messages only. Media was not processed.';
}

/** Send a push message (costs quota on the LINE side). */
export async function sendDirectMessage(
  client: messagingApi.MessagingApiClient,
  chatId: string,
  text: string,
): Promise<void> {
  const sourceId = chatIdToLineSourceId(chatId);
  if (!sourceId) throw new Error(`Invalid LINE chatId: ${chatId}`);
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await client.pushMessage({
      to: sourceId,
      messages: [{ type: 'text', text: chunk }],
    });
  }
}

/**
 * Register the LINE webhook route on Fastify and return an adapter that
 * owns the REST client.
 */
export async function createLineAdapter(params: {
  fastify: FastifyInstance;
  accessToken: string;
  channelSecret: string;
  handler: MessageHandler;
}): Promise<LineAdapter> {
  const { fastify, accessToken, channelSecret, handler } = params;
  const client = new messagingApi.MessagingApiClient({ channelAccessToken: accessToken });

  fastify.post(LINE_WEBHOOK_PATH, { config: { rawBody: true } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
    const signature = request.headers['x-line-signature'];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (!verifyLineSignature(raw, channelSecret, sig)) {
      logger.warn('LINE webhook: bad signature');
      return reply.code(401).send();
    }

    const payload = request.body as webhook.CallbackRequest;
    const events = payload.events ?? [];
    // ack fast — LINE enforces a timeout
    reply.code(200).send();

    for (const event of events) {
      const normalized = normalizeLineEvent(event);
      if (!normalized) {
        const unsupportedReply = unsupportedLineMessageReply(event);
        if (unsupportedReply && event.type === 'message' && event.replyToken) {
          logger.warn({ messageType: event.message.type }, 'LINE media message is not supported');
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: unsupportedReply }],
          });
        }
        continue;
      }
      try {
        const result = await handler(normalized);
        if (!result) continue;
        if (event.type === 'message' && event.replyToken) {
          const chunks = splitMessage(result).slice(0, 5); // LINE reply API caps at 5 messages
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: chunks.map((chunk) => ({ type: 'text' as const, text: chunk })),
          });
        }
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'LINE handler threw');
      }
    }
  });

  logger.info({ path: LINE_WEBHOOK_PATH }, 'LINE webhook registered');

  return {
    client,
    async stop() {
      // Fastify route lifetime is tied to the server itself; nothing to stop explicitly.
    },
  };
}
