import pino from 'pino';
import { createHash } from 'node:crypto';
import { createSession } from './session.js';
import { getBrainClient, getClient, getClientForTask, type RoutingContext } from '../core/model-router.js';
import { precheckTenantTokenQuota } from '../security/entitlements.js';
import { getProvider, resolveRuntimeModel } from '../core/providers.js';
import { getUserModelOverride } from '../channels/telegram.js';
import { saveMessage } from '../memory/conversations.js';
import { cloneLatestUserMessageToTurn, linkLatestTimelineMessage, saveTimelineItem } from '../memory/session-timeline.js';
import {
  getOrCreateSessionForChat,
  getSession as getDbSession,
  getSessionPermissionLevel,
  getSessionScopeGrants,
  touchSession,
  updateTitle,
  type Session,
} from '../memory/sessions.js';
import { broadcastMemoryUpdate, broadcastSessionUpdate } from '../channels/websocket.js';
import { compileIntelligentContext } from '../memory/context-builder.js';
import {
  classifyFailureCategory,
  completeTurnTrace,
  estimateLlmCostUsd,
  getTraceToolCounts,
  startTurnTrace,
  type TurnTraceStatus,
} from '../observer/telemetry.js';
import {
  capturePromptSnapshot,
  persistPromptSnapshot,
  pruneOldSnapshots,
  redactSnapshot,
  updatePromptSnapshotAdmission,
  updatePromptSnapshotVerifier,
} from '../observer/prompt-snapshot.js';
import { getAllRegisteredTools, isDynamicToolAvailable } from '../tools/dynamic-registry.js';
import { extractMemories } from '../memory/auto-extract.js';
import { getMemoryTurnUpdates } from '../memory/mutations.js';
import { generateAndSaveDigest } from '../memory/session-digest.js';
import { getConfig } from '../config/index.js';
import {
  isProfileComplete,
  getFirstContactGuide,
  extractProfileFromConversation,
} from '../memory/user-profile.js';
import { getTextContent, type LLMClient, type ChatMessage, type ChatResponse, type ModelThinkSetting } from '../core/llm.js';
import type { IncomingMessage } from '../channels/telegram.js';
import type { OutputChannel } from '../channels/output-channel.js';
// Tool execution now handled by brain-engine.ts
import { buildUserMessage, formatWorkspaceContext } from './message-builder.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import { log as logEvent } from '../store/events.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { isAbortLikeError, throwIfAborted } from './handler-helpers.js';
// Recovery logic now handled by brain-engine.ts
import type { RecoveryLoopStopReason } from '../core/recovery-policy.js';
import { createTurnControl, type TurnState } from '../core/turn-control.js';
import { startTurnEnvelope, setTurnEnvelopeStatus } from '../memory/turn-envelopes.js';
import { inferTurnLocale } from '../core/turn-locale.js';
import type { TurnOrigin, TurnStatus } from '../core/turn-envelope.js';
import { brainExecute } from '../core/brain-engine.js';
import { getActiveTurnForChat, isTurnCancellationError, registerRunningTurn } from '../core/turn-cancellation.js';
import { buildExecutionToolContext } from '../tools/execution-context.js';
import type { CompletionGateDecision } from '../core/completion-gates.js';
import { shapePromptMessagesForExecution, shapeToolsForExecution } from '../tools/tool-shaping.js';
import { rejectUnsupportedSandboxReferences } from '../core/output-reference-policy.js';
import { expireSteerTurn } from './steer-store.js';
import { resolveRuntimeAdmission } from '../core/durable-plan-admission.js';
import { hasNonTerminalPlanForChat } from '../core/plan-grounding.js';

const logger = pino({ name: 'mozi:gateway' });

/**
 * Map control-plane turn states to durable Turn Envelope terminal statuses
 * (Issue #627). Only terminal states are persisted here; transient working
 * states (QUEUED/PLANNING/EXECUTING/RECOVERING/RESPONDING) leave the envelope
 * `active`.
 *
 * `awaiting_approval` is intentionally NOT mapped from the FSM: no production
 * path drives the turn FSM to `WAITING_INPUT`, so mapping it would be dead
 * wiring. The real approval pause happens inside the tool loop
 * (`waitForApprovalDecisionForTurn` in `tools/executor.ts`), which flips the
 * envelope to `awaiting_approval` for the duration of the blocking wait and
 * back to `active` afterward. See `docs/turn-envelope-phase0.md`.
 */
