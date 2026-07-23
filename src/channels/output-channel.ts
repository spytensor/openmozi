import { extname } from 'node:path';
import type { Telegraf } from 'telegraf';

// OUTPUTCHANNEL SPEC - This is a MESSAGE PIPE, NOT a callback system
// The handler should USE this to send messages, not receive callbacks

export interface OutputChannel {
  // Channel identification
  readonly channelType: string;
  readonly chatId: string;

  // Core message operations - these are how the handler SENDS output
  send(text: string): Promise<number>;      // returns messageId for editing
  edit(messageId: number, text: string): Promise<void>;
  delete(messageId: number): Promise<void>;

  // File sending (optional — only channels that support it implement this)
  sendFile?(filePath: string, caption?: string): Promise<void>;
  shouldAutoSendFile?(filePath: string): boolean;

  /** Send an approval request with inline action buttons (Approve/Reject) */
  sendApproval?(text: string, requestId: string): Promise<number>;

  /** Let a channel suppress or trim final output after streaming already exposed it. */
  prepareFinalText?(text: string): Promise<string | null> | string | null;

  // Utility
  sendTyping(): Promise<void>;
}

// NOT callbacks. These are helper methods the handler calls.
// ProgressCallback is separate and stays in handler.ts for progress updates.

const TELEGRAM_AUTO_SEND_FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.pdf',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.mov',
  '.webm',
]);

export class TelegramOutputChannel implements OutputChannel {
  private preferredMessageId: number | null = null;
  private preferredMessagePromise: Promise<number> | null = null;
  private appendPlannedSnapshot = '';
  private appendDeliveredSnapshot = '';
  private appendStreamDiverged = false;
  private appendSendChain: Promise<void> = Promise.resolve();
  private draftStreamUsed = false;

  constructor(
    private bot: Telegraf,
    public readonly chatId: string,
    public readonly channelType: 'telegram' = 'telegram'
  ) {}

  /**
   * Prefer editing this message for final send() output.
   * Used by Telegram edit streaming mode to avoid duplicate final messages.
   */
  adoptMessage(messageId: number): void {
    this.preferredMessageId = messageId;
    this.preferredMessagePromise = null;
  }

  adoptPendingMessage(messagePromise: Promise<number>): void {
    this.preferredMessagePromise = messagePromise;
  }

  clearAdoptedMessage(): void {
    this.preferredMessageId = null;
    this.preferredMessagePromise = null;
  }

  /**
   * Mark that native draft streaming (sendMessageDraft) was used for this turn.
   * When set, `send()` will always create a new message instead of editing,
   * because the draft is ephemeral and disappears on its own.
   */
  markDraftStreamUsed(): void {
    this.draftStreamUsed = true;
    // Draft mode has no adopted message — clear any stale state
    this.preferredMessageId = null;
    this.preferredMessagePromise = null;
  }

  queueAppendStreamSnapshot(text: string): void {
    const snapshot = text || '';
    if (!snapshot) return;
    if (this.appendStreamDiverged) return;

    const previousPlanned = this.appendPlannedSnapshot;
    if (previousPlanned && !snapshot.startsWith(previousPlanned)) {
      this.appendStreamDiverged = true;
      return;
    }

    const rawDelta = snapshot.slice(previousPlanned.length);
    this.appendPlannedSnapshot = snapshot;
    const delta = previousPlanned ? rawDelta.replace(/^\s+/, '') : rawDelta;
    if (!delta.trim()) return;

    const sendChunk = async () => {
      const { sendMessage } = await import('./telegram.js');
      await sendMessage(this.bot, this.chatId, delta);
      this.appendDeliveredSnapshot = snapshot;
    };

    const next = this.appendSendChain.then(sendChunk);
    this.appendSendChain = next.catch(() => {});
  }

  resetStreamState(): void {
    this.appendPlannedSnapshot = '';
    this.appendDeliveredSnapshot = '';
    this.appendStreamDiverged = false;
    this.appendSendChain = Promise.resolve();
  }

