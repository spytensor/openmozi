import { describe, expect, it } from 'vitest';
import { textToIncoming, type WsClient } from './websocket.js';
import type { Attachment } from './telegram.js';

describe('websocket upload attachments', () => {
  it('propagates uploaded file attachments into incoming messages', () => {
    const client: WsClient = {
      id: 'client-1',
      userId: 'user-1',
      tenantId: 'default',
      username: 'alice',
      authenticated: true,
      capabilities: ['attachments'],
    };
    const attachments: Attachment[] = [{
      type: 'document',
      filename: 'report.csv',
      path: '/tmp/mozi-upload/report.csv',
      mime: 'application/octet-stream',
    }];

    const incoming = textToIncoming('Analyze this file', client, undefined, attachments);

    expect(incoming.attachments).toEqual(attachments);
    expect(incoming.attachments?.[0]?.filename).toBe('report.csv');
    expect(incoming.attachments?.[0]?.path).toBe('/tmp/mozi-upload/report.csv');
    expect(incoming.clientCapabilities).toEqual(['attachments']);
  });
});