const TURN_STATE_TO_ENVELOPE_STATUS: Partial<Record<TurnState, TurnStatus>> = {
  DONE: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** Prune aged prompt snapshots once per tenant per process lifetime. */
const prunedSnapshotTenants = new Set<string>();
function schedulePromptSnapshotPrune(tenantId: string): void {
  if (prunedSnapshotTenants.has(tenantId)) return;
  prunedSnapshotTenants.add(tenantId);
  try {
    pruneOldSnapshots(tenantId);
  } catch (err) {
    logger.warn({ tenantId, err: err instanceof Error ? err.message : String(err) }, 'Prompt snapshot prune failed');
  }
}

// ---------------------------------------------------------------------------
// Output sanitization
// ---------------------------------------------------------------------------

// Output sanitization, tool loop guards, and recovery directives
// have been moved to src/core/brain-engine.ts

// normalizeNonNegativeInt is still used by the brainExecute config assembly

function normalizeNonNegativeInt(value: unknown, fallback: number, min = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.max(min, Math.floor(numeric));
}

// Progress callback
// ---------------------------------------------------------------------------

export type { ProgressCallback } from '../core/brain-progress.js';
import type { ProgressCallback } from '../core/brain-progress.js';

/** No-op progress callback for when no progress tracking is needed */
const NOOP_PROGRESS: ProgressCallback = {
  onToolStart: () => {},
  onToolEnd: () => {},
  onProcessingStart: () => {},
  onArtifact: () => {},
};

/** Internal runtime controls for non-user turns such as managed schedules. */
export interface RuntimeTurnOptions {
  origin?: TurnOrigin;
  /** Persisted standing grant for unattended work. */
  permissionLevel?: string;
  originalRequest?: string;
  planDeliveryMode?: 'direct' | 'caller';
  suppressAssistantMessagePersistence?: boolean;
  onDetachedPlanStarted?: (rootTaskId: string) => void;
}

// Keep sessions in memory per chat (no DB persistence yet)
const sessions = new Map<string, ReturnType<typeof createSession>>();

export function __getInMemorySessionForTests(chatId: string): ReturnType<typeof createSession> | undefined {
  return sessions.get(chatId);
}

export function __clearInMemoryGatewayStateForTests(): void {
  sessions.clear();
}

/** Max session idle time before automatic cleanup (1 hour) */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Periodic cleanup of stale sessions to prevent memory leaks */
const sessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_IDLE_TIMEOUT_MS) {
      sessions.delete(chatId);
      logger.debug({ chatId, sessionId: session.id }, 'Stale session cleaned up');
    }
  }
}, SESSION_IDLE_TIMEOUT_MS);
sessionCleanupInterval.unref(); // Don't prevent process exit

/**
 * Get or create a session for a chat.
 */
function getOrCreateSession(chatId: string, tenantId = 'default') {
  let session = sessions.get(chatId);
  if (!session) {
    session = createSession(tenantId);
    sessions.set(chatId, session);
    logger.debug({ chatId, sessionId: session.id }, 'Session created');
  }
  return session;
}

function withDefaultThink(client: LLMClient, think: ModelThinkSetting | undefined): LLMClient {
  if (think === undefined) return client;
  return {
    provider: client.provider,
    chat: (messages, options) => client.chat(messages, { ...options, think: options?.think ?? think }),
    chatStream: (messages, options) => client.chatStream(messages, { ...options, think: options?.think ?? think }),
  };
}

function resolveLightweightClient(brainFallback: LLMClient, routingContext?: RoutingContext): LLMClient {
  try {
    const { client, selection } = getClientForTask({ type: 'summary' }, routingContext);
    return withDefaultThink(client, selection.think);
  } catch {
    logger.debug('Lightweight model unavailable, using Brain client for background task');
    return brainFallback;
  }
}

function startAutoMemoryExtraction(
  chatId: string,
  userId: string | undefined,
  sessionId: string,
  turnId: string,
  userMessage: string,
  assistantResponse: string,
  client: LLMClient,
  tenantId?: string,
): void {
  const bgClient = resolveLightweightClient(client, { tenantId, userId });
  const extraction = assistantResponse.trim().length > 0
    ? extractMemories(userMessage, assistantResponse, bgClient, chatId, tenantId, userId, turnId)
    : Promise.resolve({ mutations: [] });
  void extraction
    .catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ chatId, err: errMsg }, 'Auto memory extraction failed');
    })
    .finally(() => {
      if (!userId) return;
      const updates = getMemoryTurnUpdates(turnId, tenantId ?? 'default');
      broadcastMemoryUpdate({
        targetUserId: userId,
        tenantId,
        chatId,
        sessionId,
        turnId,
        updates,
      });
    });
}

/**
 * Generate a concise title for a session using LLM, then broadcast the update.
 * Fires asynchronously — does not block the response.
 */