  async prepareFinalText(text: string): Promise<string | null> {
    // Draft mode: the draft is ephemeral and already gone. Always send the
    // full final message as a new sendMessage — no dedup needed.
    if (this.draftStreamUsed) {
      this.draftStreamUsed = false;
      this.resetStreamState();
      return text;
    }

    if (this.preferredMessageId !== null || this.preferredMessagePromise) {
      this.resetStreamState();
      return text;
    }

    const finalText = text || '';
    if (!this.appendPlannedSnapshot && !this.appendDeliveredSnapshot && !this.appendStreamDiverged) {
      return finalText;
    }

    await this.appendSendChain;
    const delivered = this.appendDeliveredSnapshot;
    const diverged = this.appendStreamDiverged;
    this.resetStreamState();

    if (!finalText.trim()) return null;
    if (diverged || !delivered) return finalText;
    if (finalText === delivered) return null;
    if (finalText.startsWith(delivered)) {
      const remainder = finalText.slice(delivered.length).replace(/^\s+/, '');
      return remainder.trim() ? remainder : null;
    }
    return finalText;
  }

  async send(text: string): Promise<number> {
    if (this.preferredMessageId === null && this.preferredMessagePromise) {
      try {
        this.preferredMessageId = await this.preferredMessagePromise;
      } catch {
        this.preferredMessageId = null;
      } finally {
        this.preferredMessagePromise = null;
      }
    }
    if (this.preferredMessageId !== null) {
      const { editMessage } = await import('./telegram.js');
      await editMessage(this.bot, this.chatId, this.preferredMessageId, text);
      return this.preferredMessageId;
    }
    const { sendMessage } = await import('./telegram.js');
    return sendMessage(this.bot, this.chatId, text);
  }

  async edit(messageId: number, text: string): Promise<void> {
    const { editMessage } = await import('./telegram.js');
    await editMessage(this.bot, this.chatId, messageId, text);
  }

  async delete(messageId: number): Promise<void> {
    await this.bot.telegram.deleteMessage(this.chatId, messageId);
  }

  async sendFile(filePath: string, caption?: string): Promise<void> {
    const { sendFile } = await import('./telegram.js');
    await sendFile(this.bot, this.chatId, filePath, caption);
  }

  shouldAutoSendFile(_filePath: string): boolean {
    // Always send files created by Mozi — user's agent should show what it produces.
    return true;
  }

  async sendApproval(text: string, requestId: string): Promise<number> {
    try {
      const sent = await this.bot.telegram.sendMessage(this.chatId, text, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${requestId}` },
            { text: '❌ Reject', callback_data: `reject:${requestId}` },
          ]],
        },
      });
      return sent.message_id;
    } catch {
      // Fallback to plain text if inline keyboard fails
      const { sendMessage } = await import('./telegram.js');
      return sendMessage(this.bot, this.chatId, text);
    }
  }

  async sendTyping(): Promise<void> {
    await this.bot.telegram.sendChatAction(this.chatId, 'typing');
  }
}

export class WebSocketOutputChannel implements OutputChannel {
  constructor(
    private ws: any,
    public readonly chatId: string,
    public readonly channelType: 'websocket' = 'websocket'
  ) {}
  
  async send(text: string): Promise<number> {
    const id = Date.now(); // simple message ID
    this.ws.send(JSON.stringify({ type: 'message', id, text }));
    return id;
  }
  
  async edit(messageId: number, text: string): Promise<void> {
    this.ws.send(JSON.stringify({ type: 'edit', id: messageId, text }));
  }
  
  async delete(messageId: number): Promise<void> {
    this.ws.send(JSON.stringify({ type: 'delete', id: messageId }));
  }
  
  async sendApproval(text: string, requestId: string): Promise<number> {
    const id = Date.now();
    this.ws.send(JSON.stringify({
      type: 'approval',
      id,
      text,
      requestId,
      options: ['approve', 'reject'],
    }));
    return id;
  }

  async sendTyping(): Promise<void> {
    this.ws.send(JSON.stringify({ type: 'typing' }));
  }
}
