import { describe, it, expect, vi } from 'vitest';
import {
  splitMessage,
  normalizeTelegramText,
  markdownToTelegramHtml,
  sendTypingAction,
  deleteMessage,
} from './telegram.js';
import type { Telegraf } from 'telegraf';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('channels/telegram', () => {
  describe('markdownToTelegramHtml', () => {
    it('converts bold, italic, code to HTML tags', () => {
      const input = '**bold** and *italic* and `code`';
      const output = markdownToTelegramHtml(input);
      expect(output).toContain('<b>bold</b>');
      expect(output).toContain('<i>italic</i>');
      expect(output).toContain('<code>code</code>');
    });

    it('converts headings to bold text', () => {
      const output = markdownToTelegramHtml('## MOZI 能力');
      expect(output).toContain('<b>MOZI 能力</b>');
      expect(output).not.toContain('##');
    });

    it('converts fenced code blocks to <pre>', () => {
      const input = '```js\nconst x = 1;\n```';
      const output = markdownToTelegramHtml(input);
      expect(output).toContain('<pre>const x = 1;</pre>');
    });

    it('escapes HTML special chars outside tags', () => {
      const output = markdownToTelegramHtml('a < b && c > d');
      expect(output).toContain('&lt;');
      expect(output).toContain('&amp;');
      expect(output).toContain('&gt;');
    });

    it('converts tables to plain text', () => {
      const input = '| 能力 | 状态 |\n|---|---|\n| tool | enabled |';
      const output = markdownToTelegramHtml(input);
      expect(output).not.toContain('|---|');
      expect(output).toContain('能力: tool');
    });

    it('converts markdown links to HTML links', () => {
      const output = markdownToTelegramHtml('[OpenAI](https://openai.com)');
      expect(output).toContain('<a href="https://openai.com">OpenAI</a>');
    });

    it('removes horizontal rules', () => {
      const output = markdownToTelegramHtml('before\n---\nafter');
      expect(output).not.toContain('---');
      expect(output).toContain('before');
      expect(output).toContain('after');
    });
  });

  describe('splitMessage', () => {
    it('returns single chunk for short messages', () => {
      expect(splitMessage('hello')).toEqual(['hello']);
    });

    it('splits at newlines within limit', () => {
      const text = 'line1\nline2\nline3';
      const chunks = splitMessage(text, 12);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // Each chunk should be within limit
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(12);
      }
    });

    it('hard splits when no good break point', () => {
      const text = 'a'.repeat(100);
      const chunks = splitMessage(text, 40);
      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe('a'.repeat(40));
    });
  });

  describe('normalizeTelegramText', () => {
    it('strips common markdown wrappers for plain-text Telegram output', () => {
      const input = [
        '## 标题',
        '',
        '**系统级：**',
        '- 工具：`read_file`',
        '[OpenAI](https://openai.com)',
      ].join('\n');
      const output = normalizeTelegramText(input);
      expect(output).toContain('标题');
      expect(output).toContain('系统级：');
      expect(output).toContain('工具：read_file');
      expect(output).toContain('OpenAI (https://openai.com)');
      expect(output).not.toContain('**');
      expect(output).not.toContain('`');
      expect(output).not.toContain('## ');
    });

    it('converts markdown tables to readable plain text', () => {
      const input = [
        '| 能力 | 状态 | 实现文件 |',
        '|---|---|---|',
        '| Message Bus | done | agents/messaging.ts |',
        '| Blackboard | done | capabilities/blackboard.ts |',
      ].join('\n');
      const output = normalizeTelegramText(input);

      expect(output).not.toContain('|---|');
      expect(output).toContain('能力: Message Bus');
      expect(output).toContain('状态: done');
      expect(output).toContain('实现文件: agents/messaging.ts');
      expect(output).toContain('能力: Blackboard');
    });

    it('preserves non-table content around tables', () => {
      const input = [
        'Before table',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        'After table',
      ].join('\n');
      const output = normalizeTelegramText(input);

      expect(output).toContain('Before table');
      expect(output).toContain('After table');
      expect(output).toContain('A: 1');
      expect(output).not.toContain('|---|');
    });
  });

  // ---------------------------------------------------------------------------
  // Telegram control methods (mocked)
  // ---------------------------------------------------------------------------

  describe('sendTypingAction', () => {
    it('calls sendChatAction with typing', async () => {
      const mockBot = {
        telegram: {
          sendChatAction: vi.fn().mockResolvedValue(true),
        },
      } as unknown as Telegraf;

      await sendTypingAction(mockBot, '123');

      expect(mockBot.telegram.sendChatAction).toHaveBeenCalledWith('123', 'typing');
    });

    it('does not throw on error', async () => {
      const mockBot = {
        telegram: {
          sendChatAction: vi.fn().mockRejectedValue(new Error('network')),
        },
      } as unknown as Telegraf;

      // Should not throw
      await expect(sendTypingAction(mockBot, '123')).resolves.toBeUndefined();
    });
  });

  describe('deleteMessage', () => {
    it('deletes message', async () => {
      const mockBot = {
        telegram: {
          deleteMessage: vi.fn().mockResolvedValue(true),
        },
      } as unknown as Telegraf;

      await deleteMessage(mockBot, '123', 42);

      expect(mockBot.telegram.deleteMessage).toHaveBeenCalledWith('123', 42);
    });

    it('does not throw on error', async () => {
      const mockBot = {
        telegram: {
          deleteMessage: vi.fn().mockRejectedValue(new Error('not found')),
        },
      } as unknown as Telegraf;

      await expect(deleteMessage(mockBot, '123', 42)).resolves.toBeUndefined();
    });
  });
});
