import { describe, expect, it } from 'vitest';
import { defaultVoiceServices, parseVoiceClientMessage } from './voice.js';

describe('channels/voice', () => {
  it('parses text payload', () => {
    const parsed = parseVoiceClientMessage(JSON.stringify({
      type: 'text',
      text: 'hello voice',
      chatId: 'chat-1',
      userId: 'user-1',
    }));
    expect(parsed).toEqual({
      type: 'text',
      text: 'hello voice',
      requestId: undefined,
      chatId: 'chat-1',
      userId: 'user-1',
      tenantId: undefined,
      username: undefined,
      language: undefined,
    });
  });

  it('parses audio payload', () => {
    const parsed = parseVoiceClientMessage(JSON.stringify({
      type: 'audio',
      audio_b64: Buffer.from('hello').toString('base64'),
      requestId: 'r1',
    }));
    expect(parsed).toEqual({
      type: 'audio',
      audio_b64: Buffer.from('hello').toString('base64'),
      requestId: 'r1',
      chatId: undefined,
      userId: undefined,
      tenantId: undefined,
      username: undefined,
      language: undefined,
    });
  });

  it('returns null for invalid payload', () => {
    expect(parseVoiceClientMessage('not-json')).toBeNull();
    expect(parseVoiceClientMessage(JSON.stringify({ type: 'audio' }))).toBeNull();
  });

  it('default services can transcribe and synthesize utf8 payloads', async () => {
    await expect(defaultVoiceServices.transcribe(Buffer.from('hello'))).resolves.toBe('hello');
    await expect(defaultVoiceServices.synthesize('world')).resolves.toEqual(Buffer.from('world'));
  });
});
