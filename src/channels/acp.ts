/**
 * ACP (Agent Client Protocol) channel adapter.
 *
 * Implements JSON-RPC 2.0 over NDJSON on stdio, enabling IDE integrations
 * (VS Code, JetBrains, Zed, etc.) to communicate with MOZI's gateway.
 *
 * Protocol:
 *   IDE spawns `mozi acp` and communicates via stdin/stdout.
 *   Each line is a JSON-RPC 2.0 request or response.
 *
 * Methods:
 *   initialize        — Client handshake, returns server capabilities
 *   sessions/list     — List available sessions
 *   sessions/create   — Create a new session
 *   prompt            — Send user input, returns streamed response
 *   cancel            — Cancel active execution (best-effort)
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, MessageHandler } from './telegram.js';
import {
  listSessions,
  getOrCreateSessionForChat,
} from '../memory/sessions.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:acp' });

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ACP session state
// ---------------------------------------------------------------------------

interface ACPSession {
  key: string;        // ACP session key (e.g. 'acp:<uuid>')
  chatId: string;     // MOZI chat ID mapped to this session
  userId: string;     // User identifier
  createdAt: number;
}

// ---------------------------------------------------------------------------
// ACP Server
// ---------------------------------------------------------------------------

export interface ACPServerOptions {
  /** User ID for this ACP connection (defaults to 'acp-user') */
  userId?: string;
  /** Tenant ID for multi-tenant isolation */
  tenantId?: string;
}

export class ACPServer {
  private handler: MessageHandler;
  private sessions = new Map<string, ACPSession>();
  private activeSessionKey: string | null = null;
  private cancelFlag = false;
  private userId: string;
  private tenantId: string;
  private initialized = false;

  constructor(handler: MessageHandler, options: ACPServerOptions = {}) {
    this.handler = handler;
    this.userId = options.userId ?? 'acp-user';
    this.tenantId = options.tenantId ?? 'default';
  }

