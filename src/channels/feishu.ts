/**
 * Feishu / Lark L0 channel adapter.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient which opens a
 * persistent outbound WebSocket from MOZI to Feishu's event gateway —
 * no public URL required. Outbound messages go through the REST
 * `im.v1.message.create` endpoint.
 *
 * chatId convention: `feishu:<chatId>` where the Feishu chatId is
 * `oc_<hex>` (group) or the REST API lookup key `open_id` for 1:1.
 */

import pino from 'pino';
import * as lark from '@larksuiteoapi/node-sdk';
import type { IncomingMessage, MessageHandler } from './telegram.js';

const logger = pino({ name: 'mozi:feishu' });

export const FEISHU_MAX_LENGTH = 3000; // Feishu limit is 30000; chunk small to feel responsive
export const FEISHU_CHATID_PREFIX = 'feishu:';

export interface FeishuAdapter {
  client: lark.Client;
  ws?: { close?: () => void | Promise<void> };
  stop(): Promise<void>;
}

export function isFeishuChatId(value: string): boolean {
  return value.startsWith(FEISHU_CHATID_PREFIX);
}

export function chatIdToFeishuChatId(chatId: string): string | null {
  if (!chatId.startsWith(FEISHU_CHATID_PREFIX)) return null;
  const raw = chatId.slice(FEISHU_CHATID_PREFIX.length);
  return raw.length > 0 ? raw : null;
}

export function feishuChatIdToChatId(feishuId: string): string {
  return `${FEISHU_CHATID_PREFIX}${feishuId}`;
}

export function splitMessage(text: string, maxLength = FEISHU_MAX_LENGTH): string[] {
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
 * Validate an app credential pair by requesting an app access token.
 */
export async function validateAppCredentials(
  appId: string,
  appSecret: string,
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<{ valid: boolean; error?: string }> {
  const base =
    domain === 'lark'
      ? 'https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal'
      : 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal';
  try {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId.trim(), app_secret: appSecret.trim() }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as { code?: number; msg?: string; app_access_token?: string };
    if (data.code === 0 && data.app_access_token) {
      return { valid: true };
    }
    return { valid: false, error: data.msg ?? `code=${data.code ?? 'unknown'}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Feishu event payload shape (subset). */
interface FeishuMessageEvent {
  event?: {
    message?: {
      chat_id?: string;
      message_id?: string;
      create_time?: string;
      message_type?: string;
      content?: string;
    };
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
    };
  };
}

/** Extract the text body from Feishu's `content` payload (JSON-encoded string). */
export function extractFeishuText(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

export function normalizeFeishuMessage(event: FeishuMessageEvent): IncomingMessage | null {
  const message = event.event?.message;
  const sender = event.event?.sender;
  if (!message || !sender) return null;
  if (sender.sender_type && sender.sender_type !== 'user') return null;
  if (message.message_type !== 'text') return null;
  const text = extractFeishuText(message.content).trim();
  if (!text) return null;
  const chatId = message.chat_id;
  if (!chatId) return null;
  const openId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? 'unknown';

  const isCommand = text.startsWith('/');
  const firstSpace = text.indexOf(' ');
  const commandRaw = isCommand ? (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)) : undefined;
  const commandArgs = isCommand && firstSpace !== -1 ? text.slice(firstSpace + 1).trim() : undefined;

  const createdMs = Number(message.create_time ?? Date.now());
  return {
    channelType: 'feishu',
    chatId: feishuChatIdToChatId(chatId),
    userId: openId,
    username: openId,
    text,
    isCommand,
    command: commandRaw,
    commandArgs,
    timestamp: Number.isFinite(createdMs) ? new Date(createdMs) : new Date(),
  };
}

export async function sendDirectMessage(
  client: lark.Client,
  chatId: string,
  text: string,
): Promise<void> {
  const feishuChatId = chatIdToFeishuChatId(chatId);
  if (!feishuChatId) throw new Error(`Invalid Feishu chatId: ${chatId}`);
  for (const chunk of splitMessage(text)) {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: feishuChatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    });
  }
}

/**
 * Create the Feishu adapter. When `useWebsocket` is true (default), opens
 * a WSClient so events arrive without any public URL on the MOZI side.
 */
export async function createFeishuAdapter(params: {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  handler: MessageHandler;
}): Promise<FeishuAdapter> {
  const { appId, appSecret, handler } = params;
  const domain = params.domain ?? 'feishu';

  const client = new lark.Client({
    appId,
    appSecret,
    domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    disableTokenCache: false,
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      const normalized = normalizeFeishuMessage({ event: (data as { event?: FeishuMessageEvent['event'] }).event } as FeishuMessageEvent);
      if (!normalized) return;
      try {
        const reply = await handler(normalized);
        if (!reply) return;
        const chatId = chatIdToFeishuChatId(normalized.chatId);
        if (!chatId) return;
        for (const chunk of splitMessage(reply)) {
          await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: chunk }),
            },
          });
        }
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Feishu handler threw');
      }
    },
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
  });

  wsClient.start({ eventDispatcher });
  logger.info({ domain }, 'Feishu WSClient connected');

  return {
    client,
    ws: wsClient as unknown as FeishuAdapter['ws'],
    async stop() {
      try {
        const closable = wsClient as unknown as { close?: () => void | Promise<void> };
        if (typeof closable.close === 'function') {
          await closable.close();
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Feishu stop error');
      }
    },
  };
}
