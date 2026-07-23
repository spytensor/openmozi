/**
 * WebSocket Channel Adapter — L0 channel for Web UI.
 *
 * Fastify WebSocket endpoint at /ws.
 * Same message protocol as Telegram adapter (standardized IncomingMessage).
 * JWT authentication via query param or first message.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Attachment, WorkspaceMessageContext } from './telegram.js';
import { verify as verifyJwt, type JwtPayload } from '../security/jwt.js';
import { AUTH_COOKIE_NAME } from '../security/api-auth.js';
import { getUserAuthById } from '../security/users.js';
import { assertFsPathAllowed } from '../tools/tool-utils.js';
import type { ProgressEvent } from '../progress/event-bus.js';
import * as tokenBudget from '../core/token-budget.js';
import * as providerHealth from '../core/provider-health.js';
import { getSystemOverview } from '../observer/dashboard.js';
import { getAlertHistory } from '../observer/evaluator.js';
import { getConfig } from '../config/index.js';
import { approveRequest, getRequest, rejectRequest, type ApprovalRequest } from '../security/gates.js';
import { checkCommandAccess } from '../security/rbac.js';
import type { ArtifactEnvelope, ArtifactPatch } from '../artifacts/types.js';
import { getActiveTurnForChat, requestTurnCancellation } from '../core/turn-cancellation.js';
import { SERVER_TIMELINE_CAPABILITIES, type TurnOrigin } from '../core/turn-envelope.js';
import { getLatestOpenTurnEnvelope, getTurnEnvelope, startTurnEnvelope, setTurnEnvelopeStatus } from '../memory/turn-envelopes.js';
import { inferTurnLocale } from '../core/turn-locale.js';
import { ModelNotAllowedError, QuotaExceededError } from '../security/entitlements.js';
import { BrainNotConfiguredError } from '../core/llm.js';
import {
  deleteTimelineItem,
  patchTimelineArtifactData,
  saveTimelineItem,
  type SaveTimelineResult,
} from '../memory/session-timeline.js';
import { getSession, getSessionActivity } from '../memory/sessions.js';
import { getLatestSessionMessageId, saveMessage, saveMessageAndTouchSession } from '../memory/conversations.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:websocket' });
type WebSocket = { send(data: string): void };
const ARTIFACT_TIMELINE_PERSIST_THROTTLE_MS = 500;
const artifactTimelinePersistedAt = new Map<string, number>();
const artifactTimelinePendingPatches = new Map<string, ArtifactPatch>();
/**
 * Trailing-edge flush timers, one per persist key. A throttled non-terminal
 * patch is otherwise only written when a later patch or the terminal/close
 * arrives; if the stream goes quiet the last running frame would never reach the
 * timeline. Each stash (re)arms a timer that persists the accumulated pending
 * patch after the throttle window, and every terminal/close/flush clears it.
 */
const artifactTimelinePendingFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/** Standardized incoming message from WebSocket */
export interface WsIncomingMessage {
  channelType: 'websocket';
  chatId: string;
  tenantId?: string;
  userId: string;
  username: string;
  text: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
  workspaceContext?: WorkspaceMessageContext;
  sessionId?: string;
  suppressUserMessagePersistence?: boolean;
  clientCapabilities?: string[];
  attachments?: Attachment[];
  /**
   * Server-authoritative turn id, stamped back onto this object by
   * `handleMessage` once the turn is registered (Issue #627). Not client-set —
   * it lets the synchronous reply, delivered after the turn is unregistered,
   * still persist and broadcast with the real turn identity.
   */
  turnId?: string;
  /**
   * Id of the WebSocket connection this message arrived on. Threaded so the
   * early session-binding notification (Issue #627) reaches only the
   * originating socket, never a user's other tabs.
   */
  originConnectionId?: string;
  timestamp: Date;
}

export interface WsUploadedAttachment {
  filename: string;
  path: string;
}

/**
 * Server → Client message types, matching the UI's ServerMessage type.
 *
 * - message:           { type, role, content, sessionId? }
 * - error:             { type, message }
 * - stream_start/chunk/end: { type, requestId, content?, sessionId? }
 * - tool_event:        { type, phase, tool, callId?, status, error?, sessionId? }
 * - task_update:       { type, task_id, status, progress?, title }
 * - task_progress:     { type, task_id, jobId?, status, userStatus, title, detail?, sessionId? }
 * - approval_request:  { type, id, description, sessionId?, required_level?, current_level?, denied_action?, tool? }
 * - approval_resolved: { type, id, status, sessionId?, originating_prompt?, permission_level? }
 */
export type WsOutgoingMessage =
  | { type: 'message'; role: 'assistant' | 'system'; content: string; sessionId?: string; turnId?: string; seq?: number }
  | { type: 'error'; message: string; sessionId?: string }
  | { type: 'turn_queue'; status: 'queued'; queueDepth: number; reason: 'session_busy' | 'user_concurrency_limit'; sessionId?: string; timestamp: number }
  | { type: 'stream_start'; requestId: string; sessionId?: string; turnId?: string; seq?: number }
  | { type: 'stream_chunk'; requestId: string; content: string; sessionId?: string; turnId?: string; seq?: number }
  | { type: 'stream_end'; requestId: string; content: string; sessionId?: string; turnId?: string; seq?: number }
  | { type: 'artifact_open'; artifact: ArtifactEnvelope; sessionId?: string; turnId?: string; seq?: number }
  | { type: 'artifact_patch'; artifactId: string; patch: ArtifactPatch; sessionId?: string; turnId?: string; seq?: number }
  | { type: 'artifact_close'; artifactId: string; sessionId?: string; turnId?: string; seq?: number }
  | {
      type: 'tool_event';
      phase: 'start' | 'end';
      tool: string;
      callId?: string;
      agentId?: string;
      intent?: string;
      result?: string;
      /** Web sources the tool consulted (end frames of search/fetch tools). */
      sources?: Array<{ title?: string; url: string; snippet?: string }>;
      elapsed_ms?: number;
      taskId?: string;
      turnId?: string;
      skillName?: string;
      skillDescription?: string;
      skillLoadOutcome?: 'success' | 'not_found' | 'ineligible';
      skillMissingBins?: string[];
      skillMissingEnv?: string[];
      skillLoadError?: string;
      status: 'running' | 'success' | 'error';
      error?: string;
      timestamp: number;
      sessionId?: string;
      seq?: number;
    }
  | { type: 'tool_composing'; phase: 'start' | 'end'; tool: string; callId?: string; turnId?: string; timestamp: number; sessionId?: string; seq?: number }
  | { type: 'task_update'; task_id: string; status: string; progress?: number; title: string; detail?: string; turnId?: string; seq?: number; parentTaskId?: string; rawStatus?: string }
  | {
      /**
       * Typed plan presentation event (Issue #735): the plan's goal + phases as
       * data. The single source for plan structure across the inline card,
       * sticky capsule, and inspector — never derived from assistant prose.
       */
      type: 'plan_started';
      plan_id: string;
      goal: string;
      phases: Array<{ taskId: string; title: string; dependsOn: string[] }>;
      locale?: string;
      turnId?: string;
      seq?: number;
      timestamp: number;
      sessionId?: string;
    }
  | {
      type: 'task_progress';
      task_id: string;
      parentTaskId?: string;
      jobId?: string;
      adapterId?: string;
      runtimeLabel?: string;
      rawStatus?: string;
      status: 'pending' | 'running' | 'completed' | 'failed';
      userStatus:
        | 'received'
        | 'planning'
        | 'responding'
        | 'checking'
        | 'starting'
        | 'working'
        | 'verifying'
        | 'done'
        | 'blocked';
      title: string;
      detail?: string;
      turnId?: string;
      lane?: string;
      sandboxProfile?: string;
      heartbeat?: boolean;
      elapsed_ms?: number;
      timestamp: number;
      sessionId?: string;
      seq?: number;
    }
  | {
      type: 'approval_request';
      id: string;
      description: string;
      action?: string;
      sessionId?: string;
      turnId?: string;
      seq?: number;
      required_level?: string;
      current_level?: string;
      denied_action?: string;
      tool?: string;
      tool_intent?: string;
      originating_prompt?: string;
      grant_scope?: 'once' | 'session';
    }
  | {
      type: 'approval_resolved';
      id: string;
      status: 'approved' | 'rejected';
      action?: string;
      description?: string;
      sessionId?: string;
      turnId?: string;
      seq?: number;
      permission_level?: string;
      required_level?: string;
      current_level?: string;
      denied_action?: string;
      tool?: string;
      tool_intent?: string;
      originating_prompt?: string;
      grant_scope?: 'once' | 'session';
    }
  | { type: 'session_update'; sessionId: string; title: string }
  | { type: 'session_list_changed'; sessionId: string }
  | { type: 'session_activity'; sessionId: string; status: 'running' | 'awaiting_approval' | null; startedAt?: number }
  | { type: 'context_compression'; sessionId: string; stage: string; sourceTokens: number; summaryTokens?: number; contextWindow: number; timestamp: number }
  | {
      type: 'memory_update';
      count: number;
      added: number;
      reinforced: number;
      updated: number;
      factIds: number[];
      sessionId: string;
      turnId: string;
      timestamp: number;
      seq?: number;
    }
  | { type: 'session_selected'; sessionId: string | null }
  // Server-authoritative early session binding (Issue #627). Sent to the
  // originating connection only, before the turn's first session-scoped frame,
  // when a brand-new Web chat resolves its session server-side. Distinct from
  // `session_selected` (the reply to an explicit client `select_session`) so
  // the client can adopt a just-created session without conflating it with a
  // user-driven selection.
  | { type: 'session_bound'; sessionId: string }
  | { type: 'welcome'; username: string; model: string; capabilities?: string[] }
  | { type: 'active_turn'; turnId: string | null; sessionId?: string; startedAt?: number; locale?: string }
  | { type: 'turn_envelope'; turn: import('../core/turn-envelope.js').TurnEnvelope };

/** Client → Server message types */
interface ClientWsMessage {
  type: 'message' | 'auth' | 'approve' | 'reject' | 'ping' | 'hello' | 'cancel_turn' | 'select_session' | 'subscribe_workspace' | 'unsubscribe_workspace';
  content?: string;
  token?: string;
  id?: string;
  sessionId?: string;
  turnId?: string;
  regenerate?: boolean;
  attachments?: WsUploadedAttachment[];
  workspaceContext?: WorkspaceMessageContext;
  capabilities?: string[];
  client?: string;
  /** For 'approve' of a path_scope_grant: 'once' | 'session'. */
  scope?: unknown;
}

/**
 * Convert a client WebSocket message into user text consumed by gateway handler.
 * approve/reject messages are mapped to equivalent slash commands.
 */
export function resolveClientText(clientMsg: Pick<ClientWsMessage, 'type' | 'content' | 'id' | 'attachments' | 'scope'>): { text: string } | { error: string } | null {
  if (clientMsg.type === 'message') {
    const text = clientMsg.content ?? '';
    const hasAttachments = Array.isArray(clientMsg.attachments) && clientMsg.attachments.length > 0;
    if (!text.trim() && !hasAttachments) return null;
    return { text };
  }

  if (clientMsg.type === 'approve' || clientMsg.type === 'reject') {
    const requestId = clientMsg.id?.trim();
    if (!requestId) {
      return { error: `Missing request id for "${clientMsg.type}"` };
    }
    const scope = clientMsg.type === 'approve' && (clientMsg.scope === 'once' || clientMsg.scope === 'session')
      ? ` ${clientMsg.scope}`
      : '';
    return { text: `/${clientMsg.type} ${requestId}${scope}` };
  }

  return null;
}

/** Message handler (same signature as Telegram) */
export type WsMessageHandler = (msg: WsIncomingMessage) => Promise<string | null>;

