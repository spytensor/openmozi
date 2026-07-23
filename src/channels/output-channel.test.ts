import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramOutputChannel } from './output-channel.js';

const hoisted = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  editMessageMock: vi.fn(),
  sendFileMock: vi.fn(),
}));

vi.mock('./telegram.js', () => ({
  sendMessage: hoisted.sendMessageMock,
  editMessage: hoisted.editMessageMock,
  sendFile: hoisted.sendFileMock,
}));

describe('channels/output-channel', () => {
  beforeEach(() => {
    hoisted.sendMessageMock.mockReset();
    hoisted.editMessageMock.mockReset();
    hoisted.sendFileMock.mockReset();
  });

  it('send() posts a new telegram message by default', async () => {
    hoisted.sendMessageMock.mockResolvedValue(77);
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-1');

    const messageId = await channel.send('hello');

    expect(messageId).toBe(77);
    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(bot, 'chat-1', 'hello');
    expect(hoisted.editMessageMock).not.toHaveBeenCalled();
  });

  it('send() edits adopted telegram message instead of sending a new one', async () => {
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-2');
    channel.adoptMessage(123);

    const messageId = await channel.send('final text');

    expect(messageId).toBe(123);
    expect(hoisted.editMessageMock).toHaveBeenCalledWith(bot, 'chat-2', 123, 'final text');
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it('send() waits pending adopted message id and edits that message', async () => {
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-3');
    channel.adoptPendingMessage(Promise.resolve(321));

    const messageId = await channel.send('final text');

    expect(messageId).toBe(321);
    expect(hoisted.editMessageMock).toHaveBeenCalledWith(bot, 'chat-3', 321, 'final text');
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it('prepareFinalText() suppresses duplicate final send after append streaming already delivered it', async () => {
    hoisted.sendMessageMock.mockResolvedValue(88);
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-append');

    channel.queueAppendStreamSnapshot('Hello world');
    const finalText = await channel.prepareFinalText('Hello world');

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(bot, 'chat-append', 'Hello world');
    expect(finalText).toBeNull();
  });

  it('prepareFinalText() returns only the unsent suffix after append streaming', async () => {
    hoisted.sendMessageMock.mockResolvedValue(89);
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-suffix');

    channel.queueAppendStreamSnapshot('Hello');
    const finalText = await channel.prepareFinalText('Hello world');

    expect(finalText).toBe('world');
  });

  it('shouldAutoSendFile() always returns true (all files are sent to user)', () => {
    const bot = { telegram: { sendChatAction: vi.fn() } } as any;
    const channel = new TelegramOutputChannel(bot, 'chat-files');

    // All files should be sent to user — agent should show what it produces
    expect(channel.shouldAutoSendFile('/tmp/screenshot.png')).toBe(true);
    expect(channel.shouldAutoSendFile('/tmp/report.pdf')).toBe(true);
    expect(channel.shouldAutoSendFile('/tmp/issue.md')).toBe(true);
    expect(channel.shouldAutoSendFile('/tmp/patch.diff')).toBe(true);
  });
});
