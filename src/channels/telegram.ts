import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import pino from 'pino';
import { writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { detectConfiguredProviders, type ProviderDef } from '../core/providers.js';
import { ensureToolWorkspaceDir } from '../tools/workspace-policy.js';

const logger = pino({ name: 'mozi:telegram' });

/** Telegram message size limit */
const TELEGRAM_MAX_LENGTH = 4096;
const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAX_BYTES_ENV = 'MOZI_UPLOAD_MAX_BYTES';
const CSV_PREVIEW_MAX_ROWS = 50;
const CSV_PREVIEW_MAX_BYTES = 2 * 1024;
const TEXT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.py', '.ts', '.json', '.yaml', '.csv']);

/** Telegram attachment for media and file messages */
export interface Attachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'video_note' | 'audio' | 'animation' | 'sticker';
  path: string;
  mime: string;
  filename?: string;
  content?: string;
  bytes?: Buffer;
}

export interface WorkspaceMessageContext {
  rootPath: string;
  rootKind?: string;
  label?: string;
  gitBranch?: string;
}

/** Standardized message format from any channel */
export interface IncomingMessage {
  /** Plugin id of the channel this message came from (e.g. 'telegram', 'discord'). */
  channelType: string;
  chatId: string;
  tenantId?: string;
  userId: string;
  username: string;
  text: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
  attachments?: Attachment[];
  clientCapabilities?: string[];
  workspaceContext?: WorkspaceMessageContext;
  sessionId?: string;
  replyToText?: string;
  /** Re-run an existing prompt without appending another visible user transcript row. */
  suppressUserMessagePersistence?: boolean;
  /**
   * Server-authoritative turn id, stamped onto this object by `handleMessage`
   * once the turn is registered (Issue #627). Callers must NOT set this — it is
   * an out-parameter so a synchronous reply, delivered after the turn is already
   * unregistered, can still persist/broadcast with the real turn identity.
   */
  turnId?: string;
  /**
   * Transport-scoped identifier of the connection that originated this message
   * (WebSocket only). Lets a channel notify the exact originating socket — e.g.
   * the Issue #627 early session-binding frame — without broadcasting to a
   * user's other connections. Non-WebSocket channels leave it unset.
   */
  originConnectionId?: string;
  timestamp: Date;
}

/** Outgoing message to be sent to Telegram */
export interface OutgoingMessage {
  chatId: string;
  text: string;
  parseMode?: 'Markdown' | 'HTML';
}

/** Message handler callback */
export type MessageHandler = (msg: IncomingMessage) => Promise<string | null>;

/**
 * Convert markdown tables into plain-text list format for Telegram.
 * Uses the header row as labels: "Header1: Cell1 | Header2: Cell2"
 */
function convertMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: current line starts with |, next line is separator |---|
    if (
      lines[i].trimStart().startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|[\s:]*-{2,}/.test(lines[i + 1])
    ) {
      const headers = parseTableRow(lines[i]);
      i += 2; // skip header + separator

      // Process data rows
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        const cells = parseTableRow(lines[i]);
        const parts: string[] = [];
        for (let c = 0; c < cells.length; c++) {
          if (cells[c]) {
            parts.push(headers[c] ? `${headers[c]}: ${cells[c]}` : cells[c]);
          }
        }
        if (parts.length > 0) {
          result.push(parts.join('  |  '));
        }
        i++;
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}

/** Parse a markdown table row into trimmed cell values. */
function parseTableRow(line: string): string[] {
  return line.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
}

/**
 * Telegram chat is currently sent in plain-text mode (no Markdown parse mode),
 * so strip common markdown wrappers to avoid showing raw formatting tokens.
 */
export function normalizeTelegramText(text: string): string {
  if (!text) return '';

  let normalized = text.replace(/\r\n/g, '\n');

  // Markdown links -> "label (url)"
  normalized = normalized.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');

  // Remove fenced code markers but keep content
  normalized = normalized.replace(/```[a-zA-Z0-9_-]*\n?/g, '');
  normalized = normalized.replace(/```/g, '');

  // Convert markdown tables to readable plain text
  normalized = convertMarkdownTables(normalized);

  // Remove heading markers
  normalized = normalized.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  // Normalize list markers
  normalized = normalized.replace(/^\s*[*+]\s+/gm, '- ');

  // Remove paired emphasis wrappers
  normalized = normalized.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  normalized = normalized.replace(/__([^_\n]+)__/g, '$1');
  normalized = normalized.replace(/\*([^*\n]+)\*/g, '$1');
  normalized = normalized.replace(/_([^_\n]+)_/g, '$1');

  // Remove inline-code wrappers
  normalized = normalized.replace(/`([^`\n]+)`/g, '$1');
  normalized = normalized.replace(/`/g, '');

  // Collapse extra blank lines
  normalized = normalized.replace(/\n{3,}/g, '\n\n').trim();

  return normalized.length > 0 ? normalized : text.trim();
}