  /**
   * Start the ACP server — reads JSON-RPC from stdin, writes to stdout.
   */
  start(): void {
    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const request = JSON.parse(trimmed) as JsonRpcRequest;
        this.handleRequest(request).catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ err: errMsg, method: request.method }, 'ACP request handler error');
          this.sendResponse({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: errMsg },
          });
        });
      } catch {
        this.sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    });

    rl.on('close', () => {
      logger.info('ACP stdin closed, shutting down');
      process.exit(0);
    });

    logger.info('ACP server started on stdio');
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { method, params, id } = request;

    switch (method) {
      case 'initialize':
        return this.handleInitialize(id, params);
      case 'sessions/list':
        return this.handleSessionsList(id);
      case 'sessions/create':
        return this.handleSessionsCreate(id, params);
      case 'sessions/load':
        return this.handleSessionsLoad(id, params);
      case 'prompt':
        return this.handlePrompt(id, params);
      case 'cancel':
        return this.handleCancel(id);
      default:
        this.sendResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  }

  // ── initialize ──────────────────────────────────────────────────────────

  private handleInitialize(
    id: string | number | null,
    params?: Record<string, unknown>,
  ): void {
    this.initialized = true;
    const clientName = typeof params?.client_name === 'string' ? params.client_name : 'unknown';
    logger.info({ clientName }, 'ACP client initialized');

    this.sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        name: 'mozi',
        version: '1.0.0',
        capabilities: {
          streaming: true,
          sessions: true,
          tools: true,
        },
      },
    });
  }

  // ── sessions/list ───────────────────────────────────────────────────────

  private handleSessionsList(id: string | number | null): void {
    const dbSessions = listSessions(this.userId, {
      tenantId: this.tenantId,
      limit: 50,
    });

    const sessions = dbSessions.map(s => ({
      key: `acp:${s.id}`,
      title: s.title,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));

    this.sendResponse({
      jsonrpc: '2.0',
      id,
      result: { sessions },
    });
  }

  // ── sessions/create ─────────────────────────────────────────────────────

  private handleSessionsCreate(
    id: string | number | null,
    params?: Record<string, unknown>,
  ): void {
    const uuid = randomUUID();
    const key = `acp:${uuid}`;
    const chatId = `acp-${uuid}`;

    const session: ACPSession = {
      key,
      chatId,
      userId: this.userId,
      createdAt: Date.now(),
    };
    this.sessions.set(key, session);
    this.activeSessionKey = key;

    // Ensure DB session exists
    getOrCreateSessionForChat(chatId, this.userId, this.tenantId);

    logger.info({ key, chatId }, 'ACP session created');
    this.sendResponse({
      jsonrpc: '2.0',
      id,
      result: { key, chat_id: chatId },
    });
  }

  // ── sessions/load ───────────────────────────────────────────────────────

  private handleSessionsLoad(
    id: string | number | null,
    params?: Record<string, unknown>,
  ): void {
    const key = typeof params?.key === 'string' ? params.key : null;
    if (!key) {
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing required param: key' },
      });
      return;
    }

    let session = this.sessions.get(key);
    if (!session) {
      // Try to reconstruct from key format 'acp:<id>'
      const chatId = `acp-${key.replace(/^acp:/, '')}`;
      session = {
        key,
        chatId,
        userId: this.userId,
        createdAt: Date.now(),
      };
      this.sessions.set(key, session);
    }

    this.activeSessionKey = key;
    logger.info({ key }, 'ACP session loaded');

    this.sendResponse({
      jsonrpc: '2.0',
      id,
      result: { key, chat_id: session.chatId },
    });
  }

  // ── prompt ──────────────────────────────────────────────────────────────

  private async handlePrompt(
    id: string | number | null,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const content = typeof params?.content === 'string' ? params.content : '';
    if (!content.trim()) {
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing required param: content' },
      });
      return;
    }

    // Auto-create session if none active
    if (!this.activeSessionKey) {
      const uuid = randomUUID();
      const key = `acp:${uuid}`;
      const chatId = `acp-${uuid}`;
      const session: ACPSession = { key, chatId, userId: this.userId, createdAt: Date.now() };
      this.sessions.set(key, session);
      this.activeSessionKey = key;
      getOrCreateSessionForChat(chatId, this.userId, this.tenantId);
    }

    const session = this.sessions.get(this.activeSessionKey)!;
    this.cancelFlag = false;

    // Convert to IncomingMessage
    const isCommand = content.startsWith('/');
    const incoming: IncomingMessage = {
      channelType: 'acp',
      chatId: session.chatId,
      tenantId: this.tenantId,
      userId: session.userId,
      username: 'acp-client',
      text: content,
      isCommand,
      command: isCommand ? content.split(/\s+/)[0].slice(1) : undefined,
      commandArgs: isCommand ? content.split(/\s+/).slice(1).join(' ') : undefined,
      sessionId: session.key,
      timestamp: new Date(),
    };

    // Notify: processing started
    this.sendNotification('prompt/started', {
      session_key: session.key,
    });

    try {
      const response = await this.handler(incoming);

      if (this.cancelFlag) {
        this.sendResponse({
          jsonrpc: '2.0',
          id,
          result: { status: 'cancelled', content: '' },
        });
        return;
      }

      // Send final response
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          status: 'complete',
          content: response ?? '',
          session_key: session.key,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg, sessionKey: session.key }, 'ACP prompt failed');
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: errMsg },
      });
    }
  }

  // ── cancel ──────────────────────────────────────────────────────────────

  private handleCancel(id: string | number | null): void {
    this.cancelFlag = true;
    logger.info({ sessionKey: this.activeSessionKey }, 'ACP cancel requested');
    this.sendResponse({
      jsonrpc: '2.0',
      id,
      result: { status: 'cancelled' },
    });
  }

  // ── I/O helpers ─────────────────────────────────────────────────────────

  private sendResponse(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }
}

/**
 * Create and start an ACP server with the given message handler.
 */
export function startACPServer(
  handler: MessageHandler,
  options?: ACPServerOptions,
): ACPServer {
  const server = new ACPServer(handler, options);
  server.start();
  return server;
}