export function buildTypedErrorChatMessage(err: unknown, sessionId?: string): WsOutgoingMessage | null {
  if (!(err instanceof ModelNotAllowedError || err instanceof QuotaExceededError || err instanceof BrainNotConfiguredError)) {
    return null;
  }
  return {
    type: 'message',
    role: 'assistant',
    content: err.message,
    ...(sessionId ? { sessionId } : {}),
  };
}

function contextString(request: ApprovalRequest, key: string): string | undefined {
  const value = request.context?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildApprovalResolvedMessageFromRequest(
  request: ApprovalRequest,
): Extract<WsOutgoingMessage, { type: 'approval_resolved' }> {
  const requiredLevel = contextString(request, 'required_level');
  const grantScope = contextString(request, 'grant_scope') as 'once' | 'session' | undefined;
  const sessionFullAccess = request.status === 'approved' &&
    (request.action === 'permission_elevation' || request.action === 'write_confirmation') &&
    grantScope !== 'once';
  return {
    type: 'approval_resolved',
    id: request.id,
    status: request.status === 'approved' ? 'approved' : 'rejected',
    action: request.action,
    description: request.description,
    sessionId: contextString(request, 'sessionId'),
    permission_level: sessionFullAccess ? 'L3_FULL_ACCESS' : undefined,
    required_level: requiredLevel,
    current_level: contextString(request, 'current_level'),
    denied_action: contextString(request, 'denied_action'),
    tool: contextString(request, 'tool'),
    tool_intent: contextString(request, 'tool_intent'),
    originating_prompt: contextString(request, 'originating_prompt'),
    grant_scope: grantScope,
  };
}

function persistApprovalResolvedTimeline(
  msg: Extract<WsOutgoingMessage, { type: 'approval_resolved' }>,
  tenantId: string | undefined,
  chatId: string | undefined,
  timestamp: number,
  turnId?: string,
): SaveTimelineResult | null {
  if (!msg.sessionId || !chatId) return null;
  return saveTimelineItem({
    tenantId,
    sessionId: msg.sessionId,
    chatId,
    turnId,
    type: 'approval_request',
    eventKey: `approval:${msg.id}`,
    timestamp,
    // Keep the card in its original position on refresh — only the
    // status/payload changes, not where it sits in the timeline.
    preserveTimestampOnUpdate: true,
    data: {
      id: msg.id,
      description: msg.description ?? '',
      action: msg.action,
      status: msg.status,
      required_level: msg.required_level,
      current_level: msg.current_level,
      denied_action: msg.denied_action,
      tool: msg.tool,
      tool_intent: msg.tool_intent,
      originating_prompt: msg.originating_prompt,
      permission_level: msg.permission_level,
      grant_scope: msg.grant_scope,
    },
  });
}

// ---------------------------------------------------------------------------
// WebSocket client tracking
// ---------------------------------------------------------------------------

export interface WsClient {
  id: string;
  userId: string;
  tenantId: string;
  username: string;
  authenticated: boolean;
  capabilities: string[];
}

/** Internal tracked connection with socket reference */
interface TrackedConnection {
  client: WsClient;
  socket: WebSocket;
  workspaceSubscribed: boolean;
  /** Last session the client reported viewing; scopes session-bound fan-out. */
  activeSessionId?: string;
}

const connections = new Map<string, TrackedConnection>();

function isOwnerConn(conn: TrackedConnection, userId: string | undefined, tenantId: string | undefined): boolean {
  if (!userId || !tenantId) return false;
  return conn.client.userId === userId && conn.client.tenantId === tenantId;
}

export function buildWebSocketChatId(client: Pick<WsClient, 'id' | 'userId'>, sessionId?: string): string {
  const scope = sessionId?.trim() || client.id;
  return `${client.userId}:${scope}`;
}

/**
 * Resolve the owning turn id for an interactive event (Issue #627).
 *
 * Producers on the tool/task/approval path already stamp `turnId`. The stream,
 * artifact, and final-message paths do not — they carry only a chat scope. For
 * those we look up the server-authoritative active-turn registry so every
 * persisted interactive row inherits turn identity from one source of truth
 * rather than each producer re-deriving it. Falling back through the canonical
 * `userId:sessionId` key covers the paths that persist with a bare user id.
 */
function resolveActiveTurnId(
  explicit: string | undefined,
  chatId: string | undefined,
  sessionId: string | undefined,
  tenantId: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  const tenant = tenantId ?? 'default';
  const candidates: string[] = [];
  if (chatId) candidates.push(chatId);
  if (chatId && sessionId && !chatId.includes(':')) candidates.push(`${chatId}:${sessionId}`);
  for (const key of candidates) {
    const active = getActiveTurnForChat(key, tenant);
    if (active?.turnId) return active.turnId;
  }
  return undefined;
}

function isSessionOwnerConn(conn: TrackedConnection, sessionId: string): boolean {
  const session = getSession(sessionId, conn.client.tenantId);
  return session ? isOwnerConn(conn, session.user_id, session.tenant_id) : false;
}

/** Get all connected clients (metadata only) */
/**
 * A valid JWT is not enough to authenticate a WebSocket client: a user
 * disabled after token issuance must be rejected at connect/auth time.
 * Only rejects when a users row exists and is disabled — non-local
 * identities (no users row) keep their existing behavior.
 */
export function isDisabledUser(payload: JwtPayload): boolean {
  const payloadTenant = typeof payload.tenant_id === 'string' ? payload.tenant_id : 'default';
  const record = getUserAuthById(payload.sub, payloadTenant);
  return record?.status === 'disabled';
}

export function getConnectedClients(): WsClient[] {
  return Array.from(connections.values()).map(c => c.client);
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** Send a typed message to a WebSocket */
function sendWsMessage(socket: WebSocket, msg: WsOutgoingMessage): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // Socket may have closed
  }
}

/**
 * Broadcast the durable aggregate activity for one session to every connection
 * owned by that session's user. Unlike normal chat frames this deliberately is
 * not scoped to the currently selected session: its consumer is the global
 * sidebar, which must show work continuing elsewhere.
 */
export function broadcastSessionActivityEvent(input: { tenantId?: string; sessionId: string }): void {
  const tenantId = input.tenantId ?? 'default';
  const session = getSession(input.sessionId, tenantId);
  if (!session) return;
  const activity = getSessionActivity(input.sessionId, tenantId);
  const message: WsOutgoingMessage = {
    type: 'session_activity',
    sessionId: input.sessionId,
    status: activity.status,
    ...(activity.startedAt == null ? {} : { startedAt: activity.startedAt }),
  };
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, session.user_id, session.tenant_id)) continue;
    sendWsMessage(conn.socket, message);
  }
}

/** Tell every connection for one owner to refresh its global session list. */
export function broadcastSessionListChanged(input: { targetUserId: string; tenantId?: string; sessionId: string }): void {
  const tenantId = input.tenantId ?? 'default';
  const message: WsOutgoingMessage = { type: 'session_list_changed', sessionId: input.sessionId };
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, input.targetUserId, tenantId)) continue;
    sendWsMessage(conn.socket, message);
  }
}

type ApprovalControlMessage = { type: 'approve' | 'reject'; id?: string; scope?: unknown };

function isApprovalControlMessage(clientMsg: ClientWsMessage): clientMsg is ApprovalControlMessage {
  return clientMsg.type === 'approve' || clientMsg.type === 'reject';
}

export function handleStructuredApprovalControlMessage(
  clientMsg: ApprovalControlMessage,
  client: WsClient,
  socket: WebSocket,
): void {
  const requestId = clientMsg.id?.trim();
  if (!requestId) {
    sendWsMessage(socket, { type: 'error', message: `Missing request id for "${clientMsg.type}"` });
    return;
  }

  try {
    checkCommandAccess(client.tenantId, client.userId, clientMsg.type);
    const scope = clientMsg.scope === 'once' || clientMsg.scope === 'session' ? clientMsg.scope : undefined;
    const request = clientMsg.type === 'approve'
      ? approveRequest(requestId, client.userId, client.tenantId, scope ? { grantScope: scope } : undefined)
      : rejectRequest(requestId, client.userId, client.tenantId);
    const ack = buildApprovalResolvedMessageFromRequest(request);
    sendWsMessage(socket, ack);
    persistApprovalResolvedTimeline(
      ack,
      client.tenantId,
      contextString(request, 'chatId') ?? client.userId,
      Date.now(),
      contextString(request, 'turnId'),
    );
  } catch (err) {
    const current = getRequest(requestId, client.tenantId);
    if (current && current.status !== 'pending') {
      const ack = buildApprovalResolvedMessageFromRequest(current);
      sendWsMessage(socket, ack);
      persistApprovalResolvedTimeline(
        ack,
        client.tenantId,
        contextString(current, 'chatId') ?? client.userId,
        Date.now(),
        contextString(current, 'turnId'),
      );
      return;
    }
    sendWsMessage(socket, {
      type: 'error',
      message: err instanceof Error ? err.message : 'Approval request could not be resolved',
    });
  }
}

/**
 * Tell a freshly authenticated client what is actually running for its chat.
 * The registry is in-memory, so `turnId: null` after a restart is the truth —
 * the client uses it to re-arm the stop button for a live turn, or to render
 * orphaned in-flight steps as interrupted instead of spinning forever.
 */
function sendActiveTurnSnapshot(socket: WebSocket, client: WsClient, sessionId?: string): void {
  const registered = sessionId
    ? getActiveTurnForChat(buildWebSocketChatId(client, sessionId), client.tenantId)
    : undefined;
  const durable = sessionId ? getLatestOpenTurnEnvelope(sessionId, client.tenantId) : null;
  // The controller registry owns cancellation while this process is alive;
  // the envelope owns reconnect visibility and approval-wait state.
  const active = registered ?? (durable ? {
    turnId: durable.turnId,
    sessionId: durable.sessionId,
    startedAt: durable.startedAt,
  } : undefined);
  sendWsMessage(socket, {
    type: 'active_turn',
    turnId: active?.turnId ?? null,
    sessionId: active?.sessionId,
    startedAt: active?.startedAt,
    locale: durable && durable.turnId === active?.turnId ? durable.locale : undefined,
  });
}

/**
 * Bind a just-resolved session to its originating connection (Issue #627).
 *
 * Fired from the turn's `onSessionResolved` callback for a brand-new Web chat
 * whose client sent no sessionId. Targets ONLY the connection the message
 * arrived on — never the user's other tabs — so a second tab viewing another
 * session is never switched. It updates the tracked active session (so later
 * session-scoped fan-out includes this connection) and sends a `session_bound`
 * frame that, because `onSessionResolved` runs before any stream/artifact
 * frame, reaches the client before the frames its session filter would
 * otherwise reject.
 *
 * Ownership is re-checked against the tracked connection's own identity; a
 * mismatch (e.g. a recycled connection id) is ignored rather than trusted.
 *
 * @returns true when the bound frame was delivered to the originating client.
 */
export function bindResolvedSessionToConnection(input: {
  connectionId: string | undefined;
  sessionId: string;
  userId: string;
  tenantId?: string;
}): boolean {
  if (!input.connectionId || !input.sessionId) return false;
  const conn = connections.get(input.connectionId);
  if (!conn || !conn.client.authenticated) return false;
  const tenantId = input.tenantId ?? 'default';
  // Isolation: only bind the socket that actually owns this turn.
  if (!isOwnerConn(conn, input.userId, tenantId)) return false;
  conn.activeSessionId = input.sessionId;
  sendWsMessage(conn.socket, { type: 'session_bound', sessionId: input.sessionId });
  logger.debug(
    { connectionId: input.connectionId, sessionId: input.sessionId, userId: input.userId },
    'Bound resolved session to originating connection',
  );
  return true;
}

/** Parse raw WebSocket data as a client message, or treat as plain text. */
function parseClientMessage(raw: string): ClientWsMessage {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as ClientWsMessage;
    }
  } catch {
    // Not JSON — treat as plain text message
  }
  return { type: 'message', content: raw };
}

function sanitizeCapabilities(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized.length > 64) continue;
    seen.add(normalized);
  }
  return [...seen];
}