/**
 * Split a long message into chunks that fit within Telegram's 4096 char limit.
 * Tries to split at newlines for readability.
 */
export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point (newline) within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      // No good newline split — try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // Hard split at limit
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Parse a Telegram message into standardized IncomingMessage format.
 */
function parseMessage(ctx: Context, attachments?: Attachment[]): IncomingMessage | null {
  const msg = ctx.message as {
    chat: { id: number | string };
    from?: { id?: number | string; username?: string; first_name?: string };
    date: number;
    text?: unknown;
    caption?: unknown;
    reply_to_message?: {
      text?: string;
      caption?: string;
      from?: { username?: string; first_name?: string; is_bot?: boolean };
    };
  } | undefined;
  if (!msg) return null;

  const text = typeof msg.text === 'string'
    ? msg.text
    : typeof msg.caption === 'string'
      ? msg.caption
      : '';
  if (!text && (!attachments || attachments.length === 0)) return null;
  const isCommand = text.startsWith('/');

  let command: string | undefined;
  let commandArgs: string | undefined;
  if (isCommand) {
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx > 0) {
      command = text.slice(1, spaceIdx);
      commandArgs = text.slice(spaceIdx + 1).trim();
    } else {
      command = text.slice(1);
    }
    // Strip bot username from command (e.g. /status@MyBot -> status)
    const atIdx = command.indexOf('@');
    if (atIdx > 0) {
      command = command.slice(0, atIdx);
    }
  }

  // Extract quoted/replied message text
  let replyToText: string | undefined;
  const reply = msg.reply_to_message;
  if (reply) {
    const replyContent = reply.text ?? reply.caption;
    if (replyContent) {
      const author = reply.from?.username ?? reply.from?.first_name ?? 'unknown';
      const role = reply.from?.is_bot ? 'assistant' : 'user';
      replyToText = `[Quoted ${role} message from ${author}]: ${replyContent}`;
    }
  }

  return {
    channelType: 'telegram',
    chatId: String(msg.chat.id),
    userId: String(msg.from?.id ?? 'unknown'),
    username: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
    text,
    isCommand,
    command,
    commandArgs,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    replyToText,
    timestamp: new Date(msg.date * 1000),
  };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveUploadMaxBytes(): number {
  const envValue = Number(process.env[UPLOAD_MAX_BYTES_ENV]);
  return Number.isFinite(envValue) && envValue > 0
    ? Math.floor(envValue)
    : DEFAULT_UPLOAD_MAX_BYTES;
}

function assertTelegramFileSize(size: number | undefined): void {
  if (typeof size !== 'number') return;
  const maxBytes = resolveUploadMaxBytes();
  if (size > maxBytes) {
    throw new Error(`Telegram file exceeds ${maxBytes} bytes`);
  }
}

function extensionFromMime(mime: string, fallback = '.bin'): string {
  const normalized = mime.toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('ogg')) return '.ogg';
  if (normalized.includes('json')) return '.json';
  if (normalized.includes('yaml')) return '.yaml';
  if (normalized.includes('csv')) return '.csv';
  if (normalized.includes('markdown')) return '.md';
  if (normalized.includes('plain')) return '.txt';
  return fallback;
}

