import { setDefaultResultOrder } from 'node:dns';
// Force IPv4-first DNS resolution. Node.js defaults to IPv6-first, which
// causes ETIMEDOUT on networks where IPv6 routes to services like Telegram
// are broken while IPv4 works fine (curl succeeds but Node.js doesn't).
setDefaultResultOrder('ipv4first');

import { readFileSync, existsSync, readdirSync, statSync, unlinkSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import pino from 'pino';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { ensureMoziHome, getConfigPath } from './paths.js';
import { quarantineLegacyPythonRuntime } from './runtime/python-env.js';
import { loadDelegationSystemPrompt, loadSystemPrompt, resolveWorkspaceDir, resolveTenantId, adaptPromptForChannel } from './system-prompt.js';
import { registerApiRoutes, registerStaticServing } from './api-routes.js';
import { registerScheduledTasks } from './scheduled-tasks.js';
import { loadEnvAndSecrets, resolveJwtSecret } from './security/secrets.js';

// Load .env + encrypted secrets from ~/.mozi/
loadEnvAndSecrets();
import { loadConfig, getConfig } from './config/index.js';
import { initDb, closeDb, isDatabaseFatalError } from './store/db.js';
import { runMigrations } from './store/migrate.js';
import { refreshPricingAndReprice } from './tenants/billing-reconciliation.js';
import {
  createTelegramAdapter,
  sendDirectMessage as tgSendDirectMessage,
  isTelegramChatId,
  setBotCommands,
  type IncomingMessage,
  type TelegramAdapter,
} from './channels/telegram.js';
import { create as createLLMClient, createDeferredClient as createDeferredLLMClient } from './core/llm.js';
import type { LLMClient } from './core/llm.js';
import { migrateEnvVars } from './core/providers.js';
import {
  buildRuntimeCapabilityManifest,
  buildRoutingExplainability,
  formatCapabilityCommandOutput,
} from './core/capability-manifest.js';
import { formatTasksCommandOutput } from './core/task-command.js';
import { formatRuntimeSkillsCommandOutput, listRuntimeSkills } from './skills/workspace-manager.js';
import type { Telegraf } from 'telegraf';
import { on as onProgressEvent, type ProgressEvent } from './progress/event-bus.js';
import { createTelegramProgressBridge } from './progress/progress-bridge.js';
import { isOnboardingCompleted, getBootstrapState, setBootstrapState } from './onboarding/state.js';
import {
  isOnboarding,
  startSession,
  processOnboardingMessage,
  migrateWorkspaceTemplates,
} from './onboarding/index.js';
import { isAllowed, addAllowedUser, getAllowedUsers, hasAnyPairedUsers, startPairing, validatePairingCode, createPairingRequest, cleanExpiredRequests, consumeApprovedRequests } from './security/pairing.js';
import { checkCommandAccess, AccessDeniedError } from './security/rbac.js';
import { approveRequest, rejectRequest, getPendingRequests } from './security/gates.js';
import { notify, registerSender } from './channels/proactive-notifier.js';
import { handleMessage, type ProgressCallback } from './gateway/handler.js';
import { killAllProcesses } from './capabilities/shell.js';
import { TelegramOutputChannel } from './channels/output-channel.js';
import { createTelegramProgress } from './channels/telegram-progress.js';
import { getAllRegisteredTools, loadDynamicToolsFromDb } from './tools/dynamic-registry.js';
import { registerWebSocketRoute, broadcastProgressEvent, broadcastStreamEvent, broadcastArtifactEvent, broadcastWorkspaceEvent, broadcastTurnQueuedEvent, broadcastTurnTimeoutEvent, bindResolvedSessionToConnection, startWorkspacePush, stopWorkspacePush, sendToUser as wsSendToUser, type WsIncomingMessage } from './channels/websocket.js';
import { registerVoiceRoute } from './channels/voice.js';
import { startPolling as startWeChatPolling, stopPolling as stopWeChatPolling, isWeChatUserId } from './channels/wechat.js';
import { installBuiltinChannelPlugins } from './channels/plugins/index.js';
import { installBuiltinToolHooks } from './tools/builtin-hooks/index.js';
import { channelRegistry, startRegisteredChannels, type ChannelRuntime } from './channels/registry.js';

// Populate the channel registry with built-in plugins. Must run before any
// code that iterates the registry (wizard, capability manifest, proactive
// router).
installBuiltinChannelPlugins();
// Populate the tool plugin-hook registry with built-in hooks (e.g.
// `builtin.redact-secrets`). Must run before any tool call dispatches.
installBuiltinToolHooks();
import { initTel } from './tel/index.js';
import type { FastifyInstance } from 'fastify';
import { schedule as scheduleTask, start as startScheduler, stop as stopScheduler } from './scheduler/index.js';
import { startAgentLoop, stopAgentLoop, getAgentLoopStatus, collectSignalSnapshot, type InternalAgentLoopConfig } from './core/agent-loop.js';
import { pushEvent, wake as wakeProactiveEngine, startProactiveEngine, stopProactiveEngine } from './core/proactive-engine.js';
import { claimPidFile, releasePidFile } from './runtime/pidfile.js';
import { handleConfigCommand } from './config/api.js';
import {
  runBootstrap,
  handleOnboardCommand,
  loadBootstrapAgents,
  loadBootstrapSkills,
  loadWorkspaceAgents,
  loadWorkspaceSkills,
} from './bootstrap/index.js';

const WEBSOCKET_MAX_PAYLOAD_BYTES = 1_048_576;
import { recover as crashRecover, setCleanShutdown, wasCleanShutdown, formatRecoveryMessage } from './core/crash-recovery.js';
import { cancelAllRunningTurns, getActiveTurnForChat, getRunningTurnCount } from './core/turn-cancellation.js';
import { createDefaultFailoverManager } from './core/provider-failover.js';
import { setFailoverManager, getClientForTask } from './core/model-router.js';
import { createMCPBridge, setMCPBridge, type MCPBridge } from './mcp/index.js';
import { reportTimeoutAndMaybeTune } from './core/autonomous-timeout.js';
import { getRuntimeProjectRoot } from './runtime/project-root.js';
import { getBuildInfo } from './runtime/build-info.js';
import { buildDeterministicRecoveryMessage, extractRecoveryErrorText } from './core/error-surfacing.js';

const logger = pino({ name: 'mozi' });

// ── Process-level safety net ────────────────────────────────────────
// Prevent transient network errors (e.g. Telegram ETIMEDOUT) from
// crashing the entire process. Log and continue.
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ err: reason }, 'Unhandled promise rejection (swallowed)');
});
process.on('uncaughtException', (err: Error, origin: string) => {
  const msg = err.message ?? '';
  const msgLower = msg.toLowerCase();
  // Fatal errors: OOM, stack overflow, or storage failures should kill the process
  const isFatal =
    msg.includes('out of memory') ||
    msg.includes('stack overflow') ||
    msgLower.includes('sqlite_ioerr') ||
    msgLower.includes('sqlite_full') ||
    msgLower.includes('sqlite_corrupt') ||
    msgLower.includes('sqlite_cantopen') ||
    msgLower.includes('sqlite_readonly') ||
    msgLower.includes('enospc') ||
    msgLower.includes('eacces') ||
    msgLower.includes('database disk image is malformed');
  if (isFatal) {
    logger.fatal({ err, origin }, 'Fatal uncaught exception — storage or memory failure, exiting');
    process.exit(1);
  }
  logger.error({ err, origin }, 'Uncaught exception (swallowed)');
});
const runtimeRoot = getRuntimeProjectRoot();
const TELEGRAM_LAUNCH_BASE_RETRY_MS = 2_000;
const TELEGRAM_LAUNCH_MAX_RETRY_MS = 60_000;

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isRetryableTelegramLaunchError(err: unknown): boolean {
  const code = getErrorCode(err);
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/401|unauthorized|forbidden|invalid token|not found/i.test(message)) return false;
  return /econnreset|timeout|timed out|network|socket hang up|503|504|502|service unavailable|temporarily unavailable/i.test(message);
}

async function launchTelegramWithRetry(adapter: TelegramAdapter): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await adapter.launch();
      logger.info({ attempt }, 'Telegram bot started');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = isRetryableTelegramLaunchError(err);
      const code = getErrorCode(err);
      if (!retryable) {
        logger.error({ attempt, code, err: message }, 'Telegram bot launch failed (non-retryable)');
        throw err instanceof Error ? err : new Error(message);
      }
      const delayMs = Math.min(
        TELEGRAM_LAUNCH_MAX_RETRY_MS,
        TELEGRAM_LAUNCH_BASE_RETRY_MS * Math.max(1, Math.pow(2, attempt - 1)),
      );
      logger.warn(
        { attempt, code, err: message, retryInMs: delayMs },
        'Telegram bot launch failed (transient), retrying',
      );
      await sleepMs(delayMs);
    }
  }
}

