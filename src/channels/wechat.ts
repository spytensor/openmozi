/**
 * WeChat iLink Bot L0 Channel Adapter
 *
 * Uses the official WeChat iLink Bot protocol (ClawBot plugin):
 * - QR code login → bot_token
 * - Long-polling via GET /ilink/bot/getupdates
 * - Reply via POST /ilink/bot/sendmessage (requires context_token)
 *
 * No AppID/AppSecret needed. No public IP needed. Scans QR code to pair.
 */
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, MessageHandler } from './telegram.js';
import type { OutputChannel } from './output-channel.js';

const logger = pino({ name: 'mozi:wechat' });

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const POLL_TIMEOUT_MS = 35_000;

// ── iLink Bot Types ─────────────────────────────────────────────────

export interface ILinkMessage {
  msg_type: number;       // 1=text, 2=image, 3=voice, 4=file, 5=video
  content?: string;       // text content (msg_type=1)
  context_token: string;  // must echo back when replying
  from_user?: string;     // sender identifier
  create_time?: number;   // unix timestamp
}

interface ILinkPollResponse {
  messages?: ILinkMessage[];
  get_updates_buf?: string;  // cursor for next poll
  timeout?: number;
  errcode?: number;
  errmsg?: string;
}

interface ILinkQrCodeResponse {
  qrcode?: string;
  qrcode_url?: string;
  errcode?: number;
  errmsg?: string;
}

interface ILinkQrCodeStatusResponse {
  status?: string;         // 'waiting' | 'scanned' | 'confirmed'
  bot_token?: string;      // returned on confirmation
  errcode?: number;
  errmsg?: string;
}

interface ILinkSendResponse {
  errcode?: number;
  errmsg?: string;
}

// ── Auth Header Generation ──────────────────────────────────────────

/**
 * Generate X-WECHAT-UIN header value.
 * A random uint32 converted to decimal string, then base64-encoded.
 * Rotates per-request for replay protection.
 */
export function generateWeChatUin(): string {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0);
  return Buffer.from(num.toString(10)).toString('base64');
}