function startAutoTitleGeneration(
  dbSession: Session,
  userMessage: string,
  assistantResponse: string,
  client: LLMClient,
): void {
  const bgClient = resolveLightweightClient(client, {
    tenantId: dbSession.tenant_id,
    userId: dbSession.user_id,
  });
  void (async () => {
    try {
      const prompt = [
        { role: 'system' as const, content: 'Generate a concise title (max 30 characters) for this conversation. Reply with ONLY the title, no quotes or extra text.' },
        { role: 'user' as const, content: `User: ${userMessage.slice(0, 200)}\nAssistant: ${assistantResponse.slice(0, 200)}` },
      ];
      const resp = await bgClient.chat(prompt, { max_tokens: 30, temperature: 0.3 });
      const title = resp.content.trim().replace(/^["']|["']$/g, '').slice(0, 50);
      if (title.length > 0) {
        updateTitle(dbSession.id, title, dbSession.tenant_id);
        broadcastSessionUpdate(dbSession.id, title);
        logger.debug({ sessionId: dbSession.id, title }, 'Auto-title generated');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ sessionId: dbSession.id, err: errMsg }, 'Auto-title generation failed');
    }
  })();
}

function startSessionDigestGeneration(
  staleSessionId: string,
  client: LLMClient,
  tenantId: string,
  userId: string,
): void {
  const bgClient = resolveLightweightClient(client, { tenantId, userId });
  void generateAndSaveDigest(staleSessionId, bgClient, tenantId)
    .catch((err) => {
      logger.error({ err, sessionId: staleSessionId }, 'digest generation failed');
    });
}

/**
 * Main message processing pipeline.
 * Routes through Gateway session state machine and Brain dispatcher.
 */
export async function handleMessage(
  msg: IncomingMessage,
  systemPrompt: string,
  fallbackClient: LLMClient,
  progress: ProgressCallback = NOOP_PROGRESS,
  outputChannel?: OutputChannel,
  externalAbortSignal?: AbortSignal,
  delegationSystemPrompt?: string,
  runtimeOptions: RuntimeTurnOptions = {},
): Promise<string | null> {
  const tenantId = msg.tenantId || 'default';
  const existingDbSession = msg.sessionId ? getDbSession(msg.sessionId, tenantId) : null;
  if (msg.sessionId && (!existingDbSession || existingDbSession.user_id !== (msg.userId || msg.chatId))) {
    throw new Error('Session not found or access denied.');
  }
  let staleSessionId: string | undefined;
  let dbSession: Session;
  if (existingDbSession) {
    dbSession = existingDbSession;
  } else {
    const sessionResult = getOrCreateSessionForChat(msg.chatId, msg.userId || msg.chatId, tenantId);
    dbSession = sessionResult.session;
    staleSessionId = sessionResult.staleSessionId;
  }
  // Surface the owned/created session id back onto the shared message BEFORE any
  // progress callback can fire (Issue #627). On a brand-new Web chat the client
  // sends no sessionId, so the WebSocket stream/artifact/final progress callbacks
  // in src/index.ts captured `msg.sessionId` as undefined and broadcast with no
  // session — deliverStreamEvent/broadcastArtifactEvent persist only when
  // `sessionId && targetUserId`, so the assistant timeline rows were silently
  // dropped and session_timeline_events held only the user row. The persisted
  // dbSession is now authoritative; stamping it here keeps stream, artifact, and
  // final paths on the real session. Existing chats already match dbSession.id.
  msg.sessionId = dbSession.id;
  if (msg.channelType === 'websocket') {
    // Defense in depth: execution always comes from the owned session record,
    // even if another transport caller bypasses the WebSocket adapter.
    msg.workspaceContext = dbSession.execution_context ?? undefined;
  }
  // Early session-binding contract (Issue #627). When the client named no
  // session (`!existingDbSession`), the session was just created here — the
  // originating client is still bound to no session and would reject every
  // session-scoped stream frame that follows, leaving it stuck on "Thinking".
  // Announce the resolved id BEFORE any progress frame so the channel can bind
  // the originating connection first. Not fired for existing sessions, so their
  // behavior is unchanged.
  if (!existingDbSession) {
    try {
      progress.onSessionResolved?.(dbSession.id);
    } catch (err) {
      logger.warn({
        sessionId: dbSession.id,
        err: err instanceof Error ? err.message : String(err),
      }, 'onSessionResolved callback threw; continuing turn');
    }
  }
  const turnControl = createTurnControl(msg.chatId, msg.userId || msg.chatId);
  const turnId = turnControl.turnId;

  // --- Turn telemetry state (observability only; must never break the turn) ---
  const turnStartedAtMs = Date.now();
  let telemetryTraceActive = false;
  let tracedProvider: string | undefined;
  let tracedModel: string | undefined;
  const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, llmCalls: 0 };
  const turnUsageCollector = {
    add(usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number }): void {
      turnUsage.input += usage.input_tokens;
      turnUsage.output += usage.output_tokens;
      turnUsage.cacheRead += usage.cache_read_tokens ?? 0;
      turnUsage.cacheWrite += usage.cache_write_tokens ?? 0;
      turnUsage.llmCalls += 1;
    },
  };
  const finishTurnTrace = (
    status: TurnTraceStatus,
    failureMessage?: string,
    gateDecision?: CompletionGateDecision,
  ): void => {
    if (!telemetryTraceActive) return;
    telemetryTraceActive = false;
    try {
      const counts = getTraceToolCounts(turnId, tenantId);
      completeTurnTrace({
        trace_id: turnId,
        tenant_id: tenantId,
        status,
        verify_status: gateDecision?.status,
        verify_summary: gateDecision?.summary,
        latency_ms: Date.now() - turnStartedAtMs,
        failure_category: failureMessage ? classifyFailureCategory(failureMessage) : undefined,
        tool_call_count: counts.total,
        tool_failure_count: counts.failures,
        llm_input_tokens: turnUsage.input,
        llm_output_tokens: turnUsage.output,
        cache_read_tokens: turnUsage.cacheRead,
        cache_write_tokens: turnUsage.cacheWrite,
        cost_usd: estimateLlmCostUsd(
          tracedProvider,
          tracedModel,
          turnUsage.input,
          turnUsage.output,
          turnUsage.cacheRead,
          turnUsage.cacheWrite,
        ),
      });
    } catch (err) {
      logger.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'Failed to complete turn trace');
    }
  };
  const publishTurnState = (state: TurnState, detail?: string): void => {
    try {
      const snapshot = turnControl.transition(state, detail);
      // Mirror control-plane terminal/wait transitions into the durable turn
      // envelope so a reload learns the truthful terminal status. turn_state
      // events themselves are ephemeral; the envelope is the persisted record.
      const envelopeStatus = TURN_STATE_TO_ENVELOPE_STATUS[snapshot.state];
      if (envelopeStatus) {
        try {
          setTurnEnvelopeStatus({ tenantId, sessionId: dbSession.id, turnId, status: envelopeStatus });
        } catch (err) {
          logger.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'Failed to persist turn envelope status');
        }
      }
      // Broadcast only after the envelope transition is durable, so the live
      // `turn_envelope` frame and a simultaneous REST restore agree.
      emitProgress({
        type: 'turn_state',
        chatId: msg.chatId,
        tenantId,
        sessionId: dbSession.id,
        turnId,
        turnState: snapshot.state,
        detail: snapshot.detail,
      });
      logger.info({
        chatId: msg.chatId,
        turnId,
        turnState: snapshot.state,
        detail: snapshot.detail,
      }, 'Turn state transition');
    } catch (err) {
      logger.warn({
        chatId: msg.chatId,
        turnId,
        from: turnControl.state(),
        to: state,
        err: err instanceof Error ? err.message : String(err),
      }, 'Invalid turn-state transition ignored');
    }
  };
  emitProgress({
    type: 'turn_state',
    chatId: msg.chatId,
    tenantId,
    sessionId: dbSession.id,
    turnId,
    turnState: turnControl.state(),
    detail: 'queued',
  });
  const session = getOrCreateSession(msg.chatId, tenantId);

  // Transition IDLE → WORKING (handle RESPONDING → WORKING too)
  try {
    session.transition('WORKING');
  } catch {
    const activeTurn = getActiveTurnForChat(msg.chatId, tenantId);
    if (activeTurn) {
      const busyMessage = 'A previous request is still running for this chat. Please wait for it to finish or use /cancel before sending another message.';
      logger.warn({
        chatId: msg.chatId,
        state: session.state,
        activeTurnId: activeTurn.turnId,
      }, 'Concurrent message rejected while turn is in flight');
      publishTurnState('CANCELLED', 'previous request still running');
      progress.onStreamEnd?.(busyMessage);
      if (outputChannel) {
        await outputChannel.send(busyMessage);
        return '';
      }
      return busyMessage;
    }
    // Session may be stuck in RESPONDING from a previous error; reset
    logger.warn({ chatId: msg.chatId, state: session.state }, 'Session state reset needed');
    sessions.delete(msg.chatId);
    return handleMessage(msg, systemPrompt, fallbackClient, progress, outputChannel, externalAbortSignal, delegationSystemPrompt, runtimeOptions);
  }

  logger.info({ chatId: msg.chatId, sessionId: session.id, state: 'WORKING' }, 'State transition');
  const runningTurn = registerRunningTurn({
    turnId,
    chatId: msg.chatId,
    userId: msg.userId || msg.chatId,
    tenantId,
    sessionId: dbSession.id,
  });
  // Surface the server-authoritative turn id back to the caller via the shared
  // message object (Issue #627). The synchronous non-streamed WS reply is
  // persisted after this turn is unregistered, so it can no longer resolve
  // identity from the active-turn registry; it reads `msg.turnId` instead.
  msg.turnId = turnId;
  // Record the server-authoritative Turn Envelope (Issue #627). Interactive
  // turns originate from the user; the status starts `active`, is flipped to
  // `awaiting_approval` by the tool loop during a real approval pause, and is
  // advanced to a terminal value by publishTurnState. Never fatal to the turn.
  try {
    startTurnEnvelope({
      tenantId,
      sessionId: dbSession.id,
      chatId: msg.chatId,
      turnId,
        origin: runtimeOptions.origin ?? 'user',
      // Carry the turn's presentation locale on the authoritative path (Issue
      // #628), inferred once from the user's own prompt. Every consumer reads
      // this instead of re-scanning message characters per render.
      locale: inferTurnLocale(msg.text),
      startedAt: turnStartedAtMs,
    });
  } catch (err) {
    logger.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'Failed to start turn envelope');
  }
  // The first live lifecycle frame must follow envelope creation so it already
  // carries the authoritative locale; otherwise the UI would briefly fall back
  // to character scanning until EXECUTING.
  publishTurnState('PLANNING', 'request accepted');
  // The caller's signal (turn superseded, channel timeout, shutdown drain) must
  // actually reach the brain loop — it was previously accepted and dropped, which
  // made graceful shutdown a silent no-op that hard-killed in-flight turns.
  const abortSignal = externalAbortSignal
    ? AbortSignal.any([runningTurn.signal, externalAbortSignal])
    : runningTurn.signal;

  try {
    throwIfAborted(abortSignal, 'Request cancelled');
    const userMessage = await buildUserMessage(msg);
    const simpleTaskId = `${turnId}:simple`;

    // Save user message to DB for LLM context and the visible timeline. A Web UI
    // regenerate re-runs an existing prompt, so it must not append the same user
    // bubble again on refresh.
    // Persist uploaded-file attachments in BOTH stores so the chip survives a
    // reload: conversations.metadata (loadHistory fallback) AND the session
    // timeline item (loadTimeline — the primary restore path). Keeping them in
    // one list prevents the two stores from diverging again.
    const attachmentList = msg.attachments?.length
      ? msg.attachments.map(a => ({ filename: a.filename ?? '', path: a.path, mimeType: a.mime }))
      : undefined;
    const attachmentMeta = attachmentList ? JSON.stringify({ attachments: attachmentList }) : undefined;
    const persistUserMessage = msg.suppressUserMessagePersistence !== true;
    if (persistUserMessage) {
      const conversationId = saveMessage(msg.chatId, 'user', userMessage, undefined, undefined, dbSession.id, tenantId, attachmentMeta);
      const userMessageTimestamp = Date.now();
      saveTimelineItem({
        tenantId,
        sessionId: dbSession.id,
        chatId: msg.chatId,
        turnId,
        conversationId,
        type: 'message',
        eventKey: `turn:${turnId}:message:user`,
        timestamp: userMessageTimestamp,
        data: {
          id: `msg_${turnId}_user`,
          role: 'user',
          content: userMessage,
          timestamp: userMessageTimestamp,
          ...(attachmentList ? { attachments: attachmentList } : {}),
        },
      });
    } else if ((runtimeOptions.origin ?? 'user') === 'user') {
      // Regenerate re-runs an existing prompt under a NEW turn id (Issue #626).
      // Clone the prompt into this turn so the retry is coherent while the
      // complete prior turn remains immutable and visible.
      const cloned = cloneLatestUserMessageToTurn({ tenantId, sessionId: dbSession.id, turnId, content: userMessage });
      if (!cloned) {
        // Fail closed: executing one prompt while persisting another would make
        // the durable Turn Envelope untruthful (stale or forged retry request).
        throw new Error('Regenerate source prompt was not found in this session');
      }
    }

    // Notify channels after the input-side transcript decision, so restored
    // timelines cannot place assistant work before a newly persisted user request.
    progress.onProcessingStart();
    throwIfAborted(abortSignal, 'Request cancelled');

    // Set a temporary truncated title immediately so the sidebar isn't blank
    const needsAutoTitle = dbSession.title === 'New Chat';
    if (needsAutoTitle) {
      const tempTitle = userMessage.slice(0, 50);
      updateTitle(dbSession.id, tempTitle, tenantId);
      broadcastSessionUpdate(dbSession.id, tempTitle);
    }

    // First-contact profile check — inject guide if profile is incomplete
    const profileComplete = isProfileComplete(tenantId);

    // Channel-aware output format hint
    const channelFormatHint = msg.channelType === 'telegram'
      ? '\n\n[Output Format: This user is on Telegram. Use plain text only — no markdown tables, no code fences (```), no HTML tags. Use bullet points (•), numbered lists, and simple text formatting. Keep responses concise.]'
      : msg.channelType === 'wechat'
      ? '\n\n[Output Format: This user is on WeChat Official Account. Plain text ONLY — no markdown, no code fences, no HTML, no formatting of any kind. WeChat does NOT render markdown. Keep responses concise. Max 2048 chars per message (auto-split handled). Respond in the user\'s language.]'
      : msg.channelType === 'websocket'
      ? '\n\n[Output Format: This user is on the Web UI. Full markdown is supported — use tables, code blocks, headers, bold, links as appropriate.]'
      : '';

    // Workspace scope selected in the Web UI is TURN CONTEXT for the Brain, not
    // user content — inject it into the system prompt so it never pollutes the
    // persisted user bubble or the auto-title.
    const workspaceContextHint = formatWorkspaceContext(msg);
    // NOTE: workspaceContextHint (uploaded file paths, selected workspace) is
    // intentionally NOT appended to the base system prompt here. The identity
    // slot is run through fitTextSlot(), which truncates from the bottom — so a
    // tail-appended hint silently vanishes whenever SOUL.md exceeds the slot cap
    // (this is exactly why uploaded attachments were invisible to the Brain).
    // It is injected below as a dedicated, non-truncated turn-context message.
    const effectiveBasePrompt = (profileComplete
      ? systemPrompt
      : `${systemPrompt}\n\n${getFirstContactGuide(tenantId)}`)
      + channelFormatHint;

    const userId = msg.userId ?? msg.chatId;
    precheckTenantTokenQuota(tenantId);

    // Resolve the model before compiling context so threshold accounting uses
    // the actual selected model's context window, not a process-wide default.
    let client = fallbackClient;
    let selectedModel = 'fallback';
    let selectedRole = 'fallback';
    let selectedProvider = '';
    let selectedThink: ModelThinkSetting | undefined;
    if (process.env['MOZI_E2E_LLM'] !== 'scripted') {
      try {
        const userOverride = msg.userId ? getUserModelOverride(msg.userId) : undefined;
        if (userOverride) {
          const overrideSelection = { provider: userOverride.provider, model: userOverride.model, role: 'brain' as const, tenantId, userId };
          client = getClient(overrideSelection);
          selectedModel = userOverride.model;
          selectedRole = 'brain (user-override)';
          selectedProvider = userOverride.provider;
        } else {
          const { client: brainClient, selection } = getBrainClient({ tenantId, userId });
          client = brainClient;
          selectedModel = selection.model;
          selectedRole = selection.role;
          selectedProvider = selection.provider;
          selectedThink = selection.think;
        }
      } catch {
        client = fallbackClient;
        selectedModel = 'fallback';
        selectedRole = 'fallback';
        selectedProvider = '';
        selectedThink = undefined;
      }
    }
    const selectedModelDef = selectedProvider
      ? resolveRuntimeModel(selectedProvider, selectedModel, { allowUnknown: true })
      : undefined;
    logger.info({ model: selectedModel, role: selectedRole }, 'Brain model selected for request');
    const compiledContext = await compileIntelligentContext(
      msg.chatId,
      effectiveBasePrompt,
      userMessage,
      tenantId,
      userId,
      dbSession.id,
      selectedModelDef?.contextWindow,
    );
    const intelligentContext: ChatMessage[] = compiledContext.messages;
    throwIfAborted(abortSignal, 'Request cancelled');
    const effectiveSystemPrompt = intelligentContext[0]?.role === 'system'
      ? intelligentContext[0].content
      : systemPrompt;
    const runtimeAdmission = resolveRuntimeAdmission(userMessage, {
      hasNonTerminalPlan: hasNonTerminalPlanForChat(msg.chatId, tenantId),
    });
    const turnToolShaping = shapeToolsForExecution({
      tools: getAllRegisteredTools(tenantId),
      userText: userMessage,
      runtimeAdmission,
      provider: selectedProvider,
      model: selectedModel,
    });
    const stablePrefixHash = createHash('sha256')
      .update(typeof effectiveSystemPrompt === 'string' ? effectiveSystemPrompt : JSON.stringify(effectiveSystemPrompt))
      .digest('hex');
    const promptCacheKey = selectedProvider === 'openai'
      ? createHash('sha256').update(JSON.stringify({
          tenantId,
          userId,
          model: selectedModel,
          stablePrefixHash,
          toolProfile: turnToolShaping.taskProfile,
          runtimeAdmission: runtimeAdmission ?? null,
        })).digest('hex').slice(0, 48)
      : undefined;

    // --- Open the turn trace and persist the per-turn prompt snapshot ---
    try {
      startTurnTrace({
        trace_id: turnId,
        turn_id: turnId,
        tenant_id: tenantId,
        chat_id: msg.chatId,
        model: selectedModel,
        provider: selectedProvider || undefined,
        prompt_cache_key: promptCacheKey,
        stable_prefix_hash: stablePrefixHash,
        cache_profile: turnToolShaping.taskProfile,
      });
      telemetryTraceActive = true;
      tracedProvider = selectedProvider || undefined;
      tracedModel = selectedModel;
      const snapshotToolShaping = turnToolShaping;
      const snapshotPromptMessages = shapePromptMessagesForExecution(intelligentContext, snapshotToolShaping);
      persistPromptSnapshot(redactSnapshot(capturePromptSnapshot({
        trace_id: turnId,
        tenant_id: tenantId,
        chat_id: msg.chatId,
        model: selectedModel,
        slotBreakdown: compiledContext.slotBreakdown,
        totalBudget: compiledContext.totalBudget,
        systemSlotBudget: compiledContext.systemSlotBudget,
        historyTokenBudget: compiledContext.historyTokenBudget,
        tools: snapshotToolShaping.tools.map(tool => ({
          name: tool.function.name,
          source: isDynamicToolAvailable(tool.function.name, tenantId) ? 'dynamic' as const : 'builtin' as const,
        })),
        gateDecision: null,
        messageCount: intelligentContext.length,
        systemMessageCount: intelligentContext.filter(m => m.role === 'system').length,
        promptTokensEstimate: Math.ceil(snapshotPromptMessages.reduce((sum, message) => sum + getTextContent(message).length, 0) / 4),
        toolSchemaTokensEstimate: snapshotToolShaping.schemaTokensEstimate,
        taskProfile: snapshotToolShaping.taskProfile,
        runtimeAdmission,
      })));
      schedulePromptSnapshotPrune(tenantId);
    } catch (err) {
      logger.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'Turn telemetry setup failed');
    }

    let responseText: string;

    {
      publishTurnState('EXECUTING', 'brain execution');
      const modelDef = selectedModelDef;
      const hintsMaxTokens = modelDef?.maxOutputTokens ?? 4096;
      const hintsTemperature = 0.7;
      const { tools: toolsConfig } = getConfig();
      const sessionPermissionLevel = runtimeOptions.permissionLevel
        ?? getSessionPermissionLevel(dbSession.id, tenantId)
        ?? dbSession.permission_level;
      const compressed = [...intelligentContext];
      // Inject turn-context (uploaded files / selected workspace) as a dedicated
      // system message AFTER compression, so it is never dropped by identity-slot
      // truncation or history compression. Placed right after the main system
      // prompt if present, otherwise at the front.
      if (workspaceContextHint) {
        let lastUserIndex = -1;
        for (let index = compressed.length - 1; index >= 0; index--) {
          if (compressed[index]?.role === 'user') {
            lastUserIndex = index;
            break;
          }
        }
        const insertAt = lastUserIndex >= 0 ? lastUserIndex : compressed.length;
        compressed.splice(insertAt, 0, { role: 'system', content: workspaceContextHint });
      }
      throwIfAborted(abortSignal, 'Request cancelled');

      // === Brain execution via brain-engine ===
      const selectedProviderDef = getProvider(selectedProvider);
      const configuredCallTimeoutMs = normalizeNonNegativeInt(toolsConfig.loops.llm_call_timeout_ms, 45000);
      const configuredLoopTimeoutMs = normalizeNonNegativeInt(toolsConfig.loops.max_elapsed_ms, 120000);
      const cliCallTimeoutMs = selectedProviderDef?.apiMode === 'cli-pipe'
        ? selectedProviderDef.cliBackend?.timeoutMs ?? 30 * 60_000
        : configuredCallTimeoutMs;
      const cliLoopTimeoutMs = selectedProviderDef?.apiMode === 'cli-pipe'
        ? Math.max(configuredLoopTimeoutMs, cliCallTimeoutMs)
        : configuredLoopTimeoutMs;

      const brainResult = await brainExecute({
        client,
        tenantId,
        contextMessages: compressed,
        maxTokens: hintsMaxTokens,
        temperature: hintsTemperature,
        think: selectedThink,
        modelProvider: selectedProvider,
        modelId: selectedModel,
        runtimeAdmission,
        promptCacheKey,
        abortSignal,
        usageCollector: turnUsageCollector,
        toolContext: buildExecutionToolContext('interactive', {
          chatId: msg.chatId,
          channelType: msg.channelType,
          tenantId,
          userId,
          turnId,
          telemetryTraceActive,
          sessionId: dbSession.id,
          agentId: `session:${dbSession.id}`,
          permissionLevel: sessionPermissionLevel,
          userPrompt: userMessage,
          workspaceRootPath: msg.workspaceContext?.rootPath,
          scopeGrants: getSessionScopeGrants(dbSession.id, tenantId),
          onArtifact: progress.onArtifact,
          abortSignal,
          // The selected turn model is an execution input, not a global default.
          // Detached plans persist this snapshot so retries and restarts cannot
          // silently route to another model.
          client,
          systemPrompt: delegationSystemPrompt,
          originalRequest: runtimeOptions.originalRequest ?? userMessage,
          planDeliveryMode: runtimeOptions.planDeliveryMode,
          turnOrigin: runtimeOptions.origin,
          ...(selectedProvider && selectedModel !== 'fallback'
            ? { executionModel: { provider: selectedProvider, model: selectedModel, think: selectedThink } }
            : {}),
        }),
        progress,
        chatId: msg.chatId,
        turnId,
        taskId: simpleTaskId,
        channelType: msg.channelType,
        maxIterations: normalizeNonNegativeInt(toolsConfig.loops.max_iterations, 0),
        llmCallTimeoutMs: cliCallTimeoutMs,
        maxLoopElapsedMs: cliLoopTimeoutMs,
        repeatedBatchThreshold: normalizeNonNegativeInt(toolsConfig.loops.repeated_batch_threshold, 2, 2),
        maxFailedToolBatches: normalizeNonNegativeInt(toolsConfig.loops.max_failed_tool_batches, 3, 1),
        selfHealRetries: normalizeNonNegativeInt(toolsConfig.loops.self_heal_retries, 1),
        selfHealBackoffMs: normalizeNonNegativeInt(toolsConfig.loops.self_heal_backoff_ms, 250),
      });

      const sanitizedResponse = rejectUnsupportedSandboxReferences(brainResult.responseText);
      responseText = sanitizedResponse.content;
      if (brainResult.detachedPlanRootId) {
        runtimeOptions.onDetachedPlanStarted?.(brainResult.detachedPlanRootId);
      }
      if (sanitizedResponse.rejectedCount > 0) {
        logger.warn({
          turnId,
          rejectedCount: sanitizedResponse.rejectedCount,
        }, 'Rejected unsupported sandbox links from interactive completion');
      }
      try {
        updatePromptSnapshotVerifier(turnId, tenantId, brainResult.completionGateDecision);
        if (runtimeAdmission) {
          updatePromptSnapshotAdmission(
            turnId,
            tenantId,
            brainResult.runtimeAdmissionBlocked ? 'blocked' : 'accepted',
          );
        }
      } catch (err) {
        logger.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'Failed to update prompt snapshot verifier state');
      }

      // Post-brain-execution: save, extract memories, auto-title
      const totalTokens = brainResult.totalTokens ?? 0;
      // Guard: only save non-empty responses to avoid polluting conversation history
      if (responseText.trim().length > 0 && !runtimeOptions.suppressAssistantMessagePersistence) {
        const conversationId = saveMessage(msg.chatId, 'assistant', responseText, brainResult.model, totalTokens, dbSession.id, tenantId);
        linkLatestTimelineMessage({ tenantId, sessionId: dbSession.id, role: 'assistant', content: responseText, conversationId });
      }

      if (brainResult.recovered) {
        publishTurnState(brainResult.recoveryMode === 'fallback' ? 'FAILED' : 'EXECUTING', `recovery: ${brainResult.recoveryMode}`);
      }

      startAutoMemoryExtraction(
        msg.chatId,
        msg.userId || msg.chatId,
        dbSession.id,
        turnId,
        userMessage,
        responseText,
        client,
        tenantId,
      );
      if (staleSessionId) {
        startSessionDigestGeneration(staleSessionId, client, tenantId, msg.userId || msg.chatId);
      }
      if (!profileComplete) {
        void extractProfileFromConversation(userMessage, responseText, client, tenantId)
          .catch(err => {
            logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Profile extraction failed');
          });
      }
      if (needsAutoTitle) startAutoTitleGeneration(dbSession, userMessage, responseText, client);

      progress.onStreamEnd?.(responseText);

      logger.info({
        chatId: msg.chatId,
        model: brainResult.model,
        tokens: totalTokens,
        cacheReadTokens: turnUsage.cacheRead,
        llmCalls: turnUsage.llmCalls,
        toolIterations: brainResult.toolIterations,
        recovered: brainResult.recovered,
        recoveryMode: brainResult.recoveryMode,
      }, 'Brain execution complete');
      if (brainResult.runtimeAdmissionBlocked) {
        finishTurnTrace('failed', 'Runtime admission failed closed', brainResult.completionGateDecision);
      } else if (brainResult.completionGateBlocked) {
        finishTurnTrace('failed', brainResult.completionGateDecision.summary, brainResult.completionGateDecision);
      } else {
        finishTurnTrace('success', undefined, brainResult.completionGateDecision);
      }
    }


    // Update DB session timestamp
    touchSession(dbSession.id, tenantId);

    // Transition WORKING → RESPONDING → IDLE
    session.transition('RESPONDING');
    logger.info({ chatId: msg.chatId, state: 'RESPONDING' }, 'State transition');
    if (turnControl.state() !== 'FAILED' && turnControl.state() !== 'DONE') {
      publishTurnState('RESPONDING', 'finalizing response');
    }

    // Use unified output channel if provided, otherwise return string
    if (outputChannel) {
      if (responseText.trim().length > 0) {
        await outputChannel.send(responseText);
      }
      session.transition('IDLE');
      logger.info({ chatId: msg.chatId, state: 'IDLE' }, 'State transition');
      if (turnControl.state() !== 'FAILED' && turnControl.state() !== 'DONE') {
        publishTurnState('DONE', 'response sent');
      }
      return null;
    }

    session.transition('IDLE');
    logger.info({ chatId: msg.chatId, state: 'IDLE' }, 'State transition');
    if (turnControl.state() !== 'FAILED' && turnControl.state() !== 'DONE') {
      publishTurnState('DONE', 'response returned');
    }

    return responseText;
  } catch (err) {
    if (isTurnCancellationError(err) || abortSignal.aborted || isAbortLikeError(err)) {
      sessions.delete(msg.chatId);
      const message = err instanceof Error ? err.message : String(err);
      finishTurnTrace(/timed? ?out/i.test(message) ? 'timeout' : 'cancelled', message);
      publishTurnState('CANCELLED', message.slice(0, 200) || 'Request cancelled');
      progress.onStreamEnd?.('');
      logger.info({ chatId: msg.chatId, turnId, err: message }, 'Handler turn cancelled');
      return '';
    }

    // Reset session state on error
    sessions.delete(msg.chatId);
    const message = err instanceof Error ? err.message : String(err);
    finishTurnTrace(/timed? ?out/i.test(message) ? 'timeout' : 'failed', message);
    publishTurnState('FAILED', message.slice(0, 200));
    logger.error({ err: message, chatId: msg.chatId }, 'Handler error');
    throw err;
  } finally {
    // Synchronous cleanup before unregistering the turn closes the generation:
    // a steer that missed the last Brain boundary can never leak into a later turn.
    expireSteerTurn(tenantId, msg.chatId, turnId);
    runningTurn.finish();
  }
}