function sanitizeWorkspaceContext(input: unknown): WorkspaceMessageContext | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const rootPath = typeof raw.rootPath === 'string' ? raw.rootPath.trim() : '';
  if (!rootPath || rootPath.length > 4096) return undefined;
  const rootKind = typeof raw.rootKind === 'string' ? raw.rootKind.trim().slice(0, 64) : undefined;
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 160) : undefined;
  const gitBranch = typeof raw.gitBranch === 'string' ? raw.gitBranch.trim().slice(0, 160) : undefined;
  return {
    rootPath,
    ...(rootKind ? { rootKind } : {}),
    ...(label ? { label } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
}

function sanitizeUploadedAttachments(input: unknown, userId: string): Attachment[] | undefined {
  if (!Array.isArray(input)) return undefined;

  const attachments: Attachment[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    const rawPath = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!rawPath || rawPath.length > 4096 || !isAbsolute(rawPath)) continue;
    const resolvedPath = resolve(rawPath);
    try {
      assertFsPathAllowed(resolvedPath, rawPath, userId);
    } catch (err) {
      logger.warn({
        userId,
        path: rawPath,
        err: err instanceof Error ? err.message : String(err),
      }, 'Rejected WebSocket attachment outside allowed roots');
      continue;
    }

    const filename = typeof raw.filename === 'string' && raw.filename.trim()
      ? basename(raw.filename.trim()).slice(0, 255)
      : basename(resolvedPath);
    attachments.push({
      type: 'document',
      path: resolvedPath,
      filename,
      mime: 'application/octet-stream',
    });
  }

  return attachments.length > 0 ? attachments : undefined;
}

/** Convert text into a WsIncomingMessage for the handler. */
export function textToIncoming(
  text: string,
  client: WsClient,
  workspaceContext?: WorkspaceMessageContext,
  attachments?: Attachment[],
  sessionId?: string,
  suppressUserMessagePersistence = false,
): WsIncomingMessage {
  const isCommand = text.startsWith('/');
  let command: string | undefined;
  let commandArgs: string | undefined;
  const normalizedSessionId = sessionId?.trim() || undefined;

  if (isCommand) {
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx > 0) {
      command = text.slice(1, spaceIdx);
      commandArgs = text.slice(spaceIdx + 1).trim();
    } else {
      command = text.slice(1);
    }
  }

  return {
    channelType: 'websocket',
    chatId: buildWebSocketChatId(client, normalizedSessionId),
    tenantId: client.tenantId,
    userId: client.userId,
    username: client.username,
    text,
    isCommand,
    command,
    commandArgs,
    workspaceContext,
    sessionId: normalizedSessionId,
    ...(suppressUserMessagePersistence ? { suppressUserMessagePersistence: true } : {}),
    clientCapabilities: client.capabilities,
    attachments,
    originConnectionId: client.id,
    timestamp: new Date(),
  };
}