function makeHeaders(botToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${botToken}`,
    'X-WECHAT-UIN': generateWeChatUin(),
  };
}

// ── QR Code Login Flow ──────────────────────────────────────────────

/**
 * Request a QR code for WeChat ClawBot pairing.
 * Returns a qrcode identifier and optionally a URL to display.
 */
export async function requestQrCode(): Promise<{ qrcode: string; qrcodeUrl?: string }> {
  const url = `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`iLink QR code request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as ILinkQrCodeResponse;
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`iLink QR code error: ${body.errcode} ${body.errmsg}`);
  }
  if (!body.qrcode) {
    throw new Error('iLink QR code response missing qrcode field');
  }
  return { qrcode: body.qrcode, qrcodeUrl: body.qrcode_url };
}

/**
 * Poll for QR code scan confirmation.
 * Returns bot_token once the user confirms on their phone.
 */
export async function pollQrCodeStatus(
  qrcode: string,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`iLink QR status request failed: ${res.status}`);
    }
    const body = await res.json() as ILinkQrCodeStatusResponse;
    if (body.errcode && body.errcode !== 0) {
      throw new Error(`iLink QR status error: ${body.errcode} ${body.errmsg}`);
    }
    if (body.status === 'confirmed' && body.bot_token) {
      return body.bot_token;
    }
    // Wait before next poll
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('QR code scan timed out');
}

// ── Long-Polling Message Loop ───────────────────────────────────────

/** Shared state for the polling loop */
let pollingActive = false;
let pollingAbort: AbortController | null = null;

/**
 * Start the iLink Bot long-polling loop.
 * Receives messages and dispatches them to the handler.
 */
export function startPolling(
  botToken: string,
  handler: MessageHandler,
): void {
  if (pollingActive) {
    logger.warn('WeChat iLink polling already active');
    return;
  }
  pollingActive = true;
  pollingAbort = new AbortController();

  void pollLoop(botToken, handler, pollingAbort.signal);
  logger.info('WeChat iLink Bot polling started');
}

/** Stop the long-polling loop. */
export function stopPolling(): void {
  pollingActive = false;
  if (pollingAbort) {
    pollingAbort.abort();
    pollingAbort = null;
  }
  logger.info('WeChat iLink Bot polling stopped');
}

async function pollLoop(
  botToken: string,
  handler: MessageHandler,
  signal: AbortSignal,
): Promise<void> {
  let cursor = '';

  while (!signal.aborted) {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('get_updates_buf', cursor);
      params.set('timeout', String(Math.floor(POLL_TIMEOUT_MS / 1000)));

      const url = `${ILINK_BASE}/ilink/bot/getupdates?${params}`;
      const res = await fetch(url, {
        headers: makeHeaders(botToken),
        signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS + 10_000)]),
      });

      if (!res.ok) {
        logger.error({ status: res.status }, 'iLink getupdates HTTP error');
        await sleep(5000, signal);
        continue;
      }

      const body = await res.json() as ILinkPollResponse;

      if (body.errcode && body.errcode !== 0) {
        logger.error({ errcode: body.errcode, errmsg: body.errmsg }, 'iLink getupdates error');
        await sleep(5000, signal);
        continue;
      }

      // Update cursor for next poll
      if (body.get_updates_buf) {
        cursor = body.get_updates_buf;
      }

      // Process received messages
      if (body.messages && body.messages.length > 0) {
        for (const msg of body.messages) {
          void handleILinkMessage(msg, botToken, handler).catch(err => {
            logger.error({ err, from: msg.from_user }, 'Failed to handle iLink message');
          });
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) break;
      // Network errors — back off and retry
      logger.error({ err }, 'iLink poll error');
      await sleep(5000, signal);
    }
  }
}

async function handleILinkMessage(
  msg: ILinkMessage,
  botToken: string,
  handler: MessageHandler,
): Promise<void> {
  const incoming = normalizeILinkMessage(msg);
  if (!incoming) return;

  const outputChannel = new WeChatOutputChannel(
    incoming.chatId,
    botToken,
    msg.context_token,
  );

  try {
    await outputChannel.sendTyping();
    const result = await handler(incoming);
    if (result) {
      await outputChannel.send(result);
    }
  } catch (err) {
    logger.error({ err, chatId: incoming.chatId }, 'WeChat message handling failed');
    try {
      await outputChannel.send('处理消息时出错，请稍后重试。');
    } catch {
      // Best-effort error notification
    }
  }
}

// ── Message Normalization ───────────────────────────────────────────

/**
 * Convert an iLink Bot message into the standardized IncomingMessage format.
 *
 * Supported msg_type values:
 * - 1: text
 * - 3: voice (content = recognized text, if available)
 *
 * Deferred: 2 (image), 4 (file), 5 (video)
 */
export function normalizeILinkMessage(msg: ILinkMessage): IncomingMessage | null {
  let text = '';

  if (msg.msg_type === 1) {
    // Text message
    text = msg.content ?? '';
  } else if (msg.msg_type === 3 && msg.content) {
    // Voice with recognition
    text = msg.content;
  } else {
    logger.debug({ msgType: msg.msg_type }, 'Skipping unsupported iLink message type');
    return null;
  }

  if (!text.trim()) return null;

  const chatId = msg.from_user ?? 'unknown';
  const isCommand = text.startsWith('/');
  let command: string | undefined;
  let commandArgs: string | undefined;
  if (isCommand) {
    const spaceIdx = text.indexOf(' ');
    command = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
    commandArgs = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
  }

  return {
    channelType: 'wechat',
    chatId,
    userId: chatId,
    username: chatId,
    text,
    isCommand,
    command,
    commandArgs,
    timestamp: new Date((msg.create_time ?? Math.floor(Date.now() / 1000)) * 1000),
  };
}

// ── Send Message ────────────────────────────────────────────────────

/** WeChat text message limit */
const WECHAT_TEXT_MAX_LENGTH = 2048;

/**
 * Split long text into chunks respecting WeChat's 2048 char limit.
 */
export function splitMessage(text: string, maxLength = WECHAT_TEXT_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Prefer splitting at newline
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.3) {
      // No good newline break; try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      splitAt = maxLength; // hard cut
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/**
 * Send a text message via iLink Bot sendmessage API.
 * Requires a context_token from the original incoming message.
 */
async function sendILinkMessage(
  botToken: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const url = `${ILINK_BASE}/ilink/bot/sendmessage`;
    const body = {
      context_token: contextToken,
      msg_type: 1,  // text
      content: chunk,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: makeHeaders(botToken),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'iLink sendmessage HTTP error');
      return;
    }
    const result = await res.json() as ILinkSendResponse;
    if (result.errcode && result.errcode !== 0) {
      logger.error({ errcode: result.errcode, errmsg: result.errmsg }, 'iLink sendmessage error');
    }
  }
}

// ── Output Channel ──────────────────────────────────────────────────

export class WeChatOutputChannel implements OutputChannel {
  readonly channelType = 'wechat' as const;
  private messageCounter = 0;

  constructor(
    public readonly chatId: string,
    private botToken: string,
    private contextToken: string,
  ) {}

  async send(text: string): Promise<number> {
    await sendILinkMessage(this.botToken, this.contextToken, text);
    return ++this.messageCounter;
  }

  async edit(_messageId: number, text: string): Promise<void> {
    // iLink Bot doesn't support message editing — send a new message
    await this.send(text);
  }

  async delete(_messageId: number): Promise<void> {
    // iLink Bot doesn't support message deletion
    logger.debug('WeChat iLink Bot does not support message deletion');
  }

  async sendTyping(): Promise<void> {
    // iLink Bot typing indicator — best effort, may not be supported
    try {
      const url = `${ILINK_BASE}/ilink/bot/sendaction`;
      await fetch(url, {
        method: 'POST',
        headers: makeHeaders(this.botToken),
        body: JSON.stringify({
          context_token: this.contextToken,
          action: 'typing',
        }),
      });
    } catch {
      // Non-critical — ignore
    }
  }
}

// ── User ID Detection ───────────────────────────────────────────────

/**
 * Check if a chatId looks like a WeChat iLink user ID.
 * iLink user IDs are alphanumeric strings, typically 20-40 chars.
 */
export function isWeChatUserId(chatId: string): boolean {
  return /^[a-zA-Z0-9_-]{20,40}$/.test(chatId);
}

// ── Utilities ───────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