async function responseToBoundedBuffer(response: Response): Promise<Buffer> {
  const maxBytes = resolveUploadMaxBytes();
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Telegram file exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Telegram file exceeds ${maxBytes} bytes`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Telegram file exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function buildTextAttachmentContent(ext: string, bytes: Buffer): string | undefined {
  if (!TEXT_FILE_EXTENSIONS.has(ext)) return undefined;
  const raw = bytes.toString('utf8');
  if (ext !== '.csv') return raw;

  const rows = raw.split(/\r?\n/);
  const rowLimited = rows.slice(0, CSV_PREVIEW_MAX_ROWS).join('\n');
  const byteLimited = truncateUtf8Bytes(rowLimited, CSV_PREVIEW_MAX_BYTES);
  const truncated = rows.length > CSV_PREVIEW_MAX_ROWS || Buffer.byteLength(rowLimited, 'utf8') > CSV_PREVIEW_MAX_BYTES;
  return truncated
    ? `${byteLimited}\n[CSV preview truncated to first ${CSV_PREVIEW_MAX_ROWS} rows or ${CSV_PREVIEW_MAX_BYTES} bytes]`
    : byteLimited;
}

async function downloadTelegramFile(fileUrl: string | URL, desiredName: string, userId: string): Promise<{ path: string; bytes: Buffer }> {
  const workspaceDir = await ensureToolWorkspaceDir(userId);
  const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeFilename(desiredName)}`;
  const absolutePath = resolve(workspaceDir, uniqueName);

  const response = await fetch(fileUrl.toString(), {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status}`);
  }
  const bytes = await responseToBoundedBuffer(response);
  writeFileSync(absolutePath, bytes);

  return { path: absolutePath, bytes };
}

async function replyWithHandlerResult(ctx: Context, incoming: IncomingMessage, handler: MessageHandler): Promise<void> {
  logger.info({
    chatId: incoming.chatId,
    userId: incoming.userId,
    text: incoming.text.slice(0, 100),
    attachmentCount: incoming.attachments?.length ?? 0,
    attachmentTypes: incoming.attachments?.map(att => att.type) ?? [],
  }, 'Received message');

  try {
    const response = await handler(incoming);
    if (!response) return;

    const chunks = splitMessage(normalizeTelegramText(response));
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, chatId: incoming.chatId }, 'Error handling message');
    const userMsg = errMsg.length > 200 ? errMsg.slice(0, 200) + '...' : errMsg;
    await ctx.reply(`Error: ${userMsg}\n\nPlease try again, or send /help for available commands.`);
  }
}

/**
 * Validate a Telegram bot token by calling the getMe API.
 * Returns bot info if valid, or { valid: false } if not.
 */
export async function validateBotToken(token: string): Promise<{ valid: boolean; username?: string; botName?: string }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as { ok: boolean; result?: { username: string; first_name: string } };
    if (data.ok && data.result) {
      return { valid: true, username: data.result.username, botName: data.result.first_name };
    }
    return { valid: false };
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Bot token validation failed');
    return { valid: false };
  }
}

/**
 * Register bot commands with Telegram via setMyCommands API.
 */
export async function setBotCommands(token: string): Promise<void> {
  const commands = [
    { command: 'help', description: 'Show available commands' },
    { command: 'status', description: 'System status' },
    { command: 'tasks', description: 'List active tasks' },
    { command: 'agents', description: 'List agents' },
    { command: 'skills', description: 'List skills' },
    { command: 'budget', description: 'Token usage' },
    { command: 'model', description: 'Switch LLM model' },
    { command: 'onboard', description: 'Re-run model setup' },
    { command: 'steer', description: 'Nudge the running agent mid-turn' },
  ];

  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(10_000),
    });
    logger.info('Bot commands registered');
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to set bot commands');
  }
}

// ---------------------------------------------------------------------------
// Telegram message control methods
// ---------------------------------------------------------------------------

/**
 * Send a "typing" chat action to indicate the bot is working.
 */
export async function sendTypingAction(bot: Telegraf, chatId: string): Promise<void> {
  try {
    await bot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.warn({ chatId, error: err instanceof Error ? err.message : String(err) }, 'Failed to send typing action');
  }
}

/**
 * Send a text message to a Telegram chat.
 * @returns The message_id of the sent message.
 */
export async function sendMessage(bot: Telegraf, chatId: string, text: string): Promise<number> {
  const chunks = splitMessage(normalizeTelegramText(text));
  let lastMessageId = 0;
  for (const chunk of chunks) {
    const sent = await bot.telegram.sendMessage(chatId, chunk);
    lastMessageId = sent.message_id;
  }
  return lastMessageId;
}

/**
 * Send a direct message to a Telegram user by chat ID.
 * Convenience wrapper for pairing approval notifications and similar use cases.
 */
export async function sendDirectMessage(bot: Telegraf, chatId: string, text: string): Promise<void> {
  try {
    const chunks = splitMessage(normalizeTelegramText(text));
    for (const chunk of chunks) {
      await bot.telegram.sendMessage(chatId, chunk);
    }
  } catch (err) {
    logger.warn({ chatId, error: err instanceof Error ? err.message : String(err) }, 'Failed to send direct message');
  }
}

/**
 * Edit an existing text message in a Telegram chat.
 */
export async function editMessage(bot: Telegraf, chatId: string, messageId: number, text: string): Promise<void> {
  try {
    await bot.telegram.editMessageText(chatId, messageId, undefined, normalizeTelegramText(text));
  } catch (err) {
    // Telegram returns 400 if message content hasn't changed — ignore
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('message is not modified')) {
      logger.warn({ chatId, messageId, error: msg }, 'Failed to edit message');
    }
  }
}

/**
 * Delete a message from a Telegram chat.
 */
export async function deleteMessage(bot: Telegraf, chatId: string, messageId: number): Promise<void> {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch (err) {
    logger.warn({ chatId, messageId, error: err instanceof Error ? err.message : String(err) }, 'Failed to delete message');
  }
}

/**
 * Send a local file to a Telegram chat.
 */
export async function sendFile(bot: Telegraf, chatId: string, filePath: string, caption?: string): Promise<void> {
  await bot.telegram.sendDocument(chatId, { source: filePath }, caption ? { caption } : undefined);
}

// ---------------------------------------------------------------------------
// Draft message support (Telegram sendMessageDraft API — experimental)
// ---------------------------------------------------------------------------

export interface SendDraftResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a draft message update (Telegram Bot API sendMessageDraft).
 * This is an experimental Telegram API — may not be available on all
 * bot API servers or group chats. Callers should gracefully degrade.
 */
export async function sendMessageDraft(
  bot: Telegraf,
  chatId: string,
  text: string,
  draftId: number,
  options?: { parse_mode?: string },
): Promise<SendDraftResult> {
  try {
    await (bot.telegram as any).callApi('sendMessageDraft', {
      chat_id: chatId,
      text,
      draft_id: draftId,
      ...(options?.parse_mode ? { parse_mode: options.parse_mode } : {}),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convert Markdown to Telegram HTML for parse_mode: 'HTML'.
 * Handles: headings→bold, code blocks→pre, inline code, bold, italic,
 * links, tables→plain text, horizontal rules, and HTML entity escaping.
 */
export function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Extract code blocks first to protect them from other transformations
  const codeBlocks: string[] = [];
  html = html.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // Extract inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE_${idx}\x00`;
  });

  // Convert markdown tables to plain text (key: value format)
  html = html.replace(/^(\|[^\n]+\|)\n(\|[-: |]+\|)\n((?:\|[^\n]+\|\n?)+)/gm, (_match, headerRow: string, _sepRow: string, bodyRows: string) => {
    const headers = headerRow.split('|').map((h: string) => h.trim()).filter(Boolean);
    const rows = bodyRows.trim().split('\n');
    const lines: string[] = [];
    for (const row of rows) {
      const cells = row.split('|').map((c: string) => c.trim()).filter(Boolean);
      const parts: string[] = [];
      for (let i = 0; i < cells.length; i++) {
        if (headers[i]) {
          parts.push(`${headers[i]}: ${cells[i]}`);
        }
      }
      lines.push(parts.join(', '));
    }
    return lines.join('\n');
  });

  // Remove horizontal rules
  html = html.replace(/^-{3,}$/gm, '');
  html = html.replace(/^\*{3,}$/gm, '');

  // Escape HTML special characters (before adding HTML tags)
  html = html.replace(/&/g, '&amp;');
  html = html.replace(/</g, '&lt;');
  html = html.replace(/>/g, '&gt;');

  // Headings → bold (## Heading → <b>Heading</b>)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic (*text* or _text_)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks
  html = html.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_match, idx: string) => {
    return `<pre>${codeBlocks[parseInt(idx)]}</pre>`;
  });

  // Restore inline code
  html = html.replace(/\x00INLINE_(\d+)\x00/g, (_match, idx: string) => {
    return `<code>${inlineCodes[parseInt(idx)]}</code>`;
  });

  // Clean up extra blank lines
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