// Keep legacy exports for any code referencing these
export const parseWsMessage = textToIncoming;
export function createWsResponse(type: string, text?: string, data?: unknown): string {
  return JSON.stringify({ type, text, data, timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// WebSocket route registration
// ---------------------------------------------------------------------------

export interface WsRouteOptions {
  authMode: string;
  secret: string;
}

/**
 * Register WebSocket endpoint on a Fastify instance.
 *
 * @param app     - Fastify instance (must have @fastify/websocket registered)
 * @param handler - Message handler (same as Telegram handler)
 * @param secret  - JWT secret for authentication
 * @param options - Auth mode and secret
 */
export function registerWebSocketRoute(
  app: FastifyInstance,
  handler: WsMessageHandler,
  secret: string,
  options?: { authMode?: string },
): void {
  const authMode = options?.authMode ?? 'none';

  app.get('/ws', { websocket: true }, (socket, request) => {
    const clientId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Auth: try JWT from cookie or query param
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const cookies = (request as { cookies?: Record<string, string | undefined> }).cookies;
    const cookieToken = cookies?.[AUTH_COOKIE_NAME];
    const queryToken = url.searchParams.get('token');
    const token = cookieToken || queryToken;
    let authenticated = authMode === 'none'; // auto-auth when auth_mode is 'none'
    let userId = authMode === 'none' ? 'local-user' : 'anonymous';
    let tenantId = 'default';
    let username = authMode === 'none' ? 'user' : 'anonymous';

    if (token) {
      const payload = verifyJwt(token, secret);
      if (payload && !isDisabledUser(payload)) {
        authenticated = true;
        userId = payload.sub;
        tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : 'default';
        username = (payload.username as string) ?? payload.sub;
      }
    }

    const client: WsClient = {
      id: clientId,
      userId,
      tenantId,
      username,
      authenticated,
      capabilities: [],
    };
    const tracked: TrackedConnection = { client, socket: socket as unknown as WebSocket, workspaceSubscribed: false };
    connections.set(clientId, tracked);

    logger.info({ clientId, userId, authenticated, authMode }, 'WebSocket client connected');

    socket.on('message', async (raw: Buffer | string) => {
      const data = raw.toString();
      const clientMsg = parseClientMessage(data);

      // Handle ping — respond with pong, no auth needed
      if (clientMsg.type === 'ping') {
        sendWsMessage(socket as unknown as WebSocket, { type: 'message', role: 'system', content: 'pong' });
        return;
      }

      // Handle auth message if not yet authenticated
      if (!client.authenticated) {
        if (clientMsg.type === 'auth' && clientMsg.token) {
          const payload = verifyJwt(clientMsg.token, secret);
          if (payload && !isDisabledUser(payload)) {
            client.authenticated = true;
            client.userId = payload.sub;
            client.tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : 'default';
            client.username = (payload.username as string) ?? payload.sub;
            tracked.client = client;
            connections.set(clientId, tracked);
            sendWsMessage(socket as unknown as WebSocket, {
              type: 'message', role: 'system', content: `Authenticated as ${client.username}`,
            });
            sendActiveTurnSnapshot(socket as unknown as WebSocket, client);
            logger.info({ clientId, userId: client.userId }, 'WebSocket client authenticated');
            return;
          }
        }
        sendWsMessage(socket as unknown as WebSocket, {
          type: 'error', message: 'Authentication required. Send {"type":"auth","token":"<jwt>"}',
        });
        return;
      }

      // Client hello / capability negotiation (requires auth)
      if (clientMsg.type === 'hello') {
        const capabilities = sanitizeCapabilities(clientMsg.capabilities);
        client.capabilities = capabilities;
        tracked.client = client;
        connections.set(clientId, tracked);
        logger.debug({ clientId, userId: client.userId, capabilities, client: clientMsg.client ?? 'unknown' }, 'WebSocket client capabilities negotiated');
        return;
      }

      // Handle workspace subscribe/unsubscribe (requires auth)
      if (clientMsg.type === 'subscribe_workspace') {
        tracked.workspaceSubscribed = true;
        sendWorkspaceSnapshot(socket as unknown as WebSocket, tracked.client);
        logger.debug({ clientId }, 'Workspace subscribed');
        return;
      }
      if (clientMsg.type === 'unsubscribe_workspace') {
        tracked.workspaceSubscribed = false;
        logger.debug({ clientId }, 'Workspace unsubscribed');
        return;
      }

      if (clientMsg.type === 'select_session') {
        const sessionId = clientMsg.sessionId?.trim();
        if (!sessionId) {
          tracked.activeSessionId = undefined;
          sendWsMessage(socket as unknown as WebSocket, { type: 'session_selected', sessionId: null });
          sendActiveTurnSnapshot(socket as unknown as WebSocket, client);
          return;
        }
        const selected = getSession(sessionId, client.tenantId);
        if (!selected || selected.user_id !== client.userId) {
          sendWsMessage(socket as unknown as WebSocket, {
            type: 'error',
            message: 'Session not found or access denied.',
            sessionId,
          });
          return;
        }
        tracked.activeSessionId = sessionId;
        sendWsMessage(socket as unknown as WebSocket, { type: 'session_selected', sessionId });
        sendActiveTurnSnapshot(socket as unknown as WebSocket, client, sessionId);
        return;
      }

      if (clientMsg.type === 'cancel_turn') {
        const sessionId = clientMsg.sessionId ?? tracked.activeSessionId;
        const sessionChatId = buildWebSocketChatId(client, sessionId);
        const result = requestTurnCancellation({
          tenantId: client.tenantId,
          chatId: sessionChatId,
          turnId: typeof clientMsg.turnId === 'string' ? clientMsg.turnId : undefined,
          requestedBy: client.userId,
          reason: 'User requested cancellation',
        });
        if (!result.ok) {
          if (result.status === 'not_found' && sessionId) {
            const selected = getSession(sessionId, client.tenantId);
            if (selected?.user_id === client.userId) {
              const { getActiveScheduledTaskForSession } = await import('../core/background-tasks.js');
              const background = getActiveScheduledTaskForSession(sessionId, client.userId, client.tenantId);
              if (background?.source_cron_task_id) {
                const { cascadeCancelCronTask } = await import('../background-executor/runner.js');
                await cascadeCancelCronTask(background.source_cron_task_id, client.tenantId);
                return;
              }
            }
          }
          sendWsMessage(socket as unknown as WebSocket, {
            type: 'error',
            message: result.message,
          });
        }
        return;
      }

      if (isApprovalControlMessage(clientMsg)) {
        handleStructuredApprovalControlMessage(clientMsg, client, socket as unknown as WebSocket);
        return;
      }

      // Extract text content from client message
      const resolvedText = resolveClientText(clientMsg);
      if (resolvedText && 'error' in resolvedText) {
        sendWsMessage(socket as unknown as WebSocket, {
          type: 'error',
          message: resolvedText.error,
        });
        return;
      }
      if (!resolvedText) return;
      const text = resolvedText.text;

      // Parse and handle message
      try {
        const incoming = textToIncoming(
          text,
          client,
          sanitizeWorkspaceContext(clientMsg.workspaceContext),
          sanitizeUploadedAttachments(clientMsg.attachments, client.userId),
          // A newly created chat is bound server-side through `session_bound`.
          // Subsequent composer messages do not have to echo that id in their
          // payload, so fall back to the connection's authoritative selection.
          // Without this, every later turn silently created an internal session
          // and its transcript disappeared after reload.
          clientMsg.sessionId ?? tracked.activeSessionId,
          clientMsg.regenerate === true,
        );
        if (incoming.sessionId) {
          const selected = getSession(incoming.sessionId, client.tenantId);
          if (!selected || selected.user_id !== client.userId) {
            sendWsMessage(socket as unknown as WebSocket, {
              type: 'error',
              message: 'Session not found or access denied.',
              sessionId: incoming.sessionId,
            });
            return;
          }
          // The persisted, ownership-checked session is authoritative. A Web
          // client may request a scope transition through the session API, but
          // cannot smuggle an arbitrary execution path into a single message.
          incoming.workspaceContext = selected.execution_context ?? undefined;
          tracked.activeSessionId = incoming.sessionId;
        }
        logger.info({
          clientId,
          userId: client.userId,
          text: text.slice(0, 100),
          attachmentCount: incoming.attachments?.length ?? 0,
        }, 'WebSocket message received');

        const response = await handler(incoming);
        if (response) {
          // Runtime commands are transport diagnostics, not part of a user
          // conversation. Rendering them for this connection is useful, but
          // persisting them made `/status` reappear as a giant answer on every
          // desktop restart.
          // Authoritative turn identity: `handleMessage` stamped `incoming.turnId`
          // when it registered the turn (Issue #627). This synchronous reply runs
          // after the turn is unregistered, so the active-turn registry would miss;
          // the stamped id (falling back to the registry for turn-less paths) keeps
          // the final persisted row AND the outgoing frame on the real turn.
          const turnId = resolveActiveTurnId(incoming.turnId, incoming.chatId, incoming.sessionId, client.tenantId);
          let seq: number | null = null;
          if (incoming.sessionId && !incoming.isCommand) {
            const timestamp = Date.now();
            const conversationId = getLatestSessionMessageId(incoming.sessionId, 'assistant', response, client.tenantId);
            const saved = saveTimelineItem({
              tenantId: client.tenantId,
              sessionId: incoming.sessionId,
              chatId: incoming.chatId,
              turnId,
              ...(conversationId ? { conversationId } : {}),
              type: 'message',
              eventKey: `message:assistant:${timestamp}`,
              timestamp,
              data: {
                id: `msg_${timestamp}_assistant`,
                role: 'assistant',
                content: response,
                timestamp,
                ...(turnId ? { turnId } : {}),
              },
            });
            seq = saved.seq;
          }
          sendWsMessage(socket as unknown as WebSocket, {
            type: 'message', role: 'assistant', content: response, sessionId: incoming.sessionId,
            ...(turnId ? { turnId } : {}),
            ...(seq != null ? { seq } : {}),
            ...(clientMsg.regenerate === true ? { regenerate: true } : {}),
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ clientId, error: errMsg }, 'Error handling WebSocket message');
        const typedErrorMessage = buildTypedErrorChatMessage(err, clientMsg.sessionId);
        if (typedErrorMessage) {
          sendWsMessage(socket as unknown as WebSocket, typedErrorMessage);
          return;
        }
        sendWsMessage(socket as unknown as WebSocket, {
          type: 'error', message: 'An error occurred while processing your message.',
        });
      }
    });

    socket.on('close', () => {
      connections.delete(clientId);
      // When the last connection for this session drops, flush and evict its
      // module-global artifact throttle state so keys for artifacts that never
      // terminalized don't accumulate for the lifetime of the process.
      const sessionId = tracked.activeSessionId;
      if (sessionId) {
        let siblingStillViewing = false;
        for (const [, conn] of connections) {
          if (conn.client.tenantId === client.tenantId && conn.activeSessionId === sessionId) {
            siblingStillViewing = true;
            break;
          }
        }
        if (!siblingStillViewing) {
          flushAndSweepArtifactTimelineState(client.tenantId, sessionId, client.userId);
        }
      }
      logger.info({ clientId, userId: client.userId }, 'WebSocket client disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ clientId, error: err.message }, 'WebSocket error');
    });

    // Send welcome message with current model info
    if (authenticated) {
      sendActiveTurnSnapshot(socket as unknown as WebSocket, client, tracked.activeSessionId);
      let currentModel = '';
      try {
        // Dynamic import is async; fire-and-forget welcome with model info
        import('../config/index.js').then(({ loadConfig }) => {
          currentModel = loadConfig().brain?.model ?? '';
          sendWsMessage(socket as unknown as WebSocket, {
            type: 'welcome', username, model: currentModel, capabilities: [...SERVER_TIMELINE_CAPABILITIES],
          });
        }).catch(() => {
          sendWsMessage(socket as unknown as WebSocket, {
            type: 'welcome', username, model: '', capabilities: [...SERVER_TIMELINE_CAPABILITIES],
          });
        });
      } catch {
        sendWsMessage(socket as unknown as WebSocket, {
          type: 'welcome', username, model: '', capabilities: [...SERVER_TIMELINE_CAPABILITIES],
        });
      }
    } else {
      sendWsMessage(socket as unknown as WebSocket, {
        type: 'error', message: 'Authentication required. Send {"type":"auth","token":"<jwt>"} or connect with ?token=<jwt>',
      });
    }
  });
}

/**
 * Internal event types that should NOT be exposed to the UI.
 */
const INTERNAL_EVENT_TYPES = new Set([
  'budget_warning',
]);

function parseWebSocketChatOwner(chatId: string | undefined): string | undefined {
  if (!chatId) return undefined;
  const separator = chatId.indexOf(':');
  return separator > 0 ? chatId.slice(0, separator) : undefined;
}

function isSameChat(
  conn: TrackedConnection,
  chatId?: string,
  tenantId = 'default',
  sessionId?: string,
): boolean {
  if (sessionId) {
    if (!acceptsSession(conn, sessionId)) return false;
    const session = getSession(sessionId, tenantId);
    if (session) {
      return isOwnerConn(conn, session.user_id, session.tenant_id);
    }
  }
  if (!chatId) return true;
  return isOwnerConn(conn, chatId, tenantId) || isOwnerConn(conn, parseWebSocketChatOwner(chatId), tenantId);
}

function acceptsSession(conn: TrackedConnection, sessionId?: string): boolean {
  if (!sessionId) return true;
  const requiresSubscription = conn.client.capabilities.includes('session_subscription_v1');
  return requiresSubscription
    ? conn.activeSessionId === sessionId
    : !conn.activeSessionId || conn.activeSessionId === sessionId;
}

function shouldReceiveExecutionEvent(conn: TrackedConnection): boolean {
  return conn.client.capabilities.includes('execution_v1');
}

type TaskProgressUserStatus = Extract<WsOutgoingMessage, { type: 'task_progress' }>['userStatus'];
type TaskProgressStatus = Extract<WsOutgoingMessage, { type: 'task_progress' }>['status'];

function mapWorkerStatus(status: string | undefined, heartbeat?: boolean): {
  status: TaskProgressStatus;
  userStatus: TaskProgressUserStatus;
  title: string;
} {
  switch (status) {
    case 'queued':
      return { status: 'pending', userStatus: 'checking', title: 'Checking task readiness' };
    case 'launching':
      return { status: 'running', userStatus: 'starting', title: 'Starting task' };
    case 'running':
      return {
        status: 'running',
        userStatus: 'working',
        title: heartbeat ? 'Still working' : 'Working on task',
      };
    case 'completed_pending_verify':
      return { status: 'running', userStatus: 'verifying', title: 'Verifying result' };
    case 'succeeded':
    case 'completed':
      return { status: 'completed', userStatus: 'done', title: 'Task done' };
    case 'failed':
    case 'timed_out':
    case 'cancelled':
      return { status: 'failed', userStatus: 'blocked', title: 'Task blocked' };
    default:
      return { status: 'running', userStatus: 'working', title: 'Working on task' };
  }
}

export function buildWorkerTaskProgressMessage(
  event: ProgressEvent,
): Extract<WsOutgoingMessage, { type: 'task_progress' }> | null {
  if (event.type !== 'worker_status') return null;
  const taskId = event.taskId || event.jobId;
  if (!taskId) return null;

  const mapped = mapWorkerStatus(event.workerStatus, event.heartbeat);
  const title = event.summary?.trim() || mapped.title;

  return {
    type: 'task_progress',
    task_id: taskId,
    parentTaskId: event.parentTaskId,
    jobId: event.jobId,
    adapterId: event.adapterId,
    runtimeLabel: event.runtimeLabel,
    rawStatus: event.workerStatus,
    status: mapped.status,
    userStatus: mapped.userStatus,
    title,
    detail: event.summary,
    turnId: event.turnId,
    lane: event.lane,
    sandboxProfile: event.sandboxProfile,
    heartbeat: event.heartbeat,
    elapsed_ms: event.elapsed_ms,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
  };
}

export function buildTurnStateTaskProgressMessages(
  event: ProgressEvent,
): Array<Extract<WsOutgoingMessage, { type: 'task_progress' }>> {
  if (event.type !== 'turn_state' || !event.turnId) return [];

  const makeMessage = (
    stage: 'responding' | 'failed',
    status: TaskProgressStatus,
    userStatus: TaskProgressUserStatus,
    title: string,
    detail?: string,
  ): Extract<WsOutgoingMessage, { type: 'task_progress' }> => ({
    type: 'task_progress',
    task_id: `${event.turnId}:${stage}`,
    status,
    userStatus,
    title,
    detail,
    turnId: event.turnId,
    rawStatus: event.turnState,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
  });

  // Turn lifecycle is a session-state signal, NOT a sequence of work steps. The
  // Brain's real activity is surfaced by tool_event + streamed text; fabricating a
  // fixed "received → planning → working → responding" narrative for every turn —
  // identical whether the user said "hi" or "build a scraper" — is exactly the
  // invented-progress scaffolding the constitution forbids. The frontend already
  // drives WORKING/RESPONDING from the real send, tool, and stream events, so we
  // emit only truthful *terminal* markers: one to unlock input when the turn ends,
  // and one to surface a failure. Intermediate states render nothing.
  switch (event.turnState) {
    case 'DONE':
      return [makeMessage('responding', 'completed', 'responding', 'Turn complete')];
    case 'FAILED':
      return [makeMessage('failed', 'failed', 'blocked', 'Request needs attention', event.detail)];
    case 'CANCELLED':
      return [makeMessage('failed', 'failed', 'blocked', 'Request cancelled', event.detail)];
    default:
      return [];
  }
}

function persistToolEventTimeline(
  event: ProgressEvent,
  msg: Extract<WsOutgoingMessage, { type: 'tool_event' }>,
): SaveTimelineResult | null {
  if (!event.sessionId || !event.chatId || !msg.callId) return null;
  return saveTimelineItem({
    tenantId: event.tenantId,
    sessionId: event.sessionId,
    chatId: event.chatId,
    turnId: msg.turnId,
    type: 'tool_event',
    eventKey: `tool:${msg.callId}`,
    timestamp: msg.timestamp,
    preserveTimestampOnUpdate: true,
    mergeDataOnUpdate: true,
    data: {
      id: `tool_${msg.callId}`,
      callId: msg.callId,
      taskId: msg.taskId,
      turnId: msg.turnId,
      agentId: msg.agentId,
      tool: msg.tool,
      phase: msg.phase,
      status: msg.status,
      intent: msg.intent,
      result: msg.result,
      sources: msg.sources,
      error: msg.error,
      elapsed_ms: msg.elapsed_ms,
      skillName: msg.skillName,
      skillDescription: msg.skillDescription,
      skillLoadOutcome: msg.skillLoadOutcome,
      skillMissingBins: msg.skillMissingBins,
      skillMissingEnv: msg.skillMissingEnv,
      skillLoadError: msg.skillLoadError,
      timestamp: msg.timestamp,
    },
  });
}

function persistTaskProgressTimeline(
  event: ProgressEvent,
  msg: Extract<WsOutgoingMessage, { type: 'task_progress' }>,
): SaveTimelineResult | null {
  if (!event.sessionId || !event.chatId) return null;
  return saveTimelineItem({
    tenantId: event.tenantId,
    sessionId: event.sessionId,
    chatId: event.chatId,
    turnId: msg.turnId,
    type: 'task_update',
    eventKey: `task:${msg.task_id}`,
    timestamp: msg.timestamp,
    preserveTimestampOnUpdate: true,
    // Merge instead of replace: this shares its eventKey with task_update
    // rows, and a late worker heartbeat replacing the payload wholesale
    // would erase a persisted step-result excerpt (and regress terminal
    // status fields it does not know about). Every field this frame owns is
    // still written each time; `detail` joins conditionally for the same
    // reason as in persistTaskUpdateTimeline.
    mergeDataOnUpdate: true,
    data: {
      id: `task_${msg.task_id}`,
      task_id: msg.task_id,
      parentTaskId: msg.parentTaskId,
      jobId: msg.jobId,
      turnId: msg.turnId,
      title: msg.title,
      status: msg.status,
      userStatus: msg.userStatus,
      ...(msg.detail ? { detail: msg.detail } : {}),
      rawStatus: msg.rawStatus,
      runtimeLabel: msg.runtimeLabel,
      adapterId: msg.adapterId,
      lane: msg.lane,
      sandboxProfile: msg.sandboxProfile,
      heartbeat: msg.heartbeat,
      elapsed_ms: msg.elapsed_ms,
      timestamp: msg.timestamp,
    },
  });
}

function persistTaskUpdateTimeline(
  event: ProgressEvent,
  msg: Extract<WsOutgoingMessage, { type: 'task_update' }>,
  timestamp: number,
): SaveTimelineResult | null {
  if (!event.sessionId || !event.chatId) return null;
  return saveTimelineItem({
    tenantId: event.tenantId,
    sessionId: event.sessionId,
    chatId: event.chatId,
    turnId: msg.turnId,
    type: 'task_update',
    eventKey: `task:${msg.task_id}`,
    timestamp,
    preserveTimestampOnUpdate: true,
    mergeDataOnUpdate: true,
    data: {
      id: `task_${msg.task_id}`,
      task_id: msg.task_id,
      parentTaskId: msg.parentTaskId,
      turnId: msg.turnId,
      title: msg.title,
      status: msg.status,
      rawStatus: msg.rawStatus,
      // Conditional spread: mergeDataOnUpdate spreads this object over the
      // stored payload, and an explicit `detail: undefined` key would erase
      // a previously persisted excerpt.
      ...(msg.detail ? { detail: msg.detail } : {}),
      progress: msg.progress,
      guard_reason: event.type === 'task_guarded' ? event.reason : undefined,
      error_preview: event.type === 'task_guarded' ? event.errorPreview : undefined,
      timestamp,
    },
  });
}

/**
 * Map event bus types to user-facing task statuses.
 */
function toTaskStatus(eventType: string): string | null {
  switch (eventType) {
    case 'task_started':
    case 'agent_spawned':
      return 'running';
    case 'task_completed':
    case 'agent_completed':
      return 'completed';
    case 'task_failed':
    case 'task_guarded':
    case 'agent_failed':
      return 'failed';
    case 'task_cancelled':
      return 'cancelled';
    case 'dag_created':
      return 'pending';
    default:
      return null;
  }
}

/**
 * Broadcast a turn's durable envelope to every client watching its session.
 *
 * The envelope carries the server-owned `startedAt` that clients order turns by.
 * Foreground turns reach this through their `turn_state` transitions; a detached
 * plan never enters the session control plane and reaches it through a
 * `turn_envelope_updated` event instead (Issue #714). The two paths stay
 * separate because `turn_state` also drives `workspace_session_state`, and a
 * background turn running concurrently with the foreground has no standing to
 * move the session's FSM.
 *
 * Persist the envelope transition before calling — a live frame that outran its
 * own durable row would disagree with a simultaneous REST restore.
 */
export function broadcastTurnEnvelope(params: {
  tenantId?: string;
  sessionId: string;
  turnId: string;
  chatId?: string;
}): void {
  const envelope = getTurnEnvelope(params.sessionId, params.turnId, params.tenantId ?? 'default');
  if (!envelope) return;
  const payload = JSON.stringify({ type: 'turn_envelope', turn: envelope });
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isSameChat(conn, params.chatId, params.tenantId, params.sessionId)) continue;
    try { conn.socket.send(payload); } catch { /* closed socket */ }
  }
}

/**
 * Broadcast a progress event to all authenticated WebSocket clients.
 * Emits:
 * - tool_event for tool_call/tool_result execution visibility
 * - task_update for DAG/task lifecycle visibility
 */
export function broadcastProgressEvent(event: ProgressEvent): void {
  if (event.type === 'session_activity_changed') {
    if (event.sessionId) {
      broadcastSessionActivityEvent({ tenantId: event.tenantId, sessionId: event.sessionId });
    }
    return;
  }
  if (event.type === 'turn_envelope_updated') {
    if (event.sessionId && event.turnId) {
      broadcastTurnEnvelope({
        tenantId: event.tenantId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        chatId: event.chatId,
      });
    }
    return;
  }
  if (event.type === 'context_compression' && event.sessionId && event.compressionStage) {
    const payload = JSON.stringify({
      type: 'context_compression',
      sessionId: event.sessionId,
      stage: event.compressionStage,
      sourceTokens: event.sourceTokens ?? 0,
      summaryTokens: event.summaryTokens,
      contextWindow: event.contextWindow ?? 0,
      timestamp: event.timestamp,
    });
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) continue;
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
      try { conn.socket.send(payload); } catch { /* closed socket */ }
    }
    return;
  }
  if (event.type === 'turn_state') {
    // Send the durable envelope itself on every lifecycle transition. This is
    // the real-time contract for locale/status; clients must not wait for a
    // refresh before using the server-owned presentation language.
    if (event.sessionId && event.turnId) {
      broadcastTurnEnvelope({
        tenantId: event.tenantId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        chatId: event.chatId,
      });
      broadcastSessionActivityEvent({ tenantId: event.tenantId, sessionId: event.sessionId });
    }
    const messages = buildTurnStateTaskProgressMessages(event);
    if (messages.length === 0) return;

    // Turn-lifecycle markers are ephemeral session-state, not durable work steps —
    // deliberately not persisted, so a reloaded turn shows only its real tool events
    // and answer, never a resurrected "planning/working" narrative.
    let sent = 0;
    for (const msg of messages) {
      const payload = JSON.stringify(msg);
      for (const [, conn] of connections) {
        if (!conn.client.authenticated) continue;
        if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
        if (!shouldReceiveExecutionEvent(conn)) continue;
        try {
          conn.socket.send(payload);
          sent++;
        } catch {
          // Socket may have closed — ignore
        }
      }
    }
    if (sent > 0) {
      logger.debug({ turnState: event.turnState, turnId: event.turnId, clients: sent }, 'Turn progress broadcast');
    }
    return;
  }

  if (event.type === 'worker_status') {
    const msg = buildWorkerTaskProgressMessage(event);
    if (!msg) return;
    msg.turnId = resolveActiveTurnId(msg.turnId, event.chatId, event.sessionId, event.tenantId);
    const saved = persistTaskProgressTimeline(event, msg);
    if (saved?.seq != null) msg.seq = saved.seq;
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) continue;
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
      if (!shouldReceiveExecutionEvent(conn)) continue;
      try {
        conn.socket.send(payload);
        sent++;
      } catch {
        // Socket may have closed — ignore
      }
    }
    if (sent > 0) {
      logger.debug({ workerStatus: event.workerStatus, jobId: event.jobId, clients: sent }, 'Task progress broadcast');
    }
    return;
  }

  if (event.type === 'approval_request') {
    const requestId = event.approvalRequestId;
    if (!requestId || !event.description) return;
    const resolvedTurnId = resolveActiveTurnId(event.turnId, event.chatId, event.sessionId, event.tenantId);
    const msg: Extract<WsOutgoingMessage, { type: 'approval_request' }> = {
      type: 'approval_request',
      id: requestId,
      description: event.description,
      action: event.approvalAction,
      sessionId: event.sessionId,
      turnId: resolvedTurnId,
      required_level: event.requiredLevel,
      current_level: event.currentLevel,
      denied_action: event.deniedAction,
      tool: event.approvalTool,
      tool_intent: event.toolIntent,
      originating_prompt: event.originatingPrompt,
      grant_scope: event.grantScope,
    };
    if (event.sessionId && event.chatId) {
      const saved = saveTimelineItem({
        tenantId: event.tenantId,
        sessionId: event.sessionId,
        chatId: event.chatId,
        turnId: resolvedTurnId,
        type: 'approval_request',
        eventKey: `approval:${requestId}`,
        timestamp: event.timestamp,
        data: {
          id: requestId,
          description: event.description,
          action: event.approvalAction,
          status: 'pending',
          timestamp: event.timestamp,
          required_level: event.requiredLevel,
          current_level: event.currentLevel,
          denied_action: event.deniedAction,
          tool: event.approvalTool,
          tool_intent: event.toolIntent,
          originating_prompt: event.originatingPrompt,
        },
      });
      if (saved.seq != null) msg.seq = saved.seq;
    }
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) continue;
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
      try {
        conn.socket.send(payload);
        sent++;
      } catch {
        // Socket may have closed — ignore
      }
    }
    if (sent > 0) {
      logger.debug({ requestId, action: event.approvalAction, clients: sent }, 'Approval request broadcast');
    }
    return;
  }

  if (event.type === 'approval_resolved') {
    const requestId = event.approvalRequestId;
    const status = event.approvalStatus;
    if (!requestId || !status) return;
    const resolvedTurnId = resolveActiveTurnId(event.turnId, event.chatId, event.sessionId, event.tenantId);
    const msg: Extract<WsOutgoingMessage, { type: 'approval_resolved' }> = {
      type: 'approval_resolved',
      id: requestId,
      status,
      action: event.approvalAction,
      description: event.description,
      sessionId: event.sessionId,
      turnId: resolvedTurnId,
      permission_level: event.permissionLevel,
      required_level: event.requiredLevel,
      current_level: event.currentLevel,
      denied_action: event.deniedAction,
      tool: event.approvalTool,
      tool_intent: event.toolIntent,
      originating_prompt: event.originatingPrompt,
    };
    const savedResolved = persistApprovalResolvedTimeline(msg, event.tenantId, event.chatId, event.timestamp, resolvedTurnId);
    if (savedResolved?.seq != null) msg.seq = savedResolved.seq;
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) continue;
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
      try {
        conn.socket.send(payload);
        sent++;
      } catch {
        // Socket may have closed — ignore
      }
    }
    if (sent > 0) {
      logger.debug({ requestId, status, action: event.approvalAction, clients: sent }, 'Approval resolution broadcast');
    }
    return;
  }

  if (event.type === 'plan_started') {
    const planId = event.taskId;
    const goal = event.taskTitle;
    const phases = event.planPhases ?? [];
    if (!planId || !goal || phases.length === 0) return;
    const msg: Extract<WsOutgoingMessage, { type: 'plan_started' }> = {
      type: 'plan_started',
      plan_id: planId,
      goal,
      phases,
      locale: event.locale,
      turnId: resolveActiveTurnId(event.turnId, event.chatId, event.sessionId, event.tenantId),
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
    if (event.sessionId && event.chatId) {
      const saved = saveTimelineItem({
        tenantId: event.tenantId,
        sessionId: event.sessionId,
        chatId: event.chatId,
        turnId: msg.turnId,
        type: 'plan_started',
        eventKey: `plan:${planId}`,
        timestamp: event.timestamp,
        data: {
          plan_id: planId,
          goal,
          phases,
          locale: event.locale,
          // Duplicated into data like tool_event/task_update payloads: the UI
          // execution grouper reads turn identity from the data object, so a
          // restored row must carry it exactly like a live frame does.
          turnId: msg.turnId,
          timestamp: event.timestamp,
        },
      });
      if (saved.seq != null) msg.seq = saved.seq;
    }
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) continue;
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
      if (!shouldReceiveExecutionEvent(conn)) continue;
      try {
        conn.socket.send(payload);
        sent++;
      } catch {
        // Socket may have closed — ignore
      }
    }
    if (sent > 0) {
      logger.debug({ planId, phases: phases.length, clients: sent }, 'Plan started broadcast');
    }
    return;
  }

  if (event.type === 'tool_composing') {
    // Ephemeral presence while the model streams a tool call's arguments
    // (e.g. composing a whole document into file_write). Broadcast only —
    // deliberately never persisted to the session timeline.
    const msg: Extract<WsOutgoingMessage, { type: 'tool_composing' }> = {
      type: 'tool_composing',
      phase: event.composingPhase === 'end' ? 'end' : 'start',
      tool: event.toolName ?? 'unknown',
      callId: event.toolCallId,
      turnId: resolveActiveTurnId(event.turnId, event.chatId, event.sessionId, event.tenantId),
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
    const payload = JSON.stringify(msg);
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) continue;
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
      if (!shouldReceiveExecutionEvent(conn)) continue;
      try {
        conn.socket.send(payload);
      } catch {
        // Socket may have closed — ignore
      }
    }
    return;
  }

  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const msg: Extract<WsOutgoingMessage, { type: 'tool_event' }> = event.type === 'tool_call'
      ? {
          type: 'tool_event',
          phase: 'start',
          tool: event.toolName ?? 'unknown',
          callId: event.toolCallId,
          agentId: event.agentId,
          intent: event.intent,
          taskId: event.taskId,
          turnId: event.turnId,
          skillName: event.skillName,
          skillDescription: event.skillDescription,
          skillLoadOutcome: event.skillLoadOutcome,
          skillMissingBins: event.skillMissingBins,
          skillMissingEnv: event.skillMissingEnv,
          skillLoadError: event.skillLoadError,
          status: 'running',
          timestamp: event.timestamp,
          sessionId: event.sessionId,
        }
      : {
          type: 'tool_event',
          phase: 'end',
          tool: event.toolName ?? 'unknown',
          callId: event.toolCallId,
          agentId: event.agentId,
          intent: event.intent,
          result: event.result,
          sources: event.sources,
          elapsed_ms: event.elapsed_ms,
          taskId: event.taskId,
          turnId: event.turnId,
          skillName: event.skillName,
          skillDescription: event.skillDescription,
          skillLoadOutcome: event.skillLoadOutcome,
          skillMissingBins: event.skillMissingBins,
          skillMissingEnv: event.skillMissingEnv,
          skillLoadError: event.skillLoadError,
          status: event.error ? 'error' : 'success',
          error: event.error,
          timestamp: event.timestamp,
          sessionId: event.sessionId,
        };
    msg.turnId = resolveActiveTurnId(msg.turnId, event.chatId, event.sessionId, event.tenantId);
    const savedTool = persistToolEventTimeline(event, msg);
    if (savedTool?.seq != null) msg.seq = savedTool.seq;
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const [, conn] of connections) {
      if (!conn.client.authenticated) {
        logger.debug({ clientId: conn.client.id }, 'Skipped tool_event: not authenticated');
        continue;
      }
      if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) {
        logger.debug({ clientId: conn.client.id, eventChat: event.chatId, connUser: conn.client.userId }, 'Skipped tool_event: chatId mismatch');
        continue;
      }
      if (!shouldReceiveExecutionEvent(conn)) {
        logger.debug({ clientId: conn.client.id, capabilities: conn.client.capabilities }, 'Skipped tool_event: missing execution_v1 capability');
        continue;
      }
      try {
        conn.socket.send(payload);
        sent++;
      } catch {
        // Socket may have closed — ignore
      }
    }
    if (sent > 0) {
      logger.debug({ type: event.type, toolName: event.toolName, clients: sent }, 'Execution event broadcast');
    }
    return;
  }

  // Skip internal non-user-facing events
  if (INTERNAL_EVENT_TYPES.has(event.type)) return;

  const status = toTaskStatus(event.type);
  if (!status) return;

  const title = event.taskTitle || event.summary || '';
  // Skip events with no meaningful title
  if (!title) return;

  const msg: Extract<WsOutgoingMessage, { type: 'task_update' }> = {
    type: 'task_update',
    task_id: event.taskId ?? '',
    status,
    // Preserve the truthful source lifecycle (Issue #624): the 4-state `status`
    // collapses cancelled → failed, so carry the raw event type for the nested
    // renderer to distinguish a user-cancelled task from a real failure.
    rawStatus: event.type,
    parentTaskId: event.parentTaskId,
    title,
    // Completed steps carry their result excerpt so the plan card can
    // disclose it per row. Failure details keep the existing policy
    // (Technical details only) — only the completion excerpt passes.
    detail: event.type === 'task_completed' ? event.detail : undefined,
    turnId: resolveActiveTurnId(event.turnId, event.chatId, event.sessionId, event.tenantId),
    progress: event.completedTasks != null && event.totalTasks
      ? Math.round((event.completedTasks / event.totalTasks) * 100)
      : undefined,
  };
  const savedTask = persistTaskUpdateTimeline(event, msg, event.timestamp);
  if (savedTask?.seq != null) msg.seq = savedTask.seq;
  const payload = JSON.stringify(msg);
  // The step-result excerpt is execution CONTENT, not a status string —
  // clients without the execution_v1 capability are deliberately excluded
  // from tool results (see the tool_event gate) and must not receive it
  // through this side door. They still get the bare status update.
  const payloadWithoutDetail = msg.detail ? JSON.stringify({ ...msg, detail: undefined }) : payload;
  let sent = 0;

  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
    try {
      conn.socket.send(shouldReceiveExecutionEvent(conn) ? payload : payloadWithoutDetail);
      sent++;
    } catch {
      // Socket may have closed — ignore
    }
  }

  if (sent > 0) {
    logger.debug({ type: event.type, status, chatId: event.chatId, clients: sent }, 'Progress event broadcast');
  }
}

