import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ACPServer } from './acp.js';
import type { MessageHandler, IncomingMessage } from './telegram.js';
import { initDb, closeDb } from '../store/db.js';
import { runMigrations } from '../store/migrate.js';

describe('ACPServer', () => {
  beforeAll(() => {
    initDb(':memory:');
    runMigrations();
  });

  afterAll(() => {
    closeDb();
  });
  function createMockHandler(response: string | null = 'test response'): MessageHandler {
    return vi.fn(async (_msg: IncomingMessage) => response);
  }

  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        lines.push(chunk.trim());
      }
      return true;
    });
    return {
      lines,
      restore: () => spy.mockRestore(),
    };
  }

  it('creates server with default options', () => {
    const handler = createMockHandler();
    const server = new ACPServer(handler);
    expect(server).toBeInstanceOf(ACPServer);
  });

  it('creates server with custom options', () => {
    const handler = createMockHandler();
    const server = new ACPServer(handler, {
      userId: 'custom-user',
      tenantId: 'custom-tenant',
    });
    expect(server).toBeInstanceOf(ACPServer);
  });

  describe('JSON-RPC request handling', () => {
    it('handles initialize request', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        // Access private method via prototype trick
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { client_name: 'test-ide' },
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(1);
        expect(response.result.name).toBe('mozi');
        expect(response.result.capabilities.streaming).toBe(true);
        expect(response.result.capabilities.sessions).toBe(true);
      } finally {
        output.restore();
      }
    });

    it('handles sessions/create request', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'sessions/create',
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(2);
        expect(response.result.key).toMatch(/^acp:/);
        expect(response.result.chat_id).toMatch(/^acp-/);
      } finally {
        output.restore();
      }
    });

    it('handles prompt request', async () => {
      const handler = createMockHandler('Hello from MOZI');
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        // First create a session
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/create',
        });
        output.lines.length = 0; // Clear create response

        // Then send a prompt
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'prompt',
          params: { content: 'test message' },
        });

        // Should have notification + response
        const messages = output.lines.map(l => JSON.parse(l));
        const notification = messages.find(m => m.method === 'prompt/started');
        const response = messages.find(m => m.id === 2);

        expect(notification).toBeDefined();
        expect(response?.result.status).toBe('complete');
        expect(response?.result.content).toBe('Hello from MOZI');
      } finally {
        output.restore();
      }
    });

    it('handles prompt without active session (auto-creates)', async () => {
      const handler = createMockHandler('auto-session response');
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompt',
          params: { content: 'hello' },
        });

        const messages = output.lines.map(l => JSON.parse(l));
        const response = messages.find(m => m.id === 1);
        expect(response?.result.status).toBe('complete');
        expect(response?.result.content).toBe('auto-session response');
      } finally {
        output.restore();
      }
    });

    it('rejects prompt with empty content', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompt',
          params: { content: '   ' },
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.error.code).toBe(-32602);
        expect(response.error.message).toContain('content');
      } finally {
        output.restore();
      }
    });

    it('handles cancel request', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'cancel',
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.result.status).toBe('cancelled');
      } finally {
        output.restore();
      }
    });

    it('returns method not found for unknown methods', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown/method',
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.error.code).toBe(-32601);
        expect(response.error.message).toContain('unknown/method');
      } finally {
        output.restore();
      }
    });

    it('handles sessions/load request', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/load',
          params: { key: 'acp:test-uuid' },
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.result.key).toBe('acp:test-uuid');
        expect(response.result.chat_id).toBe('acp-test-uuid');
      } finally {
        output.restore();
      }
    });

    it('rejects sessions/load without key', async () => {
      const handler = createMockHandler();
      const server = new ACPServer(handler);
      const output = captureStdout();

      try {
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/load',
          params: {},
        });

        const response = JSON.parse(output.lines[0]);
        expect(response.error.code).toBe(-32602);
      } finally {
        output.restore();
      }
    });

    it('passes correct IncomingMessage fields to handler', async () => {
      const handler = createMockHandler('ok');
      const server = new ACPServer(handler, { userId: 'test-user' });
      const output = captureStdout();

      try {
        // Create session first
        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'sessions/create',
        });
        output.lines.length = 0;

        await (server as any).handleRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'prompt',
          params: { content: '/help arguments' },
        });

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            channelType: 'acp',
            userId: 'test-user',
            username: 'acp-client',
            text: '/help arguments',
            isCommand: true,
            command: 'help',
            commandArgs: 'arguments',
          }),
        );
      } finally {
        output.restore();
      }
    });
  });
});
