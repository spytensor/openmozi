import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { IncomingMessage } from './telegram.js';

const logger = pino({ name: 'mozi:voice' });
type WebSocket = { send(data: string): void };

export interface VoiceServices {
  transcribe: (audio: Buffer, opts?: { language?: string }) => Promise<string>;
  synthesize: (text: string, opts?: { language?: string }) => Promise<Buffer>;
}

export interface VoiceRouteOptions {
  enabled: boolean;
  services?: Partial<VoiceServices>;
}

export type VoiceClientMessage =
  | {
      type: 'audio';
      audio_b64: string;
      requestId?: string;
      chatId?: string;
      userId?: string;
      tenantId?: string;
      username?: string;
      language?: string;
    }
  | {
      type: 'text';
      text: string;
      requestId?: string;
      chatId?: string;
      userId?: string;
      tenantId?: string;
      username?: string;
      language?: string;
    };

export type VoiceServerMessage =
  | { type: 'voice_text'; requestId?: string; text: string }
  | { type: 'voice_audio'; requestId?: string; text: string; audio_b64: string }
  | { type: 'error'; requestId?: string; message: string };

export type VoiceMessageHandler = (msg: IncomingMessage) => Promise<string | null>;

function send(socket: WebSocket, message: VoiceServerMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // socket likely closed
  }
}

export function parseVoiceClientMessage(raw: string): VoiceClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null;
    if (parsed.type === 'audio' && typeof parsed.audio_b64 === 'string') {
      return {
        type: 'audio',
        audio_b64: parsed.audio_b64,
        requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
        chatId: typeof parsed.chatId === 'string' ? parsed.chatId : undefined,
        userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
        tenantId: typeof parsed.tenantId === 'string' ? parsed.tenantId : undefined,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        language: typeof parsed.language === 'string' ? parsed.language : undefined,
      };
    }
    if (parsed.type === 'text' && typeof parsed.text === 'string') {
      return {
        type: 'text',
        text: parsed.text,
        requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
        chatId: typeof parsed.chatId === 'string' ? parsed.chatId : undefined,
        userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
        tenantId: typeof parsed.tenantId === 'string' ? parsed.tenantId : undefined,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        language: typeof parsed.language === 'string' ? parsed.language : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export const defaultVoiceServices: VoiceServices = {
  async transcribe(audio: Buffer): Promise<string> {
    // Lightweight fallback: treat incoming bytes as UTF-8 text payload.
    const text = audio.toString('utf-8').trim();
    if (!text) {
      throw new Error('No transcript available. Configure STT provider for binary audio input.');
    }
    return text;
  },
  async synthesize(text: string): Promise<Buffer> {
    // Lightweight fallback: echo text bytes; real deployments should inject TTS.
    return Buffer.from(text, 'utf-8');
  },
};

function toIncomingMessage(transcript: string, message: VoiceClientMessage): IncomingMessage {
  const userId = message.userId ?? message.chatId ?? 'voice-user';
  const chatId = message.chatId ?? userId;
  const isCommand = transcript.startsWith('/');
  let command: string | undefined;
  let commandArgs: string | undefined;
  if (isCommand) {
    const spaceIdx = transcript.indexOf(' ');
    if (spaceIdx > 0) {
      command = transcript.slice(1, spaceIdx);
      commandArgs = transcript.slice(spaceIdx + 1).trim();
    } else {
      command = transcript.slice(1);
    }
  }

  return {
    channelType: 'websocket',
    chatId,
    tenantId: message.tenantId ?? 'default',
    userId,
    username: message.username ?? 'voice-user',
    text: transcript,
    isCommand,
    command,
    commandArgs,
    timestamp: new Date(),
  };
}

async function resolveTranscript(message: VoiceClientMessage, services: VoiceServices): Promise<string> {
  if (message.type === 'text') {
    return message.text.trim();
  }
  const audio = Buffer.from(message.audio_b64, 'base64');
  return services.transcribe(audio, { language: message.language });
}

export function registerVoiceRoute(
  app: FastifyInstance,
  handler: VoiceMessageHandler,
  options: VoiceRouteOptions,
): void {
  if (!options.enabled) return;
  const services: VoiceServices = {
    transcribe: options.services?.transcribe ?? defaultVoiceServices.transcribe,
    synthesize: options.services?.synthesize ?? defaultVoiceServices.synthesize,
  };

  app.get('/ws/voice', { websocket: true }, (socket) => {
    socket.on('message', async (raw: Buffer | string) => {
      const message = parseVoiceClientMessage(raw.toString());
      if (!message) {
        send(socket as unknown as WebSocket, { type: 'error', message: 'Invalid voice payload' });
        return;
      }

      try {
        const transcript = await resolveTranscript(message, services);
        if (!transcript) return;
        send(socket as unknown as WebSocket, {
          type: 'voice_text',
          requestId: message.requestId,
          text: transcript,
        });

        const response = await handler(toIncomingMessage(transcript, message));
        if (!response || response.trim().length === 0) return;

        const audio = await services.synthesize(response, { language: message.language });
        send(socket as unknown as WebSocket, {
          type: 'voice_audio',
          requestId: message.requestId,
          text: response,
          audio_b64: audio.toString('base64'),
        });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        logger.warn({ err: messageText }, 'Voice route processing failed');
        send(socket as unknown as WebSocket, {
          type: 'error',
          requestId: message.requestId,
          message: messageText,
        });
      }
    });
  });
}