/**
 * Broadcast a message to authenticated WebSocket clients for one owner.
 */
export function broadcastToClients(
  _app: FastifyInstance,
  type: WsOutgoingMessage['type'],
  content?: string,
  data?: unknown,
  target?: { userId: string; tenantId: string },
): void {
  const payload = JSON.stringify(
    type === 'message'
      ? { type, role: 'system' as const, content: content ?? '' }
      : type === 'error'
        ? { type, message: content ?? '' }
        : { type, content, data },
  );
  let sent = 0;
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, target?.userId, target?.tenantId)) continue;
    try {
      conn.socket.send(payload);
      sent++;
    } catch {
      // Socket may have closed — ignore
    }
  }
  logger.info({ type, targetUserId: target?.userId, targetTenantId: target?.tenantId, clientCount: sent }, 'Broadcasting to WebSocket clients');
}

export function broadcastTurnQueuedEvent(input: {
  targetUserId: string;
  tenantId?: string;
  sessionId?: string;
  queueDepth: number;
  reason: 'session_busy' | 'user_concurrency_limit';
}): void {
  const tenantId = input.tenantId ?? 'default';
  const msg: WsOutgoingMessage = {
    type: 'turn_queue',
    status: 'queued',
    queueDepth: input.queueDepth,
    reason: input.reason,
    timestamp: Date.now(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  const payload = JSON.stringify(msg);
  let sent = 0;
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, input.targetUserId, tenantId)) continue;
    if (!acceptsSession(conn, input.sessionId)) continue;
    try {
      conn.socket.send(payload);
      sent++;
    } catch {
      // Socket may have closed — ignore
    }
  }
  if (sent > 0) {
    logger.debug({
      targetUserId: input.targetUserId,
      sessionId: input.sessionId,
      queueDepth: input.queueDepth,
      reason: input.reason,
      clients: sent,
    }, 'Turn queue status broadcast');
  }
}