function resolveUiDistPath(): string | null {
  const candidates = [join(runtimeRoot, 'ui', 'dist')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function hasUiProject(): boolean {
  return existsSync(join(runtimeRoot, 'ui', 'package.json'));
}

function resolveAuthSecret(configuredToken: string | undefined): string {
  if (configuredToken && configuredToken.trim().length > 0) {
    return configuredToken;
  }
  return resolveJwtSecret();
}


// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

let serverUrl: string | null = null;

function handleStatus(startTime: Date): string {
  const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  const agentLoopStatus = getAgentLoopStatus();

  const availableTools = getAllRegisteredTools();
  const lines = [
    'Runtime Status',
    `Uptime: ${hours}h ${minutes}m ${seconds}s`,
    `Version: v${JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf-8')).version ?? '0.0.0'}`,
    `Database: SQLite WAL`,
    `Tools: ${availableTools.filter(t => t?.function).map(t => t.function.name).join(', ') || 'none'}`,
    `Server: ${serverUrl ?? 'not running'}`,
    `Agent Loop: ${agentLoopStatus.running ? 'running' : 'stopped'} (${agentLoopStatus.interval_minutes}m interval)`,
    `Agent Loop Last Run: ${agentLoopStatus.last_run_at ? new Date(agentLoopStatus.last_run_at).toISOString() : 'never'}`,
  ];

  if (agentLoopStatus.last_error) {
    lines.push(`Agent Loop Last Error: ${agentLoopStatus.last_error}`);
  }

  return lines.join('\n');
}

function handleHelp(): string {
  return [
    'Agent Runtime — Commands',
    '',
    '/start    — Start session / onboarding',
    '/status   — System status',
    '/capabilities — Runtime capability manifest',
    '/help     — This message',
    '/tasks    — List active tasks',
    '/cancel   — Cancel running task by ID',
    '/agents   — List agents',
    '/skills   — List skills',
    '/config   — View or update config',
    '/approve  — Approve hard-gate request',
    '/reject   — Reject hard-gate request',
    '/budget   — Token usage',
    '/pair     — Generate pairing code for new user',
    '/users    — List paired users',
    '/onboard  — Re-run model setup',
    '',
    'Send any message for AI conversation.',
  ].join('\n');
}

function createRuntimeCapabilityManifest(config: ReturnType<typeof loadConfig>, tenantId = 'default') {
  return buildRuntimeCapabilityManifest(
    config,
    getAllRegisteredTools().map(t => t.function.name),
    tenantId,
  );
}

function handleCapabilities(
  config: ReturnType<typeof loadConfig>,
  tenantId = 'default',
  userId?: string,
): string {
  const routingExplain = buildRoutingExplainability(config, { tenantId, userId });
  return formatCapabilityCommandOutput(createRuntimeCapabilityManifest(config, tenantId), routingExplain);
}

async function handleSkills(_config: ReturnType<typeof loadConfig>, _tenantId = 'default'): Promise<string> {
  const skills = await listRuntimeSkills();
  return formatRuntimeSkillsCommandOutput(skills);
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

/** Module-level getter for active turn count. Set by createMessageHandler. */
let _getActiveTurnCount: () => number = () => 0;
export function getActiveTurnCount(): number { return _getActiveTurnCount(); }

function normalizeNonNegativeConfigInt(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.trunc(numeric);
}

function normalizePositiveConfigInt(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.trunc(numeric);
}

// Web UI turn timeout. This is an IDLE / no-progress window (see armTurnTimeout):
// it aborts a turn only after this long with NO activity signal, and every
// stream chunk / tool event re-arms it. It is NOT a wall-clock cap on total turn
// time — the brain loop owns that via tools.loops.max_elapsed_ms (600s, checked
// gracefully between iterations). The default must be >= llm_call_timeout_ms
// (300s) so a single legitimately-silent LLM call or long tool is not mistaken
// for a hang. 0 disables the guard entirely.
function resolveWebUiTurnTimeoutMs(runtimeConfig: ReturnType<typeof loadConfig> = getConfig()): number {
  const serverConfig = runtimeConfig.server as Record<string, unknown>;
  return normalizeNonNegativeConfigInt(
    serverConfig.web_ui_turn_timeout_ms
      ?? serverConfig.webUiTurnTimeoutMs
      ?? process.env.MOZI_WEB_UI_TURN_TIMEOUT_MS
      ?? process.env.MOZI_SERVER_WEB_UI_TURN_TIMEOUT_MS,
    300_000,
  );
}

function resolveMaxConcurrentSessionsPerUser(runtimeConfig: ReturnType<typeof loadConfig> = getConfig()): number {
  const serverConfig = runtimeConfig.server as Record<string, unknown>;
  return normalizePositiveConfigInt(
    serverConfig.max_concurrent_sessions_per_user
      ?? serverConfig.maxConcurrentSessionsPerUser
      ?? process.env.MOZI_MAX_CONCURRENT_SESSIONS_PER_USER
      ?? process.env.MOZI_SERVER_MAX_CONCURRENT_SESSIONS_PER_USER,
    5,
  );
}

function resolveTurnQueueKey(msg: IncomingMessage): string {
  if (msg.channelType === 'websocket') {
    return msg.sessionId ? `${msg.userId}:${msg.sessionId}` : msg.chatId;
  }
  return msg.chatId;
}

function resolveUserConcurrencyKey(msg: IncomingMessage): string {
  return `${msg.tenantId ?? 'default'}:${msg.userId || msg.chatId}`;
}

function turnTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return `Turn stopped: no progress for ${seconds}s, so MOZI treated it as stalled. Please resend your instruction. If your task legitimately has long silent steps, raise server.web_ui_turn_timeout_ms (this is the no-progress window, not a total time limit).`;
}

function abortReasonText(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : String(reason ?? '');
}

export function createMessageHandler(
  fallbackClient: LLMClient,
  startTime: Date,
  config: ReturnType<typeof loadConfig>,
  getBotRef: () => Telegraf | null,
) {
  const promptFingerprints = new Map<string, string>();
  const chatQueueTail = new Map<string, Promise<void>>();
  const chatQueueWaitingDepth = new Map<string, number>();
  const userRunningTurnCount = new Map<string, number>();
  const userConcurrencyQueues = new Map<string, Array<() => void>>();
  const activeTurnControllers = new Map<
    string,
    { controller: AbortController; startedAt: number; timeoutMs: number }
  >();
  // Wire up module-level getter so heartbeat writer can access turn count
  _getActiveTurnCount = () => activeTurnControllers.size;

  const isAbortLikeError = (err: unknown): boolean => {
    if (err instanceof Error && err.name === 'AbortError') return true;
    const message = err instanceof Error ? err.message : String(err);
    return /aborted|cancelled|canceled|timed out/i.test(message);
  };

  const resolveSystemPrompt = (tenantId?: string): string => {
    const effectiveTenantId = resolveTenantId(tenantId);
    const prompt = loadSystemPrompt(config, effectiveTenantId);
    const fingerprint = createHash('sha1').update(prompt).digest('hex');
    const previousFingerprint = promptFingerprints.get(effectiveTenantId);
    if (fingerprint !== previousFingerprint) {
      promptFingerprints.set(effectiveTenantId, fingerprint);
      logger.info(
        {
          tenantId: effectiveTenantId,
          promptLength: prompt.length,
          tools: getAllRegisteredTools(effectiveTenantId).length,
        },
        'System prompt refreshed',
      );
    }
    return prompt;
  };

  type QueueNoticeReason = 'session_busy' | 'user_concurrency_limit';
  const releaseUserTurnSlot = (userKey: string): void => {
    const queue = userConcurrencyQueues.get(userKey);
    const next = queue?.shift();
    if (queue && queue.length === 0) {
      userConcurrencyQueues.delete(userKey);
    }
    if (next) {
      next();
      return;
    }
    const running = Math.max(0, (userRunningTurnCount.get(userKey) ?? 0) - 1);
    if (running === 0) {
      userRunningTurnCount.delete(userKey);
    } else {
      userRunningTurnCount.set(userKey, running);
    }
  };
  const acquireUserTurnSlot = async (
    userKey: string,
    maxConcurrent: number,
    onQueued?: (notice: { queueDepth: number; reason: QueueNoticeReason }) => void,
  ): Promise<() => void> => {
    const existingQueue = userConcurrencyQueues.get(userKey);
    const running = userRunningTurnCount.get(userKey) ?? 0;
    if (running < maxConcurrent && (!existingQueue || existingQueue.length === 0)) {
      userRunningTurnCount.set(userKey, running + 1);
      return () => releaseUserTurnSlot(userKey);
    }

    let resume: () => void = () => {};
    const waitForSlot = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const queue = existingQueue ?? [];
    queue.push(resume);
    userConcurrencyQueues.set(userKey, queue);
    onQueued?.({ queueDepth: queue.length, reason: 'user_concurrency_limit' });
    await waitForSlot;
    return () => releaseUserTurnSlot(userKey);
  };

  const runInChatQueue = async <T>(
    queueKey: string,
    userKey: string,
    task: () => Promise<T>,
    options?: {
      maxConcurrentPerUser?: number;
      onQueued?: (notice: { queueDepth: number; reason: QueueNoticeReason }) => void;
    },
  ): Promise<T> => {
    const hadSessionWorkAhead = chatQueueTail.has(queueKey);
    const previousTail = chatQueueTail.get(queueKey) ?? Promise.resolve();
    const waitForTurn = previousTail.catch(() => undefined);
    let releaseCurrent: () => void = () => {};
    const currentTurn = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextTail = waitForTurn.then(() => currentTurn);
    chatQueueTail.set(queueKey, nextTail);
    if (hadSessionWorkAhead) {
      const queueDepth = (chatQueueWaitingDepth.get(queueKey) ?? 0) + 1;
      chatQueueWaitingDepth.set(queueKey, queueDepth);
      options?.onQueued?.({ queueDepth, reason: 'session_busy' });
    }

    await waitForTurn;
    if (hadSessionWorkAhead) {
      const queueDepth = Math.max(0, (chatQueueWaitingDepth.get(queueKey) ?? 1) - 1);
      if (queueDepth === 0) {
        chatQueueWaitingDepth.delete(queueKey);
      } else {
        chatQueueWaitingDepth.set(queueKey, queueDepth);
      }
    }
    const releaseUserSlot = await acquireUserTurnSlot(
      userKey,
      options?.maxConcurrentPerUser ?? 5,
      options?.onQueued,
    );
    try {
      return await task();
    } finally {
      releaseUserSlot();
      releaseCurrent();
      if (chatQueueTail.get(queueKey) === nextTail) {
        chatQueueTail.delete(queueKey);
      }
    }
  };

  let handlerRef: (msg: IncomingMessage) => Promise<string | null>;
  handlerRef = async (msg: IncomingMessage): Promise<string | null> => {
    const executeMessage = async (): Promise<string | null> => {
      const tenantId = msg.tenantId ?? process.env.MOZI_TENANT_ID ?? 'default';
      const rawSystemPrompt = resolveSystemPrompt(tenantId);
      const delegationSystemPrompt = loadDelegationSystemPrompt(config, tenantId);
      const systemPromptContent = adaptPromptForChannel(rawSystemPrompt, msg.channelType);

      // ── PAIRING GATE (Telegram / WeChat) ──
      // WebSocket and ACP users are already authenticated at the transport layer
      if (msg.channelType !== 'websocket' && msg.channelType !== 'acp' && !isAllowed(msg.userId, tenantId)) {
        const dmPolicy = config.telegram.dm_policy;

        if (dmPolicy === 'open') {
          // open mode: skip all access control, fall through to normal handling
        } else if (dmPolicy === 'allowlist') {
          // Strict: only pre-approved users, no pairing flow
          return '🔒 Access restricted. Contact the administrator to be added to the allowlist.';
        } else {
          // pairing (default): existing behavior
          // Try legacy token-based pairing first (backward compat)
          const role = validatePairingCode(msg.text.trim(), tenantId);
          if (role) {
            addAllowedUser(msg.userId, msg.username, role, tenantId);
            if (!isOnboardingCompleted()) {
              startSession(msg.chatId);
              const onboardResult = await processOnboardingMessage(msg.chatId, '');
              return `✅ Paired as ${role}. Welcome to your agent runtime.\n\n${onboardResult}`;
            }
            return `✅ Paired as ${role}. Welcome to your agent runtime.\nType /help for commands.`;
          }

          // Auto-create pairing request (OpenClaw style)
          const request = createPairingRequest(msg.userId, msg.username, msg.channelType, tenantId);
          if (!request) {
            return '🔒 Too many pending pairing requests. Please try again later.';
          }

          const existingHint = request.isExisting ? '\n\n⚠️ This is your existing pairing code (still valid).' : '';
          const channelLabel = msg.channelType === 'wechat' ? 'WeChat ID' : 'Telegram ID';
          return [
            `📱 Your ${channelLabel}: ${msg.userId}`,
            `🔑 Pairing code: ${request.code}`,
            '',
            'Run this in your server terminal:',
            `  pnpm mozi pair approve ${request.code}`,
            '',
            'The pairing code expires in 1 hour.',
            existingHint,
          ].join('\n').trim();
        }
      }

      // ── ONBOARDING ──
      if (isOnboarding(msg.chatId)) {
        return await processOnboardingMessage(msg.chatId, msg.text);
      }

      // ── COMMANDS ──
      if (msg.isCommand) {
        // RBAC check — deny unauthorized commands before execution
        try {
          checkCommandAccess(tenantId, msg.userId, msg.command ?? '');
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return `Access denied: you don't have permission to use /${msg.command}.`;
          }
          throw err;
        }

        switch (msg.command) {
        case 'start': {
          if (!isOnboardingCompleted()) {
            startSession(msg.chatId);
            return await processOnboardingMessage(msg.chatId, '');
          }
          return 'The runtime is ready. Type /help for commands, or just send a message.';
        }
        case 'onboard': {
          // Force re-run bootstrap to reload preset skills/agents
          const bootstrapDir = join(runtimeRoot, 'bootstrap');
          const bootstrapMsg = handleOnboardCommand(bootstrapDir);
          logger.info(bootstrapMsg);
          // Then start the onboarding wizard
          startSession(msg.chatId);
          const wizardMsg = await processOnboardingMessage(msg.chatId, '');
          return `${bootstrapMsg}\n\n${wizardMsg}`;
        }
        case 'pair': {
          const token = startPairing('user', tenantId);
          return `🔐 Pairing token (user role):\n\n${token}\n\nValid for 30 minutes. Send from the new user's chat.`;
        }
        case 'users':
          return getAllowedUsers(tenantId).map(u => `${u.role}: ${u.username} (${u.user_id})`).join('\n') || 'No paired users.';
        case 'status':
          return handleStatus(startTime);
        case 'capabilities':
          return handleCapabilities(config, tenantId, msg.userId);
        case 'help':
          return handleHelp();
        case 'steer': {
          // Mid-run nudge bound to the authoritative active turn generation.
          const { enqueueSteer } = await import('./gateway/steer-store.js');
          const activeTurn = getActiveTurnForChat(msg.chatId, tenantId);
          if (!activeTurn) {
            return '✗ Steer rejected: no active turn. Send a normal message to start a new request.';
          }
          const steerText = msg.commandArgs ?? '';
          // Alias lookup (for example user:sessionId on the first Web turn)
          // resolves to the turn's canonical execution scope. Queue under that
          // scope so Brain drain and synchronous expiry use the identical key.
          const result = enqueueSteer(tenantId, activeTurn.chatId, activeTurn.turnId, steerText);
          if (result.accepted) {
            return '✓ Steer queued for the current turn. It applies only if this turn reaches another Brain boundary; otherwise it is discarded when the turn ends.';
          }
          const reasonText = ({
            empty: 'empty message. Usage: /steer <nudge>',
            not_string: 'invalid input',
            too_long: 'message too long (max 500 chars)',
            rate_limited: 'too many steers queued for this turn (max 3)',
          } as const)[result.reason ?? 'not_string'] ?? 'unknown reason';
          return `✗ Steer rejected: ${reasonText}`;
        }
        case 'tasks':
          return formatTasksCommandOutput({
            tenantId,
            args: msg.commandArgs ?? '',
          });
        case 'cancel': {
          const taskId = msg.commandArgs?.trim();
          if (!taskId) {
            const active = activeTurnControllers.get(msg.chatId);
            if (!active) return 'No active turn to cancel. Usage: /cancel <task_id> for DAG tasks.';
            active.controller.abort(new Error('Cancelled by user via /cancel'));
            return 'Cancellation requested for the current in-flight turn.';
          }
          const { requestTaskCancellation } = await import('./core/task-cancellation.js');
          const result = await requestTaskCancellation(taskId, {
            tenantId,
            requestedBy: msg.userId,
            reason: 'user_command',
            chatId: msg.chatId,
          });
          if (!result.ok) {
            return result.status === 'not_found'
              ? `Task not found: ${taskId}`
              : `Failed to cancel task ${taskId}: ${result.message}`;
          }
          return result.status === 'already_cancelled'
            ? `Task already cancelling: ${taskId}`
            : `Cancellation requested: ${taskId}`;
        }
        case 'agents':
          return 'Agents: coder (preset), reviewer (preset)';
        case 'skills':
          return await handleSkills(config, tenantId);
        case 'config':
          return handleConfigCommand(msg.commandArgs ?? '');
        case 'approve': {
          const parts = (msg.commandArgs ?? '').trim().split(/\s+/).filter(Boolean);
          const requestId = parts[0];
          const grantScope = parts[1] === 'session' ? 'session' : parts[1] === 'once' ? 'once' : undefined;
          if (!requestId) {
            const pending = getPendingRequests(tenantId);
            if (pending.length === 0) return 'No pending approval requests.';
            return [
              'Pending approval requests:',
              ...pending.map((req) => `- ${req.id} | ${req.action} | ${req.description}`),
              'Use /approve <ID> to approve or /reject <ID> to reject.',
            ].join('\n');
          }
          try {
            const approved = approveRequest(requestId, msg.userId, tenantId, grantScope ? { grantScope } : undefined);
            return `Approved ${approved.id}\nAction: ${approved.action}\nDescription: ${approved.description}`;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to approve request: ${message}`;
          }
        }
        case 'reject': {
          const requestId = msg.commandArgs?.trim();
          if (!requestId) return 'Usage: /reject <ID>';
          try {
            const rejected = rejectRequest(requestId, msg.userId, tenantId);
            return `Rejected ${rejected.id}\nAction: ${rejected.action}\nDescription: ${rejected.description}`;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to reject request: ${message}`;
          }
        }
        case 'budget':
          return 'Token budget: no active sessions. Watermarks: 70% soft / 85% hard / 95% rotate.';
        default:
          return `Unknown command: /${msg.command}. Type /help for available commands.`;
        }
      }

      // ── FIRST-MESSAGE PROFILE COLLECTION ──
      // On a user's first real conversation after onboarding, nudge the Brain
      // to warmly greet the user and learn about them.
      let effectiveSystemPrompt = systemPromptContent;
      const profileKey = `user_profile_collected.${msg.userId}`;
      if (!getBootstrapState(profileKey)) {
        const profileNudge = [
          '',
          '--- FIRST CONVERSATION ---',
          'This is the user\'s very first message after setting up MOZI.',
          'Warmly welcome them and naturally learn about them during the conversation:',
          '- How they\'d like to be addressed (name/nickname)',
          '- Their primary role or profession',
          '- What they mainly want to use MOZI for',
          '- Their preferred language for communication',
          '',
          'Weave these questions naturally into the greeting — don\'t interrogate.',
          'Remember their answers using the remember tool for future sessions.',
          'After collecting basic info, help them with whatever they asked.',
          '--- END FIRST CONVERSATION ---',
        ].join('\n');
        effectiveSystemPrompt = systemPromptContent + profileNudge;
        setBootstrapState(profileKey, 'true');
      }

      // ── CONVERSATION — routed through Gateway + Brain ──
      // Create channel-appropriate progress callback and optional OutputChannel
      let progress: ProgressCallback | undefined;
      let cleanup: (() => Promise<void>) | undefined;
      let outputChannel: TelegramOutputChannel | undefined;
      // Late-bound by the timeout setup below. Web UI progress hooks call this on
      // every activity signal so the turn timeout behaves as an idle/no-progress
      // window rather than a wall-clock cap — an actively working turn is never
      // killed. No-op until wired (and for channels that don't reset on activity).
      let markTurnActivity: () => void = () => {};

      const telegramBot = getBotRef();
      if (msg.channelType === 'telegram' && telegramBot) {
        outputChannel = new TelegramOutputChannel(telegramBot, msg.chatId);
        const tg = createTelegramProgress(telegramBot, msg.chatId, outputChannel);
        progress = tg.progress;
        cleanup = tg.cleanup;

        // Wire event bus -> Telegram DAG progress
        const bridge = createTelegramProgressBridge(telegramBot, msg.chatId);
        bridge.start();
        const originalCleanup = cleanup;
        cleanup = async () => {
          await bridge.stop();
          await originalCleanup();
        };
      }

      let wsStreamed = false;
      if (msg.channelType === 'websocket') {
        let wsStreamStarted = false;
        let wsLastStreamText = '';
        let wsStreamSegment = 0;
        const supportsArtifacts = msg.clientCapabilities?.includes('artifact_v1') === true;
        const requestBaseId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let requestId = `${requestBaseId}-${wsStreamSegment}`;
        const advanceStreamSegment = () => {
          wsStreamSegment += 1;
          requestId = `${requestBaseId}-${wsStreamSegment}`;
          wsLastStreamText = '';
        };
        progress = {
          // Early session binding (Issue #627). handleMessage fires this once,
          // before any stream/artifact frame, when it resolves a session the
          // client did not name (brand-new Web chat). Bind the originating
          // socket so its session-scoped filter accepts the frames that follow;
          // targeted at that one connection, so other tabs are untouched.
          onSessionResolved: (sessionId: string) => {
            bindResolvedSessionToConnection({
              connectionId: msg.originConnectionId,
              sessionId,
              userId: msg.userId,
              tenantId: msg.tenantId,
            });
          },
          onProcessingStart: () => {
            markTurnActivity();
            if (wsStreamStarted) return;
            wsStreamStarted = true;
            broadcastStreamEvent('stream_start', requestId, undefined, msg.userId, msg.sessionId, msg.tenantId);
          },
          onToolStart: () => { markTurnActivity(); },
          onToolEnd: () => { markTurnActivity(); },
          onStreamChunk: (accumulated: string) => {
            markTurnActivity();
            if (accumulated.trim().length === 0) {
              return;
            }
            wsLastStreamText = accumulated;
            if (!wsStreamStarted) {
              wsStreamStarted = true;
              broadcastStreamEvent('stream_start', requestId, undefined, msg.userId, msg.sessionId, msg.tenantId);
            }
            broadcastStreamEvent('stream_chunk', requestId, accumulated, msg.userId, msg.sessionId, msg.tenantId);
          },
          onStreamEnd: (fullText: string) => {
            markTurnActivity();
            const hasVisibleText = fullText.trim().length > 0;
            // The brain loop emits the final segment's stream_end itself, and the
            // gateway handler re-fires onStreamEnd with the same text as a safety
            // net for non-streaming paths. Emitting both sends the client two
            // identical stream_end frames for one turn — drop the duplicate.
            if (hasVisibleText && wsStreamed && fullText === wsLastStreamText) {
              return;
            }
            if (!hasVisibleText) {
              if (wsStreamStarted) {
                // Tool-call turns end the current stream with empty text. Preserve
                // any visible preface as its own assistant message; otherwise clear
                // the empty placeholder.
                broadcastStreamEvent('stream_end', requestId, wsLastStreamText, msg.userId, msg.sessionId, msg.tenantId);
                wsStreamStarted = false;
                advanceStreamSegment();
              }
              // Do not mark as streamed; final response may still come via normal message path.
              return;
            }
            wsLastStreamText = fullText;
            if (!wsStreamStarted) {
              wsStreamStarted = true;
              broadcastStreamEvent('stream_start', requestId, undefined, msg.userId, msg.sessionId, msg.tenantId);
            }
            wsStreamed = true;
            broadcastStreamEvent('stream_end', requestId, fullText, msg.userId, msg.sessionId, msg.tenantId);
          },
          onStreamReset: () => {
            markTurnActivity();
            if (!wsStreamStarted) return;
            // A retry must remove the incomplete segment instead of finalizing
            // wsLastStreamText as a durable assistant message.
            broadcastStreamEvent('stream_end', requestId, '', msg.userId, msg.sessionId, msg.tenantId);
            wsStreamStarted = false;
            advanceStreamSegment();
          },
          onArtifact: (event) => {
            markTurnActivity();
            if (!supportsArtifacts) return;
            broadcastArtifactEvent(event, msg.userId, msg.sessionId, msg.tenantId);
          },
        };
      }

      const turnAbortController = new AbortController();
      const interactiveTurnTimeoutMs = msg.channelType === 'telegram'
        ? Math.max(0, Math.trunc(getConfig().telegram.interactive_turn_timeout_ms))
        : msg.channelType === 'websocket'
          ? resolveWebUiTurnTimeoutMs(config)
          : 0;
      let turnTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let webSocketTimeoutNotified = false;

      // Abort previous turn for this chat if still active (prevents AbortController leak)
      const previousTurn = activeTurnControllers.get(msg.chatId);
      if (previousTurn) {
        logger.warn({ chatId: msg.chatId, previousStartedAt: previousTurn.startedAt }, 'Aborting previous turn superseded by new message');
        previousTurn.controller.abort(new Error('Turn superseded by new message'));
      }

      activeTurnControllers.set(msg.chatId, {
        controller: turnAbortController,
        startedAt: Date.now(),
        timeoutMs: interactiveTurnTimeoutMs,
      });

      const armTurnTimeout = () => {
        if (interactiveTurnTimeoutMs <= 0) return;
        if (turnTimeoutHandle) clearTimeout(turnTimeoutHandle);
        turnTimeoutHandle = setTimeout(() => {
          const timeoutError = new Error(`Turn timed out after ${interactiveTurnTimeoutMs}ms`);
          turnAbortController.abort(timeoutError);
          if (msg.channelType === 'websocket') {
            webSocketTimeoutNotified = true;
            broadcastTurnTimeoutEvent({
              targetUserId: msg.userId,
              tenantId: msg.tenantId,
              sessionId: msg.sessionId,
              message: turnTimeoutMessage(interactiveTurnTimeoutMs),
            });
          }
        }, interactiveTurnTimeoutMs);
      };

      if (interactiveTurnTimeoutMs > 0) {
        armTurnTimeout();
        // Web UI: the timeout is an IDLE / no-progress window, not a wall-clock
        // cap. Any turn activity (stream chunk, tool start/end, artifact) re-arms
        // it, so a turn that keeps making progress is never killed — only a
        // genuinely stalled turn (no signal for the whole window) aborts. The
        // brain loop still owns the graceful end-to-end budget (max_elapsed_ms).
        if (msg.channelType === 'websocket') {
          markTurnActivity = () => {
            if (turnAbortController.signal.aborted) return;
            armTurnTimeout();
          };
        }
      }

      try {
        const result = await handleMessage(
          msg,
          effectiveSystemPrompt,
          fallbackClient,
          progress,
          outputChannel,
          turnAbortController.signal,
          delegationSystemPrompt,
        );
        if (
          msg.channelType === 'websocket'
          && interactiveTurnTimeoutMs > 0
          && /turn timed out after/i.test(abortReasonText(turnAbortController.signal))
        ) {
          return webSocketTimeoutNotified ? null : turnTimeoutMessage(interactiveTurnTimeoutMs);
        }
        // Clean up status messages before returning the final response
        if (cleanup) await cleanup();

        // Detect silent provider failures: streaming was attempted but produced
        // no visible content (e.g. auth error swallowed by Vercel AI SDK streamText).
        // In this case, return an error message instead of silently returning null.
        if (wsStreamed && (!result || !result.trim())) {
          return 'Request failed: the AI provider returned an empty response. This usually means the API key is invalid or the account has no remaining quota. Check your provider configuration in ~/.mozi/mozi.json and ~/.mozi/.env.';
        }

        // When OutputChannel is used, handler sends directly and returns null.
        // When streaming (WebSocket) already sent the response, also return null.
        if (outputChannel || wsStreamed || !result) {
          return null;
        }
        return result;
      } catch (err) {
        if (cleanup) await cleanup();
        const message = extractRecoveryErrorText(err) || (err instanceof Error ? err.message : String(err));
        if (isAbortLikeError(err)) {
          const isInteractiveTimeoutAbort = /turn timed out after/i.test(message);
          let timeoutAutoTuned = false;
          let nextInteractiveTurnTimeoutMs = interactiveTurnTimeoutMs;
          if (isInteractiveTimeoutAbort && msg.channelType === 'telegram' && interactiveTurnTimeoutMs > 0) {
            try {
              const tuned = reportTimeoutAndMaybeTune({
                scope: 'gateway',
                tenantId: msg.tenantId ?? 'default',
                chatId: msg.chatId,
                observedInteractiveTurnTimeoutMs: interactiveTurnTimeoutMs,
                observedLoopTimeoutMs: getConfig().tools.loops.max_elapsed_ms,
                detail: message,
              });
              if (tuned.applied) {
                timeoutAutoTuned = true;
                nextInteractiveTurnTimeoutMs = tuned.nextInteractiveTurnTimeoutMs;
                logger.warn({
                  chatId: msg.chatId,
                  tenantId: msg.tenantId ?? 'default',
                  previousInteractiveTurnTimeoutMs: tuned.previousInteractiveTurnTimeoutMs,
                  nextInteractiveTurnTimeoutMs: tuned.nextInteractiveTurnTimeoutMs,
                }, 'Autonomous timeout tuning applied after turn timeout');
              }
            } catch (tuneErr) {
              logger.warn({
                chatId: msg.chatId,
                err: tuneErr instanceof Error ? tuneErr.message : String(tuneErr),
              }, 'Autonomous timeout tuning failed after turn timeout');
            }
          }
          logger.warn({ err: message, chatId: msg.chatId }, 'Message handling cancelled');
          if (isInteractiveTimeoutAbort && msg.channelType === 'websocket') {
            return webSocketTimeoutNotified ? null : turnTimeoutMessage(interactiveTurnTimeoutMs);
          }
          if (timeoutAutoTuned) {
            return `Current request timed out before completion. MOZI automatically increased the interactive timeout to ${nextInteractiveTurnTimeoutMs}ms. Please resend your instruction.`;
          }
          return 'Current request was cancelled. Please send your latest instruction again.';
        }
        logger.error({ err: message, chatId: msg.chatId }, 'Message handling failed');

        // If the error is a fatal DB error (disk full, corruption, etc.), exit
        // so the watchdog can restart the process after the underlying issue is resolved.
        if (isDatabaseFatalError(err)) {
          logger.fatal({ err: message, chatId: msg.chatId }, 'Fatal database error during message handling — exiting for watchdog restart');
          process.exit(1);
        }

        // Default: deterministic English error response (no extra token usage).
        // Optional: keep LLM self-recovery behind explicit opt-in.
        if (process.env.MOZI_LLM_SELF_RECOVERY === '1') {
          try {
            const recoveryPrompt = [
              { role: 'system' as const, content: 'You are a local agent runtime assistant. Output MUST be concise English. Do not switch language unless user explicitly asked in this request. Explain the failure in simple terms and give one or two actionable next steps. Never expose raw stack traces.' },
              { role: 'user' as const, content: `User's original message: ${msg.text?.slice(0, 500) ?? '(unknown)'}\n\nInternal error (do NOT show this to user): ${message}` },
            ];
            const recovery = await fallbackClient.chat(recoveryPrompt, { max_tokens: 160, temperature: 0.2 });
            if (recovery.content?.trim()) {
              logger.info({ chatId: msg.chatId }, 'Self-recovery response generated');
              return recovery.content.trim();
            }
          } catch (recoveryErr) {
            const recoveryMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
            logger.warn({ chatId: msg.chatId, err: recoveryMsg }, 'Self-recovery also failed');
          }
        }

        return buildDeterministicRecoveryMessage(message);
      } finally {
        if (turnTimeoutHandle) {
          clearTimeout(turnTimeoutHandle);
          turnTimeoutHandle = null;
        }
        const active = activeTurnControllers.get(msg.chatId);
        if (active?.controller === turnAbortController) {
          activeTurnControllers.delete(msg.chatId);
        }
  
      }
    };

    if (msg.isCommand && (msg.command === 'cancel' || msg.command === 'steer')) {
      logger.info({ chatId: msg.chatId, userId: msg.userId, command: msg.command }, 'Bypassing chat queue for active-turn command');
      return executeMessage();
    }

    const queueKey = resolveTurnQueueKey(msg);
    const userKey = resolveUserConcurrencyKey(msg);
    const onQueued = msg.channelType === 'websocket'
      ? ({ queueDepth, reason }: { queueDepth: number; reason: QueueNoticeReason }) => {
          broadcastTurnQueuedEvent({
            targetUserId: msg.userId,
            tenantId: msg.tenantId,
            sessionId: msg.sessionId,
            queueDepth,
            reason,
          });
        }
      : undefined;
    return runInChatQueue(queueKey, userKey, executeMessage, {
      maxConcurrentPerUser: resolveMaxConcurrentSessionsPerUser(config),
      onQueued,
    });
  };

  /**
   * Abort all active turn controllers and wait for them to settle.
   * Used during graceful shutdown to avoid killing the process mid-DB-write.
   */
  const drainActiveTurns = async (maxWaitMs = 5000): Promise<void> => {
    // Abort through the turn-cancellation registry — the signal the brain loop
    // actually listens to. Each aborted handler publishes a truthful CANCELLED
    // marker to connected clients and settles its DB writes before we exit.
    const cancelled = cancelAllRunningTurns('Runtime restarting');
    // Belt and braces: also abort caller-side controllers (now wired into the
    // handler via AbortSignal.any) for anything registered only here.
    for (const [chatId, entry] of activeTurnControllers) {
      try {
        entry.controller.abort(new Error('Runtime restarting'));
      } catch { /* best-effort */ }
      logger.info({ chatId }, 'Aborted active turn for shutdown drain');
    }
    if (cancelled === 0 && activeTurnControllers.size === 0) return;
    logger.info({ registryTurns: cancelled, callerTurns: activeTurnControllers.size }, 'Draining active turns before shutdown');
    const deadline = Date.now() + maxWaitMs;
    while ((getRunningTurnCount() > 0 || activeTurnControllers.size > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (getRunningTurnCount() > 0 || activeTurnControllers.size > 0) {
      logger.warn({
        registryRemaining: getRunningTurnCount(),
        callerRemaining: activeTurnControllers.size,
      }, 'Some turns did not drain within deadline');
    }
  };

  return { handler: handlerRef, drainActiveTurns };
}

// ---------------------------------------------------------------------------
// Temp file cleanup
// ---------------------------------------------------------------------------

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Remove temp files older than TEMP_MAX_AGE_MS */
function cleanupTempFiles(config: ReturnType<typeof loadConfig>): void {
  const tempDir = join(resolveWorkspaceDir(config), 'tmp');
  if (!existsSync(tempDir)) return;
  try {
    const now = Date.now();
    let cleaned = 0;
    for (const file of readdirSync(tempDir)) {
      const filePath = join(tempDir, file);
      try {
        const stats = statSync(filePath);
        if (stats.isFile() && now - stats.mtimeMs > TEMP_MAX_AGE_MS) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch { /* skip individual file errors */ }
    }
    if (cleaned > 0) {
      logger.info({ cleaned, dir: tempDir }, 'Cleaned up old temp files');
    }
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Temp cleanup skipped');
  }
}

function startWorkspaceEventWatcher(workspaceDir: string): () => void {
  let watcher: ReturnType<typeof watch> | null = null;
  let lastEmitAt = 0;
  try {
    watcher = watch(workspaceDir, { recursive: true }, (eventType, filename) => {
      const now = Date.now();
      if (now - lastEmitAt < 500) return;
      lastEmitAt = now;

      const normalizedPath = typeof filename === 'string' ? filename : '(unknown)';
      if (
        normalizedPath.includes('/.git/')
        || normalizedPath.startsWith('.git/')
        || normalizedPath.includes('/node_modules/')
        || normalizedPath.startsWith('node_modules/')
      ) {
        return;
      }

      pushEvent({
        type: 'workspace:file_change',
        summary: `${eventType}: ${normalizedPath.slice(0, 240)}`,
        data: {
          eventType,
          path: normalizedPath,
        },
      });
    });
    watcher.on('error', (err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Workspace file watcher error');
    });
    logger.info({ workspaceDir }, 'Workspace file watcher started');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start workspace file watcher');
  }

  return () => {
    if (!watcher) return;
    watcher.close();
    watcher = null;
    logger.info('Workspace file watcher stopped');
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = new Date();
  const isACPMode = process.env.MOZI_MODE === 'acp';

  const build = getBuildInfo();
  logger.info({ build }, `MOZI v${build.version} — Autonomous Agent OS${isACPMode ? ' (ACP mode)' : ''}`);
  logger.info('Starting...');

  ensureMoziHome();

  // PID file — skip in ACP mode (multiple ACP instances can coexist, each spawned by an IDE)
  if (!isACPMode) {
    const pidClaim = claimPidFile();
    if (!pidClaim.ok) {
      logger.error({ running_pid: pidClaim.existingPid }, 'MOZI is already running. Use `pnpm mozi stop` before starting another instance.');
      process.exit(1);
    }
  }

  // Migrate legacy env vars (e.g. OPENAI_API_KEY+OPENAI_BASE_URL=minimax → MINIMAX_API_KEY)
  const migration = migrateEnvVars();
  if (migration.migrated.length > 0) {
    logger.info({ migrated: migration.migrated }, 'Migrated legacy env vars');
  }
  if (migration.warnings.length > 0) {
    logger.warn({ warnings: migration.warnings }, 'Migration warnings');
  }

  // Quarantine an unkeyed skill-runtime python tree from an older install. These
  // live in the data home, so they survive App upgrades and can shadow the
  // bundled interpreter with foreign-architecture packages. Restart is the
  // upgrade path (Constitution §15), so this repair belongs here rather than in
  // a manual step. The tree is renamed, never deleted.
  const pythonQuarantine = quarantineLegacyPythonRuntime();
  if (pythonQuarantine.quarantined) {
    logger.warn(
      { moved_to: pythonQuarantine.movedTo },
      'Quarantined a legacy skill-runtime python tree; skill pip dependencies will be reinstalled into an architecture-keyed overlay on next use',
    );
  }

  const config = loadConfig();
  logger.info({
    config_path: getConfigPath(),
    workspace_dir: resolveWorkspaceDir(config),
    brain_model: config.brain.model,
    server_port: config.server.port,
    telegram: config.telegram.bot_token ? 'configured' : 'not configured',
    wechat: config.wechat.bot_token ? 'configured' : 'not configured',
  }, 'Config loaded');

  // Migrate workspace templates from copy-on-init to layered pattern
  const workspaceDir = resolveWorkspaceDir(config);
  if (existsSync(workspaceDir)) {
    migrateWorkspaceTemplates(workspaceDir);
  }

  initTel();
  logger.info('TEL execution layer ready');

  initDb();
  runMigrations();
  try {
    const billingPricing = await refreshPricingAndReprice();
    logger.info(billingPricing, 'Billing price catalog refreshed and historical usage repriced');
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Billing price refresh failed; retained the last persisted price snapshots');
  }
  loadDynamicToolsFromDb();
  logger.info('Database initialized');

  // Terminalize artifacts left `running` by a previous process: opened implies
  // eventually terminal, so an interrupted stream must render as failed, not spin.
  try {
    const { terminalizeStaleRunningArtifacts, removeRuntimeDiagnosticTimelineItems } = await import('./memory/session-timeline.js');
    const { terminalizeStaleActiveTurns } = await import('./memory/turn-envelopes.js');
    const terminalized = terminalizeStaleRunningArtifacts();
    const removedDiagnostics = removeRuntimeDiagnosticTimelineItems();
    // Turn envelopes left `active`/`awaiting_approval` by a dead process are
    // interrupted, not in flight — flip them so a reload shows honest state.
    const interruptedTurns = terminalizeStaleActiveTurns();
    if (terminalized > 0) {
      logger.info({ count: terminalized }, 'Terminalized stale running artifacts from previous run');
    }
    if (interruptedTurns > 0) {
      logger.info({ count: interruptedTurns }, 'Terminalized stale active turn envelopes from previous run');
    }
    if (removedDiagnostics > 0) {
      logger.info({ count: removedDiagnostics }, 'Removed legacy runtime diagnostic chat rows');
    }
  } catch (sweepErr) {
    logger.warn(
      { err: sweepErr instanceof Error ? sweepErr.message : String(sweepErr) },
      'Startup artifact terminalization failed',
    );
  }

  // Prune stale data on startup
  try {
    const { pruneStaleData } = await import('./store/retention.js');
    const pruneResult = pruneStaleData();
    logger.info({ pruneResult }, 'Startup data retention completed');
  } catch (pruneErr) {
    logger.warn({ err: pruneErr instanceof Error ? pruneErr.message : String(pruneErr) }, 'Startup data retention failed');
  }

  // Connect SSRF guard to config (tools.network.*)
  const { configure: configureSsrf } = await import('./security/ssrf-guard.js');
  configureSsrf({
    enabled: config.tools.network.ssrf_protection,
    block_private_ips: config.tools.network.block_private_ips,
    block_metadata_endpoints: config.tools.network.block_metadata_endpoints,
    allowed_internal_hosts: config.tools.network.allowed_internal_hosts,
    dns_rebinding_protection: config.tools.network.dns_rebinding_protection,
  });
  logger.info('SSRF guard configured from config');

  // Start heartbeat writer so the watchdog process can monitor us
  const { startHeartbeatWriter } = await import('./watchdog/index.js');
  startHeartbeatWriter(undefined, undefined, getActiveTurnCount);
  logger.info('Heartbeat writer started');

  // Audit log: record that secrets were loaded during startup
  const secretsLoadedCount = (globalThis as Record<string, unknown>).__moziSecretsLoadedCount;
  if (typeof secretsLoadedCount === 'number' && secretsLoadedCount > 0) {
    try {
      const { log: logEvent } = await import('./store/events.js');
      logEvent('secret_loaded', 'secret', '*', { count: secretsLoadedCount });
    } catch { /* DB may not have event_log table yet */ }
    delete (globalThis as Record<string, unknown>).__moziSecretsLoadedCount;
  }

  // Crash recovery — check if previous shutdown was clean
  if (!wasCleanShutdown()) {
    const report = crashRecover();
    const msg = formatRecoveryMessage(report);
    if (msg) logger.warn({ report }, msg);
  }
  setCleanShutdown(false); // Mark as unclean until graceful exit

  // Reap stale worker jobs orphaned by previous process
  {
    const { reapStaleWorkerJobs } = await import('./workers/job-state.js');
    const reaped = reapStaleWorkerJobs();
    if (reaped > 0) {
      logger.warn({ reaped }, 'Reaped stale in-flight worker jobs from previous process');
    }
  }

  // Cold bootstrap — register preset skills and agents on first run
  const bootstrapDir = join(runtimeRoot, 'bootstrap');
  const bootstrapResult = runBootstrap(bootstrapDir);
  if (!bootstrapResult.alreadyCompleted) {
    logger.info({ skills: bootstrapResult.skillsLoaded, agents: bootstrapResult.agentsLoaded }, 'Bootstrap completed');
  }
  const bootstrapSkillsLoaded = loadBootstrapSkills(bootstrapDir);
  if (bootstrapSkillsLoaded > 0) {
    logger.info({ skills: bootstrapSkillsLoaded }, 'Bootstrap skills synchronized');
  }
  const bootstrapAgentsLoaded = loadBootstrapAgents(bootstrapDir);
  if (bootstrapAgentsLoaded > 0) {
    logger.info({ agents: bootstrapAgentsLoaded }, 'Bootstrap agents synchronized');
  }

  // Load user workspace skills (runs every startup, not gated by onboarding)
  const workspaceSkillsLoaded = loadWorkspaceSkills(workspaceDir);
  if (workspaceSkillsLoaded > 0) {
    logger.info({ skills: workspaceSkillsLoaded }, 'Workspace skills loaded');
  }
  const workspaceAgentsLoaded = loadWorkspaceAgents(workspaceDir);
  if (workspaceAgentsLoaded > 0) {
    logger.info({ agents: workspaceAgentsLoaded }, 'Workspace agents loaded');
  }

  // Periodic workspace skill hot-reload (every 60s)
  const WORKSPACE_SKILL_SCAN_INTERVAL_MS = 60_000;
  const workspaceSkillTimer = setInterval(() => {
    try {
      const newSkills = loadWorkspaceSkills(workspaceDir);
      if (newSkills > 0) {
        logger.info({ skills: newSkills }, 'Hot-reloaded workspace skills');
      }
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Workspace skill scan failed');
    }
  }, WORKSPACE_SKILL_SCAN_INTERVAL_MS);

  // Clean up temp files older than 24 hours
  cleanupTempFiles(config);
  const stopWorkspaceWatcher = startWorkspaceEventWatcher(workspaceDir);

  // Start MCP bridge if configured
  let mcpBridge: MCPBridge | null = null;
  const mcpServerCount = Object.keys(config.mcp?.servers ?? {}).length;
  if (mcpServerCount > 0) {
    try {
      mcpBridge = createMCPBridge(config.mcp);
      await mcpBridge.start();
      const connectedServers = mcpBridge.listServers().filter(s => s.connected);
      const totalTools = Object.keys(mcpBridge.getTools()).length;
      logger.info({ servers: connectedServers.length, tools: totalTools }, 'MCP bridge started');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'MCP bridge startup failed — continuing without MCP');
      mcpBridge = null;
    }
  }
  setMCPBridge(mcpBridge);

  // Use brain model from config via model-router (not hardcoded)
  const brainProvider = config.model_router?.brain_provider ?? '';
  const brainModel = config.brain.model;

  // Create failover-aware LLM client and inject into model-router
  const failoverManager = createDefaultFailoverManager();
  setFailoverManager(failoverManager);
  // A fresh install has no brain provider yet. The server must still boot so
  // web onboarding / Settings / the admin console can configure one — the
  // deferred client re-resolves from live config on every call, so finishing
  // onboarding activates the brain without a process restart.
  const llmClient = brainProvider
    ? createLLMClient(brainProvider, {
      model: brainModel,
      configProviders: config.providers as Record<string, { apikey?: string; baseurl?: string }>,
    })
    : createDeferredLLMClient(() => {
      const liveConfig = getConfig();
      const liveProvider = liveConfig.model_router?.brain_provider ?? '';
      if (!liveProvider) return null;
      return createLLMClient(liveProvider, {
        model: liveConfig.brain.model,
        configProviders: liveConfig.providers as Record<string, { apikey?: string; baseurl?: string }>,
      });
    });
  if (brainProvider) {
    logger.info({ provider: brainProvider, model: brainModel, failover: 'enabled' }, 'LLM client ready');
  } else {
    logger.warn('No brain model configured — starting in setup mode; complete onboarding to activate the brain');
  }

  const runtimeTenantId = process.env.MOZI_TENANT_ID ?? 'default';
  if (!hasAnyPairedUsers(runtimeTenantId)) {
    logger.warn('No paired users — send a message to the Telegram bot to start pairing');
    console.log('\n⚠️  No paired users. Send a message to the Telegram bot to get a pairing code.\n');
  } else {
    const users = getAllowedUsers(runtimeTenantId);
    logger.info({ tenantId: runtimeTenantId, paired_users: users.length }, 'Paired users loaded');
  }

  // Mutable ref so handler closure can access bot for progress callbacks
  let bot: Telegraf | null = null;
  const { handler, drainActiveTurns } = createMessageHandler(llmClient, startTime, config, () => bot);
  let bgRunner: { start: () => void; stop: () => void; waitForIdle: () => Promise<void> } | null = null;

  const startBackgroundExecutor = async (): Promise<void> => {
    if (bgRunner) return;
    const { BackgroundJobRunner, registerBuiltinHandlers } = await import('./background-executor/index.js');
    registerBuiltinHandlers();
    bgRunner = new BackgroundJobRunner({ tenantId: runtimeTenantId });
    bgRunner.start();
    logger.info('BackgroundJobRunner started with built-in handlers');
  };

  const stopBackgroundExecutor = async (): Promise<void> => {
    if (!bgRunner) return;
    bgRunner.stop();
    await bgRunner.waitForIdle();
    bgRunner = null;
  };

  // ── ACP MODE: start stdio JSON-RPC server, skip Telegram/Fastify/scheduler ──
  if (isACPMode) {
    await startBackgroundExecutor();
    const { startACPServer } = await import('./channels/acp.js');
    startACPServer(handler, {
      userId: process.env.MOZI_ACP_USER_ID,
      tenantId: process.env.MOZI_ACP_TENANT_ID || 'default',
    });
    logger.info('ACP server started on stdio (JSON-RPC 2.0 over NDJSON)');

    // Graceful shutdown for ACP mode
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'ACP shutting down...');
      await drainActiveTurns(5000);
      await stopBackgroundExecutor();
      if (mcpBridge) {
        await mcpBridge.shutdown().catch(() => {});
      }
      clearInterval(workspaceSkillTimer);
      stopWorkspaceWatcher();
      failoverManager.destroy();
      closeDb();
      logger.info('ACP shutdown complete');
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return; // Skip Telegram, Fastify, scheduler, agent loop
  }

  if (config.telegram.bot_token) {
    if (config.telegram.dm_policy === 'open') {
      logger.warn('Telegram dm_policy is "open" — all DMs accepted without pairing');
    }
    try {
      const adapter = createTelegramAdapter(config.telegram.bot_token, handler);
      bot = adapter.bot;
      void launchTelegramWithRetry(adapter).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'Failed to start Telegram bot');
      });
      // Register bot commands with Telegram (non-blocking)
      void setBotCommands(config.telegram.bot_token);
      logger.info('Telegram bot initialization scheduled');

      // Register Telegram as a proactive notification sender
      registerSender(async (chatId, text) => {
        if (!isTelegramChatId(chatId)) return false;
        await tgSendDirectMessage(bot!, chatId, text);
        return true;
      }, 'telegram');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to start Telegram bot');
    }
  } else {
    logger.warn('No Telegram bot token configured — skipping');
  }

  registerScheduledTasks(runtimeTenantId);

  // Start background job runner
  await startBackgroundExecutor();

  if (bot) {
    scheduleTask({
      id: 'pairing_notify',
      name: 'Pairing Approval Notifier',
      interval_minutes: 0.1, // Check every 6 seconds for responsive UX
      run: async () => {
        const approved = consumeApprovedRequests(runtimeTenantId);
        for (const user of approved) {
          if (user.channelType === 'telegram') {
            await tgSendDirectMessage(bot!, user.userId, '✅ Pairing approved! Welcome to your agent runtime.\nType /help to see available commands.');
            logger.info({ userId: user.userId, username: user.username }, 'Sent pairing approval notification');
          } else if (user.channelType === 'wechat' && config.wechat.bot_token) {
            // Note: iLink Bot does not support proactive messaging — approval notification
            // will be delivered on the user's next message via context_token
            logger.info({ userId: user.userId, username: user.username }, 'WeChat pairing approved (notification on next message)');
          }
        }
        // Clean up expired requests periodically
        cleanExpiredRequests(runtimeTenantId);
      },
    });

    const users = getAllowedUsers(runtimeTenantId);
    const owners = users.filter(user => user.role === 'owner');
    const owner = owners[0] ?? users[0];
    if (owner) {
      const intervalFromEnv = Number(process.env.MOZI_AGENT_LOOP_INTERVAL_MINUTES);
      const intervalMinutes = Number.isFinite(intervalFromEnv) && intervalFromEnv > 0
        ? intervalFromEnv
        : 5;

      // Agent loop runs as a system health collector; notifications are now
      // handled by the LLM-driven proactive engine, so sendFn is a no-op.
      startAgentLoop({
        ownerChatId: owner.user_id,
        intervalMinutes,
        sendFn: () => {},
      });
      logger.info({ ownerChatId: owner.user_id, intervalMinutes }, 'Autonomous agent loop started (notifications via proactive engine)');

      // Start LLM-driven proactive engine — replaces deterministic notification
      const proactiveInterval = Number(process.env.MOZI_PROACTIVE_INTERVAL_MINUTES);
      const agentLoopCfg: InternalAgentLoopConfig = {
        ownerChatId: owner.user_id,
        sendFn: () => {},
        intervalMinutes,
        tenantId: 'default',
        reminderTaskId: 'reminder_dispatch',
        lessonsLookbackMinutes: 60,
      };
      startProactiveEngine({
        ownerChatId: owner.user_id,
        tenantId: 'default',
        intervalMinutes: Number.isFinite(proactiveInterval) && proactiveInterval > 0
          ? proactiveInterval
          : 2,
        collectSnapshot: () => collectSignalSnapshot(agentLoopCfg),
        actHandler: async ({ chatId, tenantId: actTenantId, action }) => {
          try {
            const proactiveMessage: IncomingMessage = {
              channelType: 'proactive',
              chatId,
              tenantId: actTenantId,
              userId: 'system',
              username: 'system',
              text: action,
              isCommand: action.startsWith('/'),
              attachments: [],
              timestamp: new Date(),
            };
            const result = await handler(proactiveMessage);
            return result ?? 'Action completed';
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn({ chatId, action, err: errMsg }, 'Proactive actHandler failed');
            return `Action failed: ${errMsg}`;
          }
        },
      });
      logger.info({ ownerChatId: owner.user_id }, 'LLM-driven proactive engine started');
    } else {
      logger.warn('Autonomous agent loop not started: no paired users available');
    }
  } else {
    logger.warn('Autonomous agent loop not started: Telegram bot unavailable');
  }

  // ── Fastify HTTP/WS server ──
  let fastifyApp: FastifyInstance | null = null;
  let channelRuntimes: Map<string, ChannelRuntime> = new Map();
  try {
    // trustProxy: honor X-Forwarded-* from a reverse proxy (nginx/cloudflare)
    // so request.ip / rate-limiter see the real client address rather than
    // the loopback address of the proxy itself.
    fastifyApp = Fastify({ logger: false, trustProxy: true });
    await fastifyApp.register(fastifyWebsocket, {
      options: {
        maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES,
      },
    });

    // Adapt WsIncomingMessage to IncomingMessage for the handler
    const wsHandler = async (wsMsg: WsIncomingMessage): Promise<string | null> => {
      const adapted: IncomingMessage = {
        channelType: 'websocket',
        chatId: wsMsg.chatId,
        tenantId: wsMsg.tenantId,
        userId: wsMsg.userId,
        username: wsMsg.username,
        text: wsMsg.text,
        isCommand: wsMsg.isCommand,
        command: wsMsg.command,
        commandArgs: wsMsg.commandArgs,
        workspaceContext: wsMsg.workspaceContext,
        attachments: wsMsg.attachments,
        clientCapabilities: wsMsg.clientCapabilities,
        sessionId: wsMsg.sessionId,
        originConnectionId: wsMsg.originConnectionId,
        timestamp: wsMsg.timestamp,
      };
      const result = await handler(adapted);
      // Surface the server-authoritative session id back onto the shared WS
      // message (Issue #627). On a brand-new chat the client sends no sessionId;
      // `handleMessage` owns/creates the session and stamps `adapted.sessionId`.
      // `adapted` is a copy, so without this mirror the transport-layer
      // `incoming` still has no sessionId — the non-stream final reply would be
      // dropped by its `incoming.sessionId` persistence gate and the outgoing
      // frame would carry no session identity for the client to bind. Streaming
      // already persists via the `adapted`-bound progress callbacks.
      if (!wsMsg.sessionId && adapted.sessionId) {
        wsMsg.sessionId = adapted.sessionId;
      }
      return result;
    };

    const jwtSecret = resolveAuthSecret(config.server.auth_token);
    if (!config.server.auth_token) {
      logger.info('server.auth_token not set; using persisted JWT secret from ~/.mozi/jwt-secret');
    }
    registerWebSocketRoute(fastifyApp, wsHandler, jwtSecret, {
      authMode: config.server.auth_mode,
    });
    registerVoiceRoute(fastifyApp, handler, {
      enabled: config.channels.voice.enabled,
    });

    // ── WeChat iLink Bot (long-polling, no webhook needed) ──
    if (config.wechat.bot_token) {
      startWeChatPolling(config.wechat.bot_token, handler);
      // Note: iLink Bot does not support proactive messaging without context_token
      // Register a no-op sender that logs a warning
      registerSender(async (chatId, _text) => {
        if (!isWeChatUserId(chatId)) return false;
        logger.warn({ chatId }, 'WeChat iLink Bot cannot send proactive messages');
        return false;
      }, 'wechat');
      logger.info('WeChat iLink Bot channel enabled (long-polling)');
    }

    // ── Registry-managed channels (Discord, Slack, Matrix, ...) ──
    channelRuntimes = await startRegisteredChannels(channelRegistry, {
      handler,
      logger,
      fastify: fastifyApp,
      jwtSecret,
      config,
    });
    for (const [id, runtime] of channelRuntimes) {
      if (runtime.sendDirect) {
        registerSender(async (chatId, text) => {
          const plugin = channelRegistry.get(id);
          if (!plugin?.isChatId(chatId)) return false;
          return runtime.sendDirect!(chatId, text);
        }, id);
      }
      logger.info({ channel: id }, 'Channel plugin started');
    }

    // REST API routes (auth guard + all endpoints)
    await registerApiRoutes(fastifyApp, { jwtSecret, config });

    // ── Serve Web UI static files (if built) ──
    const uiDistPath = resolveUiDistPath();
    if (uiDistPath) {
      await registerStaticServing(fastifyApp, uiDistPath);
    } else if (hasUiProject()) {
      logger.info('Web UI not built — run "pnpm ui:build" to enable');
    }

    const host = config.server.host;
    const port = config.server.port;
    await fastifyApp.listen({ host, port });
    serverUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    logger.info({ url: serverUrl }, 'HTTP/WebSocket server started');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Failed to start HTTP server — continuing without it');
    fastifyApp = null;
  }

  // ── Subscribe event bus → WebSocket broadcast + proactive engine ──
  const HIGH_SIGNAL_EVENTS = new Set([
    'task_failed', 'task_completed', 'agent_failed', 'agent_completed', 'budget_warning',
    'background_agent_complete', 'background_agent_failed',
  ]);
  const unsubProgress = onProgressEvent((event) => {
    broadcastProgressEvent(event);
    broadcastWorkspaceEvent(event);

    // Feed high-signal events to the proactive engine
    if (HIGH_SIGNAL_EVENTS.has(event.type)) {
      pushEvent({
        type: event.type,
        summary: `${event.type}: ${event.taskTitle ?? event.toolName ?? event.agentId ?? 'unknown'}${event.error ? ` — ${event.error}` : ''}`,
        data: event,
      });
    }
  });

  // Start periodic workspace data push (token budget, provider health)
  startWorkspacePush();

  // ── Register proactive notification senders ──
  registerSender(async (chatId, text) => wsSendToUser(chatId, text), 'websocket');

  startScheduler();
  logger.info('Reminder scheduler started (60s cadence)');

  // ── Session digest sweep (hourly) ──
  // The gateway's stale-session trigger only fires for sessionId-less traffic
  // (Telegram-shaped); Web/App sessions always pin a sessionId and were never
  // digested — "最近会话" stayed empty and recall_episodes read an empty table.
  // The sweep backfills digests for any session idle >24h, a few per run.
  const runDigestSweep = async (): Promise<void> => {
    const { sweepStaleSessionDigests } = await import('./memory/session-digest.js');
    await sweepStaleSessionDigests(() => {
      try {
        return getClientForTask({ type: 'summary' }).client;
      } catch {
        return llmClient;
      }
    });
  };
  scheduleTask({
    id: 'session_digest_sweep',
    name: 'Session digest sweep',
    interval_minutes: 60,
    run: runDigestSweep,
  });
  // First scheduler slot is interval_minutes away; run one boot sweep shortly
  // after start so an existing backlog surfaces without waiting an hour.
  // hasDigest idempotency makes this ~free once the backlog is drained.
  setTimeout(() => {
    runDigestSweep().catch(err => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Boot digest sweep failed');
    });
  }, 30_000);
  logger.info('Session digest sweep scheduled (hourly + boot backfill)');

  // ── Resume incomplete plan DAGs (crash OR clean restart both strand them) ──
  // Detached plan runs live outside any turn, so nothing else re-executes them.
  // Delay slightly so channels are connected when progress events start flowing.
  if (config.brain.resume_plans_on_boot) {
    setTimeout(() => {
      void (async () => {
        try {
          const { resumeIncompletePlans } = await import('./core/plan-runner.js');
          const report = resumeIncompletePlans({
            tenantId: runtimeTenantId,
            systemPrompt: loadDelegationSystemPrompt(config, runtimeTenantId),
            fallbackClient: llmClient,
          });
          if (report.resumed.length > 0) {
            logger.info({ resumed: report.resumed }, 'Resumed incomplete plan runs at boot');
          }
        } catch (err) {
          logger.error({
            err: err instanceof Error ? err.message : String(err),
          }, 'Boot-time plan resume failed');
        }
      })();
    }, 3000);
  }

  logger.info('MOZI is ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down...');
    try {
      // Drain active message turns before closing resources
      await drainActiveTurns(5000);
      setCleanShutdown(true);
      // Kill all background processes
      killAllProcesses();
      await stopBackgroundExecutor();
      if (mcpBridge) {
        await mcpBridge.shutdown().catch(err => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'MCP bridge shutdown error');
        });
      }
      clearInterval(workspaceSkillTimer);
      stopWorkspaceWatcher();
      failoverManager.destroy();
      unsubProgress();
      stopWorkspacePush();
      stopAgentLoop();
      stopProactiveEngine();
      const { stopHeartbeatWriter } = await import('./watchdog/index.js');
      stopHeartbeatWriter();
      stopScheduler();
      stopWeChatPolling();
      for (const [id, runtime] of channelRuntimes) {
        try {
          await runtime.stop(signal);
        } catch (err) {
          logger.warn({ channel: id, err: err instanceof Error ? err.message : String(err) }, 'Channel plugin stop failed');
        }
      }
      channelRuntimes.clear();
      if (bot) bot.stop(signal);
      if (fastifyApp) await fastifyApp.close();
      closeDb();
      logger.info('Shutdown complete');
    } finally {
      releasePidFile();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    releasePidFile();
    logger.fatal(err, 'MOZI fatal error');
    process.exit(1);
  });
}
