import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramOutputChannel } from './output-channel.js';
import { createTelegramProgress } from './telegram-progress.js';

const hoisted = vi.hoisted(() => ({
  sendTypingActionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  editMessageMock: vi.fn(),
  deleteMessageMock: vi.fn(),
  sendMessageDraftMock: vi.fn(),
  markdownToTelegramHtmlMock: vi.fn((t) => t),
  config: {
    telegram: {
      stream_mode: 'append',
      stream_edit_interval_ms: 25,
    },
  },
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => hoisted.config,
}));

vi.mock('./telegram.js', () => ({
  sendTypingAction: hoisted.sendTypingActionMock,
  sendMessage: hoisted.sendMessageMock,
  editMessage: hoisted.editMessageMock,
  deleteMessage: hoisted.deleteMessageMock,
  sendMessageDraft: hoisted.sendMessageDraftMock,
  markdownToTelegramHtml: hoisted.markdownToTelegramHtmlMock,
  splitMessage: (text: string, maxLength = 4096) => {
    if (text.length <= maxLength) return [text];
    return [text.slice(0, maxLength), text.slice(maxLength)];
  },
}));

describe('channels/telegram-progress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.sendTypingActionMock.mockReset();
    hoisted.sendMessageMock.mockReset();
    hoisted.editMessageMock.mockReset();
    hoisted.deleteMessageMock.mockReset();
    hoisted.sendMessageDraftMock.mockReset();
    hoisted.markdownToTelegramHtmlMock.mockReset().mockImplementation((t) => t);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('append mode streams via follow-up messages without editing or deleting visible text', async () => {
    hoisted.config.telegram.stream_mode = 'append';
    hoisted.sendMessageMock.mockResolvedValueOnce(101).mockResolvedValueOnce(102);
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-append');
    const { progress } = createTelegramProgress(bot, 'chat-append', channel);

    progress.onStreamChunk?.('Hello');
    await vi.advanceTimersByTimeAsync(25);
    progress.onStreamChunk?.('Hello world');
    await vi.advanceTimersByTimeAsync(25);
    progress.onStreamEnd?.('Hello world');
    const finalText = await channel.prepareFinalText?.('Hello world');

    expect(hoisted.sendMessageMock).toHaveBeenNthCalledWith(1, bot, 'chat-append', 'Hello');
    expect(hoisted.sendMessageMock).toHaveBeenNthCalledWith(2, bot, 'chat-append', 'world');
    expect(finalText).toBeNull();
    expect(hoisted.editMessageMock).not.toHaveBeenCalled();
    expect(hoisted.deleteMessageMock).not.toHaveBeenCalled();
  });

  it('edit mode keeps legacy single-message mutation behavior', async () => {
    hoisted.config.telegram.stream_mode = 'edit';
    hoisted.sendMessageMock.mockResolvedValue(777);
    hoisted.editMessageMock.mockResolvedValue(undefined);
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-edit');
    const { progress } = createTelegramProgress(bot, 'chat-edit', channel);

    progress.onStreamChunk?.('Hello');
    await Promise.resolve();
    await Promise.resolve();
    progress.onStreamChunk?.('Hello world');
    await vi.advanceTimersByTimeAsync(25);
    progress.onStreamEnd?.('Hello world!');
    await Promise.resolve();

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(bot, 'chat-edit', 'Hello');
    expect(hoisted.editMessageMock).toHaveBeenCalledWith(bot, 'chat-edit', 777, 'Hello world');
    expect(hoisted.editMessageMock).not.toHaveBeenCalledWith(bot, 'chat-edit', 777, 'Hello world!');
  });

  it('edit mode stops live edits once the text exceeds Telegram single-message limits', async () => {
    hoisted.config.telegram.stream_mode = 'edit';
    hoisted.sendMessageMock.mockResolvedValue(777);
    hoisted.editMessageMock.mockResolvedValue(undefined);
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-edit-long');
    const { progress } = createTelegramProgress(bot, 'chat-edit-long', channel);

    progress.onStreamChunk?.('Hello');
    await Promise.resolve();
    await Promise.resolve();
    progress.onStreamChunk?.(`${'a'.repeat(4090)} ${'b'.repeat(40)}`);
    await vi.advanceTimersByTimeAsync(25);

    expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(hoisted.editMessageMock).not.toHaveBeenCalled();
  });

  describe("draft mode typing heartbeat", () => {
    it("draft mode keeps typing alive before first successful draft send", async () => {
      hoisted.config.telegram.stream_mode = "draft";
      hoisted.sendMessageDraftMock.mockReturnValue(new Promise(() => {}));
      const bot = { telegram: { sendChatAction: vi.fn() } } as any;
      const { progress, cleanup } = createTelegramProgress(bot, "chat-draft");

      progress.onProcessingStart?.();
      expect(hoisted.sendTypingActionMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4000);
      expect(hoisted.sendTypingActionMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(hoisted.sendTypingActionMock).toHaveBeenCalledTimes(3);

      await cleanup();
    });

    it("first successful draft send keeps typing heartbeat for tool execution visibility", async () => {
      hoisted.config.telegram.stream_mode = "draft";
      hoisted.sendMessageDraftMock.mockResolvedValue({ ok: true });
      const bot = { telegram: { sendChatAction: vi.fn() } } as any;
      const { progress, cleanup } = createTelegramProgress(bot, "chat-draft");

      progress.onProcessingStart?.();
      expect(hoisted.sendTypingActionMock).toHaveBeenCalledTimes(1);

      progress.onStreamChunk?.("Hello");
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();

      const countAfterDraft = hoisted.sendTypingActionMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(12000);
      // Typing continues — user must see MOZI is working during tool execution
      expect(hoisted.sendTypingActionMock.mock.calls.length).toBeGreaterThan(countAfterDraft);

      await cleanup();
    });

    it("draft unavailable fallback-to-edit keeps typing alive", async () => {
      hoisted.config.telegram.stream_mode = "draft";
      hoisted.sendMessageDraftMock.mockResolvedValue({ ok: false });
      hoisted.sendMessageMock.mockResolvedValue(888);
      const bot = { telegram: { sendChatAction: vi.fn() } } as any;
      const { progress, cleanup } = createTelegramProgress(bot, "chat-draft");

      progress.onProcessingStart?.();
      expect(hoisted.sendTypingActionMock).toHaveBeenCalledTimes(1);

      progress.onStreamChunk?.("Hello");
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const countBefore = hoisted.sendTypingActionMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4000);
      expect(hoisted.sendTypingActionMock.mock.calls.length).toBeGreaterThan(countBefore);

      const countBefore2 = hoisted.sendTypingActionMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4000);
      expect(hoisted.sendTypingActionMock.mock.calls.length).toBeGreaterThan(countBefore2);

      await cleanup();
    });
  });
});