export function broadcastTurnTimeoutEvent(input: {
  targetUserId: string;
  tenantId?: string;
  sessionId?: string;
  message: string;
}): void {
  const tenantId = input.tenantId ?? 'default';
  const msg: WsOutgoingMessage = {
    type: 'error',
    message: input.message,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  const payload = JSON.stringify(msg);
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, input.targetUserId, tenantId)) continue;
    if (!acceptsSession(conn, input.sessionId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — ignore
    }
  }
}

/**
 * Coalesce window for streaming chunks. A fast model emits tokens far quicker
 * than the eye can follow, and every raw chunk previously triggered a full-text
 * WS broadcast AND a synchronous SQLite timeline write — O(n²) work per turn.
 * Delivering the latest accumulated text at most once per window keeps rendering
 * smooth while cutting broadcasts/DB writes by ~an order of magnitude. Correctness
 * is preserved because each chunk already carries the full accumulated text, so
 * dropping an intermediate frame only skips a render, never loses content.
 */
const STREAM_COALESCE_MS = 50;

interface PendingStreamFlush {
  timer: ReturnType<typeof setTimeout>;
  /** Newest chunk arrived during the cooldown window, or null if none pending. */
  latest: { content: string; targetUserId?: string; sessionId?: string; tenantId: string } | null;
}

const pendingStreamFlushes = new Map<string, PendingStreamFlush>();

function clearPendingStreamFlush(requestId: string): void {
  const pending = pendingStreamFlushes.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingStreamFlushes.delete(requestId);
  }
}

/**
 * Public entry point. Throttles `stream_chunk` (leading + trailing edge); passes
 * `stream_start`/`stream_end` through immediately and flushes any pending chunk so
 * a stale intermediate frame never lands after the final text.
 */
export function broadcastStreamEvent(
  type: 'stream_start' | 'stream_chunk' | 'stream_end',
  requestId: string,
  content?: string,
  targetUserId?: string,
  sessionId?: string,
  tenantId = 'default',
): void {
  if (type !== 'stream_chunk') {
    // A start/end supersedes any buffered chunk for this request.
    clearPendingStreamFlush(requestId);
    deliverStreamEvent(type, requestId, content, targetUserId, sessionId, tenantId);
    return;
  }

  const pending = pendingStreamFlushes.get(requestId);
  if (!pending) {
    // Leading edge: deliver now, then open a cooldown window for trailing chunks.
    deliverStreamEvent(type, requestId, content, targetUserId, sessionId, tenantId);
    const entry: PendingStreamFlush = {
      latest: null,
      timer: setTimeout(function flushTrailing() {
        const current = pendingStreamFlushes.get(requestId);
        if (!current) return;
        if (current.latest) {
          const { content: c, targetUserId: u, sessionId: s, tenantId: t } = current.latest;
          current.latest = null;
          deliverStreamEvent('stream_chunk', requestId, c, u, s, t);
          // Keep throttling while chunks keep arriving.
          current.timer = setTimeout(flushTrailing, STREAM_COALESCE_MS);
        } else {
          // Window elapsed with nothing new — next chunk becomes a fresh leading edge.
          pendingStreamFlushes.delete(requestId);
        }
      }, STREAM_COALESCE_MS),
    };
    pendingStreamFlushes.set(requestId, entry);
    return;
  }

  // Within cooldown: keep only the newest accumulated text.
  pending.latest = { content: content ?? '', targetUserId, sessionId, tenantId };
}

/**
 * Actually persist + broadcast a single streaming event to all authenticated
 * WebSocket clients. Not throttled — callers go through broadcastStreamEvent.
 */
function deliverStreamEvent(
  type: 'stream_start' | 'stream_chunk' | 'stream_end',
  requestId: string,
  content?: string,
  targetUserId?: string,
  sessionId?: string,
  tenantId = 'default',
): void {
  const turnId = resolveActiveTurnId(undefined, targetUserId, sessionId, tenantId);
  const msg: Extract<WsOutgoingMessage, { type: 'stream_start' | 'stream_chunk' | 'stream_end' }> = type === 'stream_start'
    ? { type, requestId, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) }
    : { type: type as 'stream_chunk' | 'stream_end', requestId, content: content ?? '', ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) };
  if (sessionId && targetUserId) {
    const timestamp = Date.now();
    const eventKey = `stream:${requestId}`;
    if (type === 'stream_end' && (content ?? '').trim().length === 0) {
      deleteTimelineItem(sessionId, eventKey, tenantId);
    } else {
      const saved = saveTimelineItem({
        tenantId,
        sessionId,
        chatId: targetUserId,
        turnId,
        type: 'message',
        eventKey,
        timestamp,
        preserveTimestampOnUpdate: true,
        data: {
          id: requestId,
          role: 'assistant',
          content: content ?? '',
          timestamp,
          streaming: type !== 'stream_end',
          requestId,
          ...(turnId ? { turnId } : {}),
        },
      });
      if (saved.seq != null) msg.seq = saved.seq;
    }
  }
  const payload = JSON.stringify(msg);

  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, targetUserId, tenantId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — ignore
    }
  }
}

function artifactTimelinePersistKey(tenantId: string, sessionId: string, artifactId: string): string {
  return `${tenantId}:${sessionId}:${artifactId}`;
}

function isTerminalArtifactPatch(patch: ArtifactPatch): boolean {
  return patch.status === 'completed' || patch.status === 'failed' || patch.status === 'closed';
}

function mergeArtifactPatches(previous: ArtifactPatch | undefined, next: ArtifactPatch): ArtifactPatch {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    data: {
      ...(previous.data ?? {}),
      ...(next.data ?? {}),
    },
  };
}

