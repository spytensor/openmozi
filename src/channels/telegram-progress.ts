import type { Telegraf } from 'telegraf';
import pino from 'pino';
import { getConfig } from '../config/index.js';
import type { ProgressCallback } from '../gateway/handler.js';
import {
  sendTypingAction,
  sendMessage as tgSendMessage,
  editMessage as tgEditMessage,
  deleteMessage as tgDeleteMessage,
  sendMessageDraft as tgSendMessageDraft,
  markdownToTelegramHtml,
  splitMessage,
} from './telegram.js';
import { TelegramOutputChannel } from './output-channel.js';

const logger = pino({ name: 'mozi:telegram-progress' });

/** Typing indicator interval in ms (Telegram requires re-sending every ~5s) */
const TYPING_INTERVAL_MS = 4_000;

/**
 * Minimum interval between sendMessageDraft calls.
 * Draft transport has lighter rate-limits than editMessageText (~1/s),
 * but we still debounce to avoid flooding.
 */
const DRAFT_MIN_INTERVAL_MS = 300;

export function createTelegramProgress(
  bot: Telegraf,
  chatId: string,
  outputChannel?: TelegramOutputChannel,
): { progress: ProgressCallback; cleanup: () => Promise<void> } {
  const telegramConfig = getConfig().telegram;
  let streamMode = telegramConfig.stream_mode;
  const streamEditIntervalMs = telegramConfig.stream_edit_interval_ms;
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let streamMessageId: number | null = null;
  let streamMessagePending = false;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingStreamText: string | null = null;
  let lastStreamText = '';

  // Draft mode state
  let draftAvailable: boolean | null = null; // null = not probed yet
  let draftLastSentAt = 0;
  // Stable draft_id for the entire streaming turn (int64 range)
  const draftId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  /** Stop the typing heartbeat if it is running. */
  function stopTypingHeartbeat(): void {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  /**
   * Effective stream mode: starts as configured, but `draft` degrades to `edit`
   * when sendMessageDraft is rejected by Telegram (e.g. group chats, old API).
   */
  function effectiveMode(): 'off' | 'append' | 'edit' | 'draft' {
    if (streamMode === 'draft' && draftAvailable === false) return 'edit';
    return streamMode;
  }

  const flushAppendSnapshot = (snapshot: string) => {
    if (!snapshot) return;
    if (outputChannel) {
      outputChannel.queueAppendStreamSnapshot(snapshot);
      lastStreamText = snapshot;
      return;
    }

    const delta = lastStreamText && snapshot.startsWith(lastStreamText)
      ? snapshot.slice(lastStreamText.length).replace(/^\s+/, '')
      : snapshot;
    lastStreamText = snapshot;
    if (!delta.trim()) return;
    void tgSendMessage(bot, chatId, delta);
  };

  /**
   * Send a draft update. On first call, probes whether sendMessageDraft is
   * available. If rejected, permanently degrades to `edit` mode for this turn.
   */
  const flushDraft = (text: string) => {
    const now = Date.now();
    if (now - draftLastSentAt < DRAFT_MIN_INTERVAL_MS) return;
    draftLastSentAt = now;

    void (async () => {
      const htmlText = markdownToTelegramHtml(text);
      const result = await tgSendMessageDraft(bot, chatId, htmlText, draftId, { parse_mode: 'HTML' });

      if (!result.ok && draftAvailable === null) {
        // First attempt failed — try plain text once before giving up
        const plainResult = await tgSendMessageDraft(bot, chatId, text, draftId);
        if (!plainResult.ok) {
          draftAvailable = false;
          logger.info({ chatId }, 'sendMessageDraft unavailable, falling back to edit mode');
          // Typing heartbeat keeps running — edit mode needs it
          // Immediately bootstrap edit mode with what we have so far
          if (!streamMessagePending && streamMessageId === null && text.trim()) {
            streamMessagePending = true;
            const streamSend = tgSendMessage(bot, chatId, text);
            outputChannel?.adoptPendingMessage(streamSend);
            void (async () => {
              try {
                streamMessageId = await streamSend;
                outputChannel?.adoptMessage(streamMessageId);
                lastStreamText = text;
              } finally {
                streamMessagePending = false;
              }
            })();
          }
          return;
        }
        // Plain text draft succeeded — draft is available
        draftAvailable = true;
        // Keep typing heartbeat running — during tool execution there are no
        // stream chunks, so the typing indicator is the only signal to the user
        // that MOZI is still working. It will be stopped by cleanup().
        logger.info({ chatId }, 'sendMessageDraft active (plain text) — native draft streaming enabled');
        return;
      }

      if (result.ok && draftAvailable === null) {
        draftAvailable = true;
        // Keep typing heartbeat running (see comment above)
        logger.info({ chatId }, 'sendMessageDraft active — native draft streaming enabled');
      }
    })();
  };

  const progress: ProgressCallback = {
    onProcessingStart: () => {
      sendTypingAction(bot, chatId);
      // Typing heartbeat runs for the entire turn duration. Even in draft mode,
      // the typing indicator must persist during tool execution (no stream chunks)
      // so the user knows MOZI is still working. Stopped only by cleanup().
      typingInterval = setInterval(() => {
        sendTypingAction(bot, chatId);
      }, TYPING_INTERVAL_MS);
    },

    onToolStart: (_toolName: string) => {},
    onToolEnd: (_toolName: string) => {},

    onStreamChunk: (accumulated: string) => {
      const text = accumulated.trim();
      if (!text) return;

      const mode = effectiveMode();

      // ── Draft mode ──
      if (mode === 'draft') {
        // Debounce: store pending, flush on timer
        pendingStreamText = text;
        if (streamTimer) return;
        streamTimer = setTimeout(() => {
          streamTimer = null;
          if (!pendingStreamText) return;
          const nextText = pendingStreamText;
          pendingStreamText = null;
          flushDraft(nextText);
        }, DRAFT_MIN_INTERVAL_MS);
        return;
      }

      // ── Edit mode ──
      if (mode === 'edit') {
        if (streamMessageId === null && !streamMessagePending) {
          streamMessagePending = true;
          const streamSend = tgSendMessage(bot, chatId, text);
          outputChannel?.adoptPendingMessage(streamSend);
          void (async () => {
            try {
              streamMessageId = await streamSend;
              outputChannel?.adoptMessage(streamMessageId);
              lastStreamText = text;
            } finally {
              streamMessagePending = false;
            }
          })();
          return;
        }

        if (streamMessageId === null || text === lastStreamText) return;
        if (splitMessage(text).length > 1) {
          pendingStreamText = text;
          return;
        }
        pendingStreamText = text;
        if (streamTimer) return;
        streamTimer = setTimeout(() => {
          streamTimer = null;
          if (!pendingStreamText || streamMessageId === null || pendingStreamText === lastStreamText) {
            return;
          }
          const nextText = pendingStreamText;
          pendingStreamText = null;
          void tgEditMessage(bot, chatId, streamMessageId, nextText).then(() => {
            lastStreamText = nextText;
          });
        }, streamEditIntervalMs);
        return;
      }

      // ── Append mode ──
      if (mode !== 'append') return;
      pendingStreamText = text;
      if (streamTimer) return;
      streamTimer = setTimeout(() => {
        streamTimer = null;
        if (!pendingStreamText) return;
        const nextText = pendingStreamText;
        pendingStreamText = null;
        flushAppendSnapshot(nextText);
      }, streamEditIntervalMs);
    },

    onStreamEnd: (fullText: string) => {
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }

      const mode = effectiveMode();

      // ── Draft mode ──
      // Draft is ephemeral — it disappears when we stop sending updates.
      // The final real message is sent by the gateway via OutputChannel.send(),
      // so we just need to clear pending state here. No cleanup needed.
      if (mode === 'draft') {
        pendingStreamText = null;
        lastStreamText = fullText;
        // Notify the output channel that draft mode was used, so it sends the
        // full final message as a real sendMessage (not an edit).
        outputChannel?.markDraftStreamUsed();
        return;
      }

      // ── Edit mode ──
      if (mode === 'edit') {
        pendingStreamText = null;

        if (streamMessageId !== null && !fullText.trim()) {
          const id = streamMessageId;
          streamMessageId = null;
          streamMessagePending = false;
          outputChannel?.clearAdoptedMessage();
          void tgDeleteMessage(bot, chatId, id);
          return;
        }

        if (!outputChannel && streamMessageId !== null && fullText.trim() && fullText !== lastStreamText) {
          const id = streamMessageId;
          void tgEditMessage(bot, chatId, id, fullText).then(() => {
            lastStreamText = fullText;
          });
        }
        return;
      }

      // ── Append mode ──
      if (mode !== 'append') return;

      if (pendingStreamText) {
        const nextText = pendingStreamText;
        pendingStreamText = null;
        flushAppendSnapshot(nextText);
      }

      const text = fullText.trim();
      if (!text) {
        outputChannel?.resetStreamState();
        lastStreamText = '';
        return;
      }

      if (text !== lastStreamText) {
        flushAppendSnapshot(text);
      }
    },
  };

  const cleanup = async () => {
    stopTypingHeartbeat();
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
  };

  return { progress, cleanup };
}
