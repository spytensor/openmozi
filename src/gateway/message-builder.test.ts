import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from '../channels/telegram.js';

// Mock analyzeImage to avoid real API calls in unit tests
vi.mock('../capabilities/vision.js', () => ({
  analyzeImage: vi.fn().mockResolvedValue('A photo of a test image'),
}));

import { buildUserMessage, buildMultimodalUserMessage, formatWorkspaceContext } from './message-builder.js';
import { analyzeImage } from '../capabilities/vision.js';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelType: 'telegram',
    chatId: 'test-chat',
    userId: 'test-user',
    username: 'tester',
    text: '',
    isCommand: false,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('gateway/message-builder', () => {
  describe('media file attachments', () => {
    it('includes voice attachment metadata but NOT absolute path in built message', async () => {
      const msg = makeMsg({
        text: 'Process this voice message',
        attachments: [{
          type: 'voice',
          path: '/tmp/voice-123.ogg',
          mime: 'audio/ogg',
          filename: 'voice-123.ogg',
        }],
      });

      // Media notices are no longer embedded in the persisted user message —
      // they are injected as turn context (see formatWorkspaceContext) so the
      // displayed bubble and auto-title stay clean.
      const result = await buildUserMessage(msg);
      expect(result).toBe('Process this voice message');
      expect(result).not.toContain('Media Files');
      // The file is exposed to the Brain via turn context, WITH its real path.
      const context = formatWorkspaceContext(msg);
      expect(context).toContain('voice-123.ogg');
      expect(context).toContain('/tmp/voice-123.ogg');
    });

    it('exposes video attachment path via turn context, not the user message', async () => {
      const msg = makeMsg({
        text: 'Check this video',
        attachments: [{
          type: 'video',
          path: '/tmp/video-456.mp4',
          mime: 'video/mp4',
          filename: 'video-456.mp4',
        }],
      });

      const result = await buildUserMessage(msg);
      expect(result).toBe('Check this video');
      expect(result).not.toContain('Media Files');
      const context = formatWorkspaceContext(msg);
      expect(context).toContain('video-456.mp4');
      expect(context).toContain('/tmp/video-456.mp4');
    });

    it('exposes multiple media attachments via turn context', async () => {
      const msg = makeMsg({
        text: 'Multiple files',
        attachments: [
          { type: 'voice', path: '/tmp/a.ogg', mime: 'audio/ogg', filename: 'a.ogg' },
          { type: 'audio', path: '/tmp/b.mp3', mime: 'audio/mpeg', filename: 'b.mp3' },
        ],
      });

      const result = await buildUserMessage(msg);
      expect(result).not.toContain('Media Files');
      const context = formatWorkspaceContext(msg);
      expect(context).toContain('a.ogg');
      expect(context).toContain('b.mp3');
      expect(context).toContain('/tmp/a.ogg');
      expect(context).toContain('/tmp/b.mp3');
    });

    it('does not include photos in media section (handled separately)', async () => {
      const msg = makeMsg({
        text: 'Photo test',
        attachments: [{
          type: 'photo',
          path: '/tmp/photo.jpg',
          mime: 'image/jpeg',
          filename: 'photo.jpg',
        }],
      });

      const result = await buildUserMessage(msg);
      // Photo should be in Photo Analysis section, not Media Files
      expect(result).toContain('Current Photo Analysis (attached to this message)');
      expect(result).not.toContain('Media Files');
    });

    it('does not include text attachments in media section', async () => {
      const msg = makeMsg({
        text: 'Document test',
        attachments: [{
          type: 'document',
          path: '/tmp/readme.md',
          mime: 'text/markdown',
          filename: 'readme.md',
          content: '# Hello World',
        }],
      });

      const result = await buildUserMessage(msg);
      // Text content should show as an attachment block, not in Media Files
      expect(result).toContain('Attachment: readme.md');
      expect(result).not.toContain('Media Files');
    });
  });

  describe('basic message building', () => {
    it('builds message with text only', async () => {
      const msg = makeMsg({ text: 'Hello world' });
      const result = await buildUserMessage(msg);
      expect(result).toBe('Hello world');
    });

    it('includes replyToText when present', async () => {
      const msg = makeMsg({
        text: 'My reply',
        replyToText: '[Quoted user message from bob]: Original text',
      });
      const result = await buildUserMessage(msg);
      expect(result).toContain('[Quoted user message from bob]');
      expect(result).toContain('My reply');
    });

    it('keeps the Web UI workspace context out of the persisted user message', async () => {
      const msg = makeMsg({
        channelType: 'websocket',
        text: 'Run the checks here',
        workspaceContext: {
          rootPath: '/Users/test/project',
          rootKind: 'project_root',
          label: 'Runtime Source',
          gitBranch: 'codex/runtime-workspace',
        },
      });

      // Workspace context is turn context for the Brain (injected into the system
      // prompt), not user content — it must not pollute the persisted/displayed
      // user message or the auto-title.
      const result = await buildUserMessage(msg);
      expect(result).not.toContain('Workspace Context (selected in Web UI):');
      expect(result).toContain('Run the checks here');

      // …but it remains available to inject into the system prompt for the turn.
      const context = formatWorkspaceContext(msg);
      expect(context).toContain('Workspace Context (selected in Web UI):');
      expect(context).toContain('- Label: Runtime Source');
      expect(context).toContain('- Kind: project_root');
      expect(context).toContain('- Git branch: codex/runtime-workspace');
      expect(context).toContain('- Root path: /Users/test/project');
    });

    it('keeps attached file paths out of persisted text but exposes them as Brain context', async () => {
      const msg = makeMsg({
        channelType: 'websocket',
        text: 'Analyze the spreadsheet',
        attachments: [{
          type: 'document',
          path: '/Users/test/.mozi/workspaces/test-user/sales.csv',
          mime: 'text/csv',
          filename: 'sales.csv',
        }],
      });

      const result = await buildUserMessage(msg);
      expect(result).toContain('Analyze the spreadsheet');
      expect(result).not.toContain('/Users/test/.mozi/workspaces/test-user/sales.csv');

      const context = formatWorkspaceContext(msg);
      expect(context).toContain('uploaded THIS TURN');
      expect(context).toContain('/Users/test/.mozi/workspaces/test-user/sales.csv');
    });
  });

  describe('ephemeral path safety', () => {
    it('does not embed absolute tmp path for successfully analyzed photos', async () => {
      const msg = makeMsg({
        text: 'Look at this',
        attachments: [{
          type: 'photo',
          path: '/home/user/.mozi/workspace/tmp/1234567890-abc123-photo.jpg',
          mime: 'image/jpeg',
          filename: 'photo.jpg',
        }],
      });

      const result = await buildUserMessage(msg);
      expect(result).toContain('Current Photo Analysis (attached to this message)');
      expect(result).toContain('Photo 1');
      expect(result).toContain('A photo of a test image');
      // Must not contain absolute path that becomes stale after restart
      expect(result).not.toContain('/home/user/.mozi/workspace/tmp/');
      expect(result).not.toContain('1234567890-abc123-photo.jpg');
      expect(result).not.toContain('photo.jpg');
    });

    it('does not embed Telegram-generated photo filenames', async () => {
      const generatedName = '1777043230219-usba99-AgACAgQAAxkBAAIJDmnrhx3BEh39emsoHfC3Sd8bSW4G.jpg';
      const msg = makeMsg({
        text: 'Look at this',
        attachments: [{
          type: 'photo',
          path: `workspace/tmp/${generatedName}`,
          mime: 'image/jpeg',
          filename: generatedName,
        }],
      });

      const result = await buildUserMessage(msg);
      expect(result).toContain('Current Photo Analysis (attached to this message)');
      expect(result).toContain('Photo 1');
      expect(result).toContain('A photo of a test image');
      expect(result).not.toContain('workspace/tmp/');
      expect(result).not.toContain(generatedName);
    });

    it('does not embed absolute tmp path when photo analysis fails', async () => {
      vi.mocked(analyzeImage).mockRejectedValueOnce(new Error('Vision API error'));

      const msg = makeMsg({
        text: 'Another photo',
        attachments: [{
          type: 'photo',
          path: '/home/user/.mozi/workspace/tmp/9999-xyz-fail.jpg',
          mime: 'image/jpeg',
          filename: 'fail.jpg',
        }],
      });

      const result = await buildUserMessage(msg);
      expect(result).toContain('Current Photo Analysis (attached to this message)');
      expect(result).toContain('auto-analysis unavailable');
      // Must not contain absolute path
      expect(result).not.toContain('/home/user/.mozi/workspace/tmp/');
      expect(result).not.toContain('file saved at');
    });

    it('uses basename when attachment has no filename', async () => {
      const msg = makeMsg({
        text: '',
        attachments: [{
          type: 'voice',
          path: '/home/user/.mozi/workspace/tmp/1234567890-abc-voice.ogg',
          mime: 'audio/ogg',
          // no filename set
        }],
      });

      // buildUserMessage no longer embeds media metadata; the turn context uses
      // the basename when no filename is provided.
      const result = await buildUserMessage(msg);
      expect(result).toBe('');
      const context = formatWorkspaceContext(msg);
      expect(context).toContain('1234567890-abc-voice.ogg');
    });

    it('marks uploaded files as this-turn-only in the Brain turn context', async () => {
      const msg = makeMsg({
        text: 'Process this',
        attachments: [{
          type: 'voice',
          path: '/tmp/voice.ogg',
          mime: 'audio/ogg',
          filename: 'voice.ogg',
        }],
      });

      const result = await buildUserMessage(msg);
      expect(result).toBe('Process this');
      const context = formatWorkspaceContext(msg);
      expect(context).toContain('THIS TURN');
    });
  });

  describe('buildMultimodalUserMessage', () => {
    it('returns null when no photo attachments', () => {
      const msg = makeMsg({ text: 'No photos here' });
      expect(buildMultimodalUserMessage(msg)).toBeNull();
    });

    it('returns ContentPart[] with inline image data from bytes', () => {
      const fakeBytes = Buffer.from('fake-image-data');
      const msg = makeMsg({
        text: 'What is in this photo?',
        attachments: [{
          type: 'photo',
          path: '/tmp/photo.jpg',
          mime: 'image/jpeg',
          filename: 'photo.jpg',
          bytes: fakeBytes,
        }],
      });

      const parts = buildMultimodalUserMessage(msg);
      expect(parts).not.toBeNull();
      expect(parts!.length).toBe(2); // image + text

      const imagePart = parts!.find(p => p.type === 'image');
      expect(imagePart).toBeDefined();
      expect(imagePart!.type).toBe('image');
      if (imagePart!.type === 'image') {
        expect(imagePart!.image).toBe(fakeBytes);
        expect(imagePart!.mediaType).toBe('image/jpeg');
      }

      const textPart = parts!.find(p => p.type === 'text');
      expect(textPart).toBeDefined();
      if (textPart!.type === 'text') {
        expect(textPart!.text).toBe('What is in this photo?');
      }
    });

    it('includes replyToText as text part before images', () => {
      const msg = makeMsg({
        text: 'Check this',
        replyToText: '[Quoted]: previous message',
        attachments: [{
          type: 'photo',
          path: '/tmp/photo.jpg',
          mime: 'image/jpeg',
          bytes: Buffer.from('img'),
        }],
      });

      const parts = buildMultimodalUserMessage(msg)!;
      expect(parts[0].type).toBe('text');
      if (parts[0].type === 'text') {
        expect(parts[0].text).toContain('Quoted');
      }
    });

    it('handles multiple photos', () => {
      const msg = makeMsg({
        text: 'Compare these',
        attachments: [
          { type: 'photo', path: '/tmp/a.jpg', mime: 'image/jpeg', bytes: Buffer.from('a') },
          { type: 'photo', path: '/tmp/b.jpg', mime: 'image/png', bytes: Buffer.from('b') },
        ],
      });

      const parts = buildMultimodalUserMessage(msg)!;
      const imageParts = parts.filter(p => p.type === 'image');
      expect(imageParts.length).toBe(2);
    });
  });
});