function artifactTimelinePatchForPersistence(
  tenantId: string,
  sessionId: string,
  artifactId: string,
  patch: ArtifactPatch,
  timestamp: number,
): ArtifactPatch | null {
  const persistKey = artifactTimelinePersistKey(tenantId, sessionId, artifactId);
  if (isTerminalArtifactPatch(patch)) {
    const merged = mergeArtifactPatches(artifactTimelinePendingPatches.get(persistKey), patch);
    artifactTimelinePendingPatches.delete(persistKey);
    artifactTimelinePersistedAt.delete(persistKey);
    return merged;
  }

  const lastPersistedAt = artifactTimelinePersistedAt.get(persistKey);
  if (lastPersistedAt !== undefined && timestamp - lastPersistedAt < ARTIFACT_TIMELINE_PERSIST_THROTTLE_MS) {
    artifactTimelinePendingPatches.set(
      persistKey,
      mergeArtifactPatches(artifactTimelinePendingPatches.get(persistKey), patch),
    );
    return null;
  }
  const merged = mergeArtifactPatches(artifactTimelinePendingPatches.get(persistKey), patch);
  artifactTimelinePendingPatches.delete(persistKey);
  artifactTimelinePersistedAt.set(persistKey, timestamp);
  return merged;
}

function clearArtifactFlushTimer(persistKey: string): void {
  const timer = artifactTimelinePendingFlushTimers.get(persistKey);
  if (timer) {
    clearTimeout(timer);
    artifactTimelinePendingFlushTimers.delete(persistKey);
  }
}

/**
 * Arm (or re-arm) the trailing-edge timer for a throttled artifact patch. After
 * the throttle window the accumulated pending patch is written to the timeline
 * so the last running frame is never lost when the stream goes quiet.
 */
function scheduleArtifactTrailingFlush(
  persistKey: string,
  tenantId: string,
  sessionId: string,
  chatId: string,
  artifactId: string,
  turnId?: string,
): void {
  clearArtifactFlushTimer(persistKey);
  const timer = setTimeout(() => {
    artifactTimelinePendingFlushTimers.delete(persistKey);
    const pending = artifactTimelinePendingPatches.get(persistKey);
    if (!pending) return;
    artifactTimelinePendingPatches.delete(persistKey);
    artifactTimelinePersistedAt.set(persistKey, Date.now());
    try {
      patchTimelineArtifactData({
        tenantId,
        sessionId,
        chatId,
        artifactId,
        patch: pending as Record<string, unknown>,
        timestamp: Date.now(),
        turnId,
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), artifactId },
        'Failed trailing-edge artifact patch persist',
      );
    }
  }, ARTIFACT_TIMELINE_PERSIST_THROTTLE_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  artifactTimelinePendingFlushTimers.set(persistKey, timer);
}

/**
 * Flush any pending throttled patches for a session, then drop all throttle
 * state (timestamps, pending patches, timers) whose key belongs to it. Called
 * when the last connection for a session disconnects so artifacts that never
 * terminalized do not leak their module-global entries.
 */
function flushAndSweepArtifactTimelineState(tenantId: string, sessionId: string, chatId: string): void {
  const prefix = `${tenantId}:${sessionId}:`;
  for (const [key, pending] of artifactTimelinePendingPatches) {
    if (!key.startsWith(prefix)) continue;
    const artifactId = key.slice(prefix.length);
    try {
      patchTimelineArtifactData({
        tenantId,
        sessionId,
        chatId,
        artifactId,
        patch: pending as Record<string, unknown>,
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), artifactId },
        'Failed to flush pending artifact patch on session close',
      );
    }
    artifactTimelinePendingPatches.delete(key);
  }
  for (const key of [...artifactTimelinePersistedAt.keys()]) {
    if (key.startsWith(prefix)) artifactTimelinePersistedAt.delete(key);
  }
  for (const [key, timer] of artifactTimelinePendingFlushTimers) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(timer);
    artifactTimelinePendingFlushTimers.delete(key);
  }
}

export function broadcastArtifactEvent(
  event: { type: 'open'; artifact: ArtifactEnvelope } | { type: 'patch'; artifactId: string; patch: ArtifactPatch } | { type: 'close'; artifactId: string },
  targetUserId?: string,
  sessionId?: string,
  tenantId = 'default',
  explicitTurnId?: string,
): void {
  const turnId = resolveActiveTurnId(explicitTurnId, targetUserId, sessionId, tenantId);
  const msg: Extract<WsOutgoingMessage, { type: 'artifact_open' | 'artifact_patch' | 'artifact_close' }> = event.type === 'open'
    ? { type: 'artifact_open', artifact: event.artifact, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) }
    : event.type === 'patch'
      ? { type: 'artifact_patch', artifactId: event.artifactId, patch: event.patch, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) }
      : { type: 'artifact_close', artifactId: event.artifactId, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) };
  if (sessionId && targetUserId) {
    const timestamp = Date.now();
    if (event.type === 'open') {
      const persistKey = artifactTimelinePersistKey(tenantId, sessionId, event.artifact.id);
      artifactTimelinePendingPatches.delete(persistKey);
      const saved = saveTimelineItem({
        tenantId,
        sessionId,
        chatId: targetUserId,
        turnId,
        type: 'artifact',
        eventKey: `artifact:${event.artifact.id}`,
        timestamp,
        preserveTimestampOnUpdate: true,
        data: {
          id: event.artifact.id,
          plugin_id: event.artifact.plugin_id,
          title: event.artifact.title,
          status: event.artifact.status,
          fallback_text: event.artifact.fallback_text,
          data: event.artifact.data,
          timestamp,
        },
      });
      if (saved.seq != null) msg.seq = saved.seq;
      artifactTimelinePersistedAt.set(persistKey, timestamp);
    } else if (event.type === 'patch') {
      const persistKey = artifactTimelinePersistKey(tenantId, sessionId, event.artifactId);
      const patch = artifactTimelinePatchForPersistence(tenantId, sessionId, event.artifactId, event.patch, timestamp);
      if (patch) {
        // Persisted now (leading edge, throttle boundary, or terminal) — the
        // pending buffer was consumed, so any armed trailing timer is stale.
        clearArtifactFlushTimer(persistKey);
        patchTimelineArtifactData({
          tenantId,
          sessionId,
          chatId: targetUserId,
          artifactId: event.artifactId,
          patch: patch as Record<string, unknown>,
          timestamp,
          turnId,
        });
      } else {
        // Throttled and stashed — arm the trailing-edge flush so this frame
        // still reaches the timeline if no further patch arrives.
        scheduleArtifactTrailingFlush(persistKey, tenantId, sessionId, targetUserId, event.artifactId, turnId);
      }
    } else {
      const persistKey = artifactTimelinePersistKey(tenantId, sessionId, event.artifactId);
      clearArtifactFlushTimer(persistKey);
      // Flush any still-pending throttled patch before dropping throttle state,
      // so a close never silently discards the last running frame.
      const pending = artifactTimelinePendingPatches.get(persistKey);
      if (pending) {
        try {
          patchTimelineArtifactData({
            tenantId,
            sessionId,
            chatId: targetUserId,
            artifactId: event.artifactId,
            patch: pending as Record<string, unknown>,
            timestamp,
            turnId,
          });
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), artifactId: event.artifactId },
            'Failed to flush pending artifact patch on close',
          );
        }
      }
      artifactTimelinePendingPatches.delete(persistKey);
      artifactTimelinePersistedAt.delete(persistKey);
    }
  }
  const payload = JSON.stringify(msg);

  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, targetUserId, tenantId)) continue;
    if (!conn.client.capabilities.includes('artifact_v1')) continue;
    // Session-scoped fan-out: a connection pinned to a different session must not
    // receive another session's artifacts. Deliver when the connection's session
    // is unknown (backward compatible) or matches the event.
    if (!acceptsSession(conn, sessionId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — ignore
    }
  }
}

/**
 * Broadcast a session title update to all authenticated WebSocket clients.
 */
export function broadcastSessionUpdate(sessionId: string, title: string): void {
  const payload = JSON.stringify({ type: 'session_update', sessionId, title });
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isSessionOwnerConn(conn, sessionId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — ignore
    }
  }
}

/** Persist and broadcast the committed memory mutations for one completed turn. */
export function broadcastMemoryUpdate(input: {
  targetUserId: string;
  tenantId?: string;
  chatId: string;
  sessionId: string;
  turnId: string;
  updates: Array<{ factId: number; action: 'ADD' | 'REINFORCE' | 'UPDATE' }>;
}): void {
  if (input.updates.length === 0) return;
  const tenantId = input.tenantId ?? 'default';
  const timestamp = Date.now();
  const added = input.updates.filter(update => update.action === 'ADD').length;
  const reinforced = input.updates.filter(update => update.action === 'REINFORCE').length;
  const updated = input.updates.filter(update => update.action === 'UPDATE').length;
  const factIds = [...new Set(input.updates.map(update => update.factId))];
  const data = {
    count: input.updates.length,
    added,
    reinforced,
    updated,
    factIds,
    timestamp,
    turnId: input.turnId,
  };
  const saved = saveTimelineItem({
    tenantId,
    sessionId: input.sessionId,
    chatId: input.chatId,
    turnId: input.turnId,
    type: 'memory_update',
    eventKey: `memory:${input.turnId}`,
    timestamp,
    data,
  });
  const msg: Extract<WsOutgoingMessage, { type: 'memory_update' }> = {
    type: 'memory_update',
    ...data,
    sessionId: input.sessionId,
    ...(saved.seq != null ? { seq: saved.seq } : {}),
  };
  const payload = JSON.stringify(msg);
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isOwnerConn(conn, input.targetUserId, tenantId)) continue;
    if (!acceptsSession(conn, input.sessionId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — the durable timeline row remains authoritative.
    }
  }
}

/**
 * Send a plain text message to all WebSocket connections belonging to a specific user.
 */
/**
 * Deliver an assistant message OUTSIDE an interactive turn (e.g. a detached
 * plan run finishing). Persists to conversations + session timeline first —
 * the DB is the source of truth — then broadcasts to any connected clients
 * viewing that session. Safe to call with nobody connected: the message is
 * durable and appears on next session load.
 */
/**
 * Persist + broadcast ONE task_update row under a caller-owned background
 * turn. The plan runner uses this to surface a plan-LEVEL failure reason
 * (e.g. a semantic-verification finding) as a timeline row: without it, a
 * plan whose steps all succeeded but whose envelope was stamped failed shows
 * "Needs attention" with an all-green card and nothing to point at
 * (operator report 2026-07-18). The caller owns the turn envelope; this
 * never creates or terminalizes one.
 */
export function deliverBackgroundTaskUpdate(input: {
  tenantId: string;
  chatId: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  title: string;
  status: 'failed' | 'completed';
  rawStatus?: string;
  detail?: string;
}): void {
  const timestamp = Date.now();
  const msg: Extract<WsOutgoingMessage, { type: 'task_update' }> = {
    type: 'task_update',
    task_id: input.taskId,
    status: input.status,
    rawStatus: input.rawStatus,
    title: input.title,
    detail: input.detail,
    turnId: input.turnId,
  };
  const saved = saveTimelineItem({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    chatId: input.chatId,
    turnId: input.turnId,
    type: 'task_update',
    eventKey: `task:${input.taskId}`,
    timestamp,
    preserveTimestampOnUpdate: true,
    mergeDataOnUpdate: true,
    data: {
      id: `task_${input.taskId}`,
      task_id: input.taskId,
      turnId: input.turnId,
      title: input.title,
      status: input.status,
      rawStatus: input.rawStatus,
      detail: input.detail,
      timestamp,
    },
  });
  if (saved?.seq != null) msg.seq = saved.seq;
  const payload = JSON.stringify(msg);
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isSameChat(conn, input.chatId, input.tenantId, input.sessionId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — ignore
    }
  }
}