/**
 * Check if a string looks like a Telegram chat ID (numeric, possibly negative for groups).
 */
export function isTelegramChatId(value: string): boolean {
  return /^-?\d+$/.test(value);
}

// ---------------------------------------------------------------------------
// Model selection — in-memory per-user override
// ---------------------------------------------------------------------------

/** Per-user model override: userId → { provider, model } */
export const userModelOverrides = new Map<string, { provider: string; model: string }>();

/** Get the user's current model override, if any. */
export function getUserModelOverride(userId: string): { provider: string; model: string } | undefined {
  return userModelOverrides.get(userId);
}

const MODELS_PER_PAGE = 8;

/** Build inline keyboard rows for provider selection. */
function buildProviderKeyboard(providers: ProviderDef[]): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < providers.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    row.push({ text: providers[i].name, callback_data: `mdl_list_${providers[i].id}_0` });
    if (i + 1 < providers.length) {
      row.push({ text: providers[i + 1].name, callback_data: `mdl_list_${providers[i + 1].id}_0` });
    }
    rows.push(row);
  }
  return rows;
}

/** Build inline keyboard for model list (paginated) with Back button. */
function buildModelKeyboard(
  provider: ProviderDef,
  page: number,
): Array<Array<{ text: string; callback_data: string }>> {
  const models = provider.models;
  const start = page * MODELS_PER_PAGE;
  const pageModels = models.slice(start, start + MODELS_PER_PAGE);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const m of pageModels) {
    rows.push([{ text: m.name, callback_data: `mdl_sel_${provider.id}:${m.id}` }]);
  }

  // Navigation row
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) {
    nav.push({ text: '← Prev', callback_data: `mdl_list_${provider.id}_${page - 1}` });
  }
  nav.push({ text: '↩ Back', callback_data: 'mdl_prov' });
  if (start + MODELS_PER_PAGE < models.length) {
    nav.push({ text: 'Next →', callback_data: `mdl_list_${provider.id}_${page + 1}` });
  }
  rows.push(nav);

  return rows;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Return value from createTelegramAdapter — exposes bot + launch */