export function deliverAssistantMessage(input: {
  tenantId: string;
  chatId: string;
  sessionId?: string;
  content: string;
  /** Turn origin for the delivery's own envelope (Issue #626). Default background. */
  origin?: TurnOrigin;
  /**
   * Explicit background/scheduled turn id to deliver under. When the caller owns
   * the turn envelope (e.g. the plan runner started + terminalized it), pass it
   * here. Omitted => this delivery is its own self-contained background turn.
   */
  turnId?: string;
}): { delivered: number } {
  const timestamp = Date.now();
  // Out-of-turn delivery must NEVER adopt the foreground active turn (Issue #626):
  // a background/scheduled completion that backfilled `getActiveTurnForChat`
  // attached itself to whatever unrelated foreground turn happened to be running.
  // It instead carries its own origin='background' turn identity.
  const origin = input.origin ?? 'background';
  const callerManagesTurn = Boolean(input.turnId?.trim());
  const turnId = input.sessionId
    ? (input.turnId?.trim() || `turn_bg_${timestamp}_${randomUUID()}`)
    : undefined;
  let seq: number | null = null;
  try {
    if (input.sessionId && turnId) {
      // Ensure the delivery's turn envelope exists. Idempotent: when the plan
      // runner already recorded (and terminalized) it, this keeps that record;
      // a self-contained delivery is born-and-done, so terminalize it here.
      startTurnEnvelope({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        chatId: input.chatId,
        turnId,
        origin,
        // A background/proactive delivery has no user prompt; its presentation
        // language is the language it was written in (Issue #628). Idempotent
        // COALESCE keeps a locale the plan runner may have recorded first.
        locale: inferTurnLocale(input.content),
        startedAt: timestamp,
      });
      const conversationId = saveMessageAndTouchSession(input.chatId, 'assistant', input.content, input.sessionId, input.tenantId);
      const saved = saveTimelineItem({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        chatId: input.chatId,
        turnId,
        conversationId,
        type: 'message',
        eventKey: `message:assistant:${timestamp}`,
        timestamp,
        data: {
          id: `msg_${timestamp}_assistant`,
          role: 'assistant',
          content: input.content,
          timestamp,
          ...(turnId ? { turnId } : {}),
        },
      });
      seq = saved.seq;
      // Only claim completion after the durable message exists. A crash between
      // envelope start and persistence must restore as interrupted, never as a
      // fake completed background turn with no result.
      if (!callerManagesTurn) {
        setTurnEnvelopeStatus({ tenantId: input.tenantId, sessionId: input.sessionId, turnId, status: 'completed' });
      }
      // Announce once every durable write above has landed (Issue #714). Two
      // distinct rows reach live clients only through here: the locale this
      // function COALESCE-backfills — the plan runner announced before writing
      // it, so live and reload would otherwise disagree on the turn's
      // presentation language — and, when the caller manages no turn of its own,
      // the whole self-minted `turn_bg_*` envelope, whose id carries no epoch to
      // sort by either.
      broadcastTurnEnvelope({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        turnId,
        chatId: input.chatId,
      });
    } else {
      saveMessage(input.chatId, 'assistant', input.content, undefined, 0, undefined, input.tenantId);
    }
  } catch (err) {
    logger.error({
      chatId: input.chatId,
      sessionId: input.sessionId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to persist out-of-turn assistant message');
  }

  const payload = JSON.stringify({
    type: 'message',
    role: 'assistant' as const,
    content: input.content,
    sessionId: input.sessionId,
    ...(turnId ? { turnId } : {}),
    ...(seq != null ? { seq } : {}),
  });
  let delivered = 0;
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    if (!isSameChat(conn, input.chatId, input.tenantId, input.sessionId)) continue;
    try {
      conn.socket.send(payload);
      delivered++;
    } catch {
      // Socket may have closed — ignore
    }
  }
  return { delivered };
}

export function sendToUser(userId: string, text: string): boolean {
  const payload = JSON.stringify({ type: 'message', role: 'system' as const, content: text });
  let delivered = false;
  for (const [, conn] of connections) {
    if (!conn.client.authenticated) continue;
    // Web chat ids are `${ownerUserId}:${sessionId}` while the authenticated
    // socket stores only ownerUserId. Accept either form for legacy proactive
    // callers; scheduled delivery itself uses the durable session path above.
    if (conn.client.userId !== userId && !userId.startsWith(`${conn.client.userId}:`)) continue;
    try {
      conn.socket.send(payload);
      delivered = true;
    } catch {
      // Socket may have closed — ignore
    }
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// Workspace data broadcasting
// ---------------------------------------------------------------------------

/** Send a full workspace snapshot to a single socket */
function sendWorkspaceSnapshot(socket: WebSocket, client: WsClient): void {
  try {
    const config = getConfig();
    const usage = tokenBudget.getAllUsage();
    const total = tokenBudget.getWindowSize();
    const used = tokenBudget.getTotalUsage();
    const watermark = tokenBudget.getWatermark();

    // Map watermark levels
    const wmMap: Record<string, string> = { normal: 'normal', soft: 'soft', hard: 'hard', rotate: 'critical' };

    // Get provider info from config
    const brainProvider = config.model_router?.brain_provider ?? '';
    const brainModel = config.brain.model;
    const health = providerHealth.getHealth(brainProvider);

    const snapshot = {
      type: 'workspace_state',
      state: {
        sessionState: 'IDLE',
        tenantId: client.tenantId || 'default',
        model: brainModel,
        providers: [{
          name: brainProvider,
          model: brainModel,
          status: health.status,
          latency: Math.round(health.avgLatencyMs ?? 0),
        }],
        tokenBudget: {
          total,
          used,
          zones: {
            system: usage.system,
            memory: usage.memory,
            tasks: usage.tasks,
            dialogue: usage.dialogue,
          },
          watermark: wmMap[watermark] ?? 'normal',
        },
        dag: [],
        subAgents: [],
        tools: [],
        alerts: getRecentAlerts(),
        runningSummary: '',
      },
    };
    socket.send(JSON.stringify(snapshot));
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send workspace snapshot');
  }
}

/** Get recent alerts for workspace panel */
function getRecentAlerts(): Array<{ id: string; severity: string; message: string; timestamp: string; action?: string }> {
  try {
    const alerts = getAlertHistory({ limit: 20 });
    // Map backend severity ('warning'/'critical') to UI severity ('warn'/'error')
    const severityMap: Record<string, string> = { info: 'info', warning: 'warn', critical: 'error' };
    return alerts.map(a => ({
      id: a.id,
      severity: severityMap[a.severity] ?? a.severity,
      message: a.message,
      timestamp: a.created_at,
      action: a.actions?.[0],
    }));
  } catch {
    return [];
  }
}

/**
 * Broadcast a workspace event to subscribed WebSocket clients.
 * Unlike broadcastProgressEvent, this forwards internal events
 * (tool_call, agent_spawned, etc.) to the workspace panel.
 */
export function broadcastWorkspaceEvent(event: ProgressEvent): void {
  let payload: string | null = null;

  switch (event.type) {
    case 'tool_call':
      payload = JSON.stringify({
        type: 'workspace_tools',
        tools: [{
          id: `tool-${event.timestamp}`,
          tool: event.toolName ?? 'unknown',
          intent: event.summary ?? '',
          status: 'executing',
          sla: 30000,
          elapsed: 0,
          retries: 0,
          layer: 'L4',
          capability: event.toolName,
        }],
      });
      break;

    case 'tool_result':
      // Tool completed — send updated status
      payload = JSON.stringify({
        type: 'workspace_tools',
        tools: [{
          id: `tool-${event.timestamp}`,
          tool: event.toolName ?? 'unknown',
          intent: event.summary ?? '',
          status: event.error ? 'error' : 'success',
          sla: 30000,
          elapsed: event.elapsed_ms ?? 0,
          retries: 0,
          layer: 'L4',
          capability: event.toolName,
        }],
      });
      break;

    case 'agent_spawned':
      payload = JSON.stringify({
        type: 'workspace_agents',
        agents: [{
          id: event.agentId ?? `agent-${event.timestamp}`,
          name: event.agentRole ?? 'SubAgent',
          pid: 0,
          status: 'spawning',
          brief: event.summary ?? event.taskTitle ?? '',
          heartbeat: 0,
          uptime: '0s',
        }],
      });
      break;

    case 'agent_completed':
      payload = JSON.stringify({
        type: 'workspace_agents',
        agents: [{
          id: event.agentId ?? `agent-${event.timestamp}`,
          name: event.agentRole ?? 'SubAgent',
          pid: 0,
          status: 'completed',
          brief: event.summary ?? '',
          heartbeat: 0,
          uptime: event.elapsed_ms ? `${Math.round(event.elapsed_ms / 1000)}s` : '0s',
          result: event.summary,
        }],
      });
      break;

    case 'budget_warning':
      payload = JSON.stringify({
        type: 'workspace_session_state',
        sessionState: event.level === 'rotate' ? 'ERROR' : 'WORKING',
      });
      break;

    case 'task_started':
      payload = JSON.stringify({
        type: 'workspace_session_state',
        sessionState: 'WORKING',
      });
      break;

    case 'task_completed':
    case 'task_failed':
    case 'task_cancelled':
      payload = JSON.stringify({
        type: 'workspace_session_state',
        sessionState: 'IDLE',
      });
      break;

    case 'turn_state': {
      const phase = event.turnState ?? 'EXECUTING';
      const sessionState = phase === 'RESPONDING'
        ? 'RESPONDING'
        : phase === 'DONE'
          ? 'IDLE'
          : phase === 'CANCELLED'
            ? 'IDLE'
          : phase === 'FAILED'
            ? 'ERROR'
            : 'WORKING';
      payload = JSON.stringify({
        type: 'workspace_session_state',
        sessionState,
        phase,
        detail: event.detail ?? '',
      });
      break;
    }
  }

  if (!payload) return;

  for (const [, conn] of connections) {
    if (!conn.client.authenticated || !conn.workspaceSubscribed) continue;
    if (!isSameChat(conn, event.chatId, event.tenantId, event.sessionId)) continue;
    try {
      conn.socket.send(payload);
    } catch {
      // Socket may have closed — ignore
    }
  }
}

/** Workspace periodic push interval handle */
let workspacePushInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic workspace data push (token budget, provider health).
 * Called once during startup.
 */
export function startWorkspacePush(): void {
  if (workspacePushInterval) return;

  workspacePushInterval = setInterval(() => {
    // Check if any client is subscribed
    let hasSubscribers = false;
    for (const [, conn] of connections) {
      if (conn.client.authenticated && conn.workspaceSubscribed) {
        hasSubscribers = true;
        break;
      }
    }
    if (!hasSubscribers) return;

    // Push token budget
    const usage = tokenBudget.getAllUsage();
    const total = tokenBudget.getWindowSize();
    const used = tokenBudget.getTotalUsage();
    const watermark = tokenBudget.getWatermark();
    const wmMap: Record<string, string> = { normal: 'normal', soft: 'soft', hard: 'hard', rotate: 'critical' };

    const budgetPayload = JSON.stringify({
      type: 'workspace_budget',
      budget: {
        total,
        used,
        zones: {
          system: usage.system,
          memory: usage.memory,
          tasks: usage.tasks,
          dialogue: usage.dialogue,
        },
        watermark: wmMap[watermark] ?? 'normal',
      },
    });

    // Push provider health
    const config = getConfig();
    const brainProvider = config.model_router?.brain_provider ?? '';
    const brainModel = config.brain.model;
    const health = providerHealth.getHealth(brainProvider);

    const providerPayload = JSON.stringify({
      type: 'workspace_providers',
      providers: [{
        name: brainProvider,
        model: brainModel,
        status: health.status,
        latency: Math.round(health.avgLatencyMs ?? 0),
      }],
    });

    for (const [, conn] of connections) {
      if (!conn.client.authenticated || !conn.workspaceSubscribed) continue;
      try {
        conn.socket.send(budgetPayload);
        conn.socket.send(providerPayload);
      } catch {
        // Socket may have closed — ignore
      }
    }
  }, 2000);
}

/**
 * Stop periodic workspace push. Called during shutdown.
 */
export function stopWorkspacePush(): void {
  if (workspacePushInterval) {
    clearInterval(workspacePushInterval);
    workspacePushInterval = null;
  }
}