export interface TelegramAdapter {
  bot: Telegraf;
  launch: () => void;
}

/**
 * Create and configure the Telegram bot adapter.
 * Messages are received, parsed into standard format, and passed to the handler.
 * Responses from the handler are sent back to Telegram, split if necessary.
 *
 * Returns { bot, launch } so callers can access the bot instance for
 * control methods (sendTypingAction, editMessage, etc.).
 */
export function createTelegramAdapter(botToken: string, handler: MessageHandler): TelegramAdapter {
  const bot = new Telegraf(botToken);

  // /model command — show provider selection inline keyboard
  bot.command('model', async (ctx) => {
    const providers = detectConfiguredProviders();
    if (providers.length === 0) {
      await ctx.reply('No LLM providers configured. Run /onboard to set up a provider.');
      return;
    }

    const userId = String(ctx.from?.id ?? 'unknown');
    const current = userModelOverrides.get(userId);
    const header = current
      ? `Current model: ${current.model}\nSelect a provider to switch:`
      : 'Select a provider:';

    await ctx.reply(header, {
      reply_markup: { inline_keyboard: buildProviderKeyboard(providers) },
    });
  });

  // Callback query handler for model selection inline keyboard
  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data;
    if (!data || !data.startsWith('mdl_')) return;

    const userId = String(ctx.from?.id ?? 'unknown');

    if (data === 'mdl_prov') {
      // Show provider list
      const providers = detectConfiguredProviders();
      const current = userModelOverrides.get(userId);
      const header = current
        ? `Current model: ${current.model}\nSelect a provider to switch:`
        : 'Select a provider:';
      await ctx.editMessageText(header, {
        reply_markup: { inline_keyboard: buildProviderKeyboard(providers) },
      });
      await ctx.answerCbQuery();
      return;
    }

    const listMatch = /^mdl_list_([^_]+)_(\d+)$/.exec(data);
    if (listMatch) {
      const providerId = listMatch[1];
      const page = parseInt(listMatch[2], 10);
      const providers = detectConfiguredProviders();
      const provider = providers.find(p => p.id === providerId);
      if (!provider) {
        await ctx.answerCbQuery('Provider not found');
        return;
      }
      await ctx.editMessageText(`${provider.name} models:`, {
        reply_markup: { inline_keyboard: buildModelKeyboard(provider, page) },
      });
      await ctx.answerCbQuery();
      return;
    }

    const selMatch = /^mdl_sel_(.+):(.+)$/.exec(data);
    if (selMatch) {
      const providerId = selMatch[1];
      const modelId = selMatch[2];
      const providers = detectConfiguredProviders();
      const provider = providers.find(p => p.id === providerId);
      const modelDef = provider?.models.find(m => m.id === modelId);
      const modelName = modelDef?.name ?? modelId;

      userModelOverrides.set(userId, { provider: providerId, model: modelId });
      logger.info({ userId, provider: providerId, model: modelId }, 'User switched model');

      await ctx.editMessageText(`Model switched to: ${modelName} (${provider?.name ?? providerId})`);
      await ctx.answerCbQuery(`Switched to ${modelName}`);
      return;
    }

    await ctx.answerCbQuery();
  });

  bot.on('text', async (ctx) => {
    const incoming = parseMessage(ctx);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('photo', async (ctx) => {
    const msg = ctx.message as { photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }> } | undefined;
    const sizes = msg?.photo;
    if (!sizes || sizes.length === 0) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      const largest = sizes.reduce((best, current) => {
        const bestSize = best.file_size ?? (best.width * best.height);
        const currentSize = current.file_size ?? (current.width * current.height);
        return currentSize > bestSize ? current : best;
      });
      assertTelegramFileSize(largest.file_size);
      const fileUrl = await ctx.telegram.getFileLink(largest.file_id);
      const { path, bytes } = await downloadTelegramFile(fileUrl, `${largest.file_id}.jpg`, userId);
      attachment = {
        type: 'photo',
        path,
        mime: 'image/jpeg',
        filename: basename(path),
        bytes,
      };
    } catch (err) {
      logger.warn({ err, updateType: 'photo' }, 'Failed to download photo attachment');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('document', async (ctx) => {
    const msg = ctx.message as {
      document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    } | undefined;
    const document = msg?.document;
    if (!document) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(document.file_size);
      const filename = document.file_name ?? `${document.file_id}${extensionFromMime(document.mime_type ?? '')}`;
      const fileUrl = await ctx.telegram.getFileLink(document.file_id);
      const { path, bytes } = await downloadTelegramFile(fileUrl, filename, userId);
      const ext = extname(filename).toLowerCase();
      const content = buildTextAttachmentContent(ext, bytes);
      attachment = {
        type: 'document',
        path,
        mime: document.mime_type ?? 'application/octet-stream',
        filename,
        content,
      };
    } catch (err) {
      logger.warn({ err, updateType: 'document' }, 'Failed to download document attachment');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('voice', async (ctx) => {
    const msg = ctx.message as {
      voice?: { file_id: string; mime_type?: string; file_size?: number };
    } | undefined;
    const voice = msg?.voice;
    if (!voice) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(voice.file_size);
      const fileUrl = await ctx.telegram.getFileLink(voice.file_id);
      const { path } = await downloadTelegramFile(fileUrl, `${voice.file_id}.ogg`, userId);
      attachment = {
        type: 'voice',
        path,
        mime: voice.mime_type ?? 'audio/ogg',
        filename: basename(path),
      };
    } catch (err) {
      logger.warn({ err, updateType: 'voice' }, 'Failed to download voice attachment');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('video', async (ctx) => {
    const msg = ctx.message as {
      video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    } | undefined;
    const video = msg?.video;
    if (!video) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(video.file_size);
      const filename = video.file_name ?? `${video.file_id}.mp4`;
      const fileUrl = await ctx.telegram.getFileLink(video.file_id);
      const { path } = await downloadTelegramFile(fileUrl, filename, userId);
      attachment = {
        type: 'video',
        path,
        mime: video.mime_type ?? 'video/mp4',
        filename,
      };
    } catch (err) {
      logger.warn({ err, updateType: 'video' }, 'Failed to download video attachment');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('video_note', async (ctx) => {
    const msg = ctx.message as {
      video_note?: { file_id: string; file_size?: number };
    } | undefined;
    const videoNote = msg?.video_note;
    if (!videoNote) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(videoNote.file_size);
      const fileUrl = await ctx.telegram.getFileLink(videoNote.file_id);
      const { path } = await downloadTelegramFile(fileUrl, `${videoNote.file_id}.mp4`, userId);
      attachment = {
        type: 'video_note',
        path,
        mime: 'video/mp4',
        filename: basename(path),
      };
    } catch (err) {
      logger.warn({ err, updateType: 'video_note' }, 'Failed to download video note');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('audio', async (ctx) => {
    const msg = ctx.message as {
      audio?: { file_id: string; file_name?: string; mime_type?: string; title?: string; performer?: string; file_size?: number };
    } | undefined;
    const audio = msg?.audio;
    if (!audio) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(audio.file_size);
      const filename = audio.file_name ?? `${audio.file_id}${extensionFromMime(audio.mime_type ?? 'audio/mpeg')}`;
      const fileUrl = await ctx.telegram.getFileLink(audio.file_id);
      const { path } = await downloadTelegramFile(fileUrl, filename, userId);
      attachment = {
        type: 'audio',
        path,
        mime: audio.mime_type ?? 'audio/mpeg',
        filename,
        content: [audio.title, audio.performer].filter(Boolean).join(' - ') || undefined,
      };
    } catch (err) {
      logger.warn({ err, updateType: 'audio' }, 'Failed to download audio attachment');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('animation', async (ctx) => {
    const msg = ctx.message as {
      animation?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    } | undefined;
    const animation = msg?.animation;
    if (!animation) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(animation.file_size);
      const filename = animation.file_name ?? `${animation.file_id}.mp4`;
      const fileUrl = await ctx.telegram.getFileLink(animation.file_id);
      const { path } = await downloadTelegramFile(fileUrl, filename, userId);
      attachment = {
        type: 'animation',
        path,
        mime: animation.mime_type ?? 'video/mp4',
        filename,
      };
    } catch (err) {
      logger.warn({ err, updateType: 'animation' }, 'Failed to download animation');
    }

    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (!incoming) return;
    await replyWithHandlerResult(ctx, incoming, handler);
  });

  bot.on('sticker', async (ctx) => {
    const msg = ctx.message as {
      sticker?: { file_id: string; emoji?: string; set_name?: string; is_animated?: boolean; is_video?: boolean; file_size?: number };
    } | undefined;
    const sticker = msg?.sticker;
    if (!sticker) return;
    const userId = String(ctx.from?.id ?? 'unknown');

    let attachment: Attachment | undefined;
    try {
      assertTelegramFileSize(sticker.file_size);
      const ext = sticker.is_video ? '.webm' : sticker.is_animated ? '.tgs' : '.webp';
      const fileUrl = await ctx.telegram.getFileLink(sticker.file_id);
      const { path } = await downloadTelegramFile(fileUrl, `${sticker.file_id}${ext}`, userId);
      const stickerMeta = [
        sticker.emoji ? `emoji: ${sticker.emoji}` : null,
        sticker.set_name ? `set: ${sticker.set_name}` : null,
      ].filter(Boolean).join(', ');
      attachment = {
        type: 'sticker',
        path,
        mime: sticker.is_video ? 'video/webm' : 'image/webp',
        filename: basename(path),
        content: stickerMeta || undefined,
      };
    } catch (err) {
      logger.warn({ err, updateType: 'sticker' }, 'Failed to download sticker');
    }

    // Build a synthetic text context for sticker so handler receives something
    const stickerText = sticker.emoji ? `[Sticker: ${sticker.emoji}]` : '[Sticker]';
    const incoming = parseMessage(ctx, attachment ? [attachment] : undefined);
    if (incoming) {
      if (!incoming.text) incoming.text = stickerText;
      await replyWithHandlerResult(ctx, incoming, handler);
    } else {
      // parseMessage returns null when text+attachments are empty; force through
      const fallback: IncomingMessage = {
        channelType: 'telegram',
        chatId: String((ctx.message as { chat: { id: number } }).chat.id),
        userId: String((ctx.message as { from?: { id?: number } })?.from?.id ?? 'unknown'),
        username: (ctx.message as { from?: { username?: string; first_name?: string } })?.from?.username ?? 'unknown',
        text: stickerText,
        isCommand: false,
        attachments: attachment ? [attachment] : undefined,
        timestamp: new Date(),
      };
      await replyWithHandlerResult(ctx, fallback, handler);
    }
  });

  // Fallback for unhandled message types
  bot.on('message', async (ctx) => {
    const msg = ctx.message as unknown as Record<string, unknown> | undefined;
    if (!msg) return;
    // Skip types already handled above
    if (msg.text || msg.photo || msg.document || msg.voice || msg.video
      || msg.video_note || msg.audio || msg.animation || msg.sticker) return;

    const chatId = String((msg.chat as { id: number }).id);
    logger.info({ chatId, keys: Object.keys(msg).slice(0, 10) }, 'Unhandled message type received');
    await ctx.reply('This message type is not supported yet. Please send text, photos, documents, videos, audio, or voice messages.');
  });

  bot.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  return {
    bot,
    launch: () => bot.launch(),
  };
}
