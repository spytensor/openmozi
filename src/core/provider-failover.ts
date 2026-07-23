/**
 * Provider Failover — Automatic LLM provider fallback and degraded mode.
 *
 * Integrates with provider-health.ts and llm.ts to provide:
 * - Automatic fallback when a provider fails (5xx, timeout)
 * - DEGRADED mode when all providers are down
 * - Request queuing in degraded mode with backpressure/TTL policies
 * - Automatic recovery detection and queue draining
 */

import * as providerHealth from './provider-health.js';
import { create, type LLMClient, type ChatMessage, type ChatOptions, type ChatResponse, type StreamChunk } from './llm.js';
import { getConfig } from '../config/index.js';
import { resolveApiKey, getProvider } from './providers.js';
import { ModelNotAllowedError, resolveAllowedModels } from '../security/entitlements.js';
import { normalizeProviderError } from './error-surfacing.js';
import * as providerRateLimiter from './rate-limiter.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:provider-failover' });

// This is a local admission-control ceiling, not a claim about the customer's
// provider tier. OpenAI limits vary by account/model; keeping MOZI below this
// conservative process-wide budget prevents a parallel research wave from
// consuming the entire observed 500k TPM window before a 429 can teach us to
// back off. Explicit rate_limits config always wins.
const PROVIDER_SAFETY_LIMITS: Record<string, { rpm: number; tpm: number; concurrent: number }> = {
  openai: { rpm: 50, tpm: 400_000, concurrent: 4 },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailoverMode = 'normal' | 'fallback' | 'degraded';

export interface FallbackChain {
  primary: { provider: string; model: string };
  fallbacks: Array<{ provider: string; model: string }>;
}

export interface QueuedRequest {
  id: string;
  messages: ChatMessage[];
  options?: ChatOptions;
  resolve: (response: ChatResponse) => void;
  reject: (error: Error) => void;
  queuedAt: number;
}

export interface FailoverState {
  mode: FailoverMode;
  activeProvider: string;
  activeModel: string;
  queueLength: number;
  lastModeChange: number;
}

export type QueueFullPolicy = 'reject_new' | 'drop_oldest';

export interface DegradedQueuePolicy {
  maxQueueLength: number;
  requestTtlMs: number;
  fullQueuePolicy: QueueFullPolicy;
}

type ProviderModel = { provider: string; model: string };
type FailoverChatOptions = ChatOptions & { isComplex?: boolean; provider?: string };

// ---------------------------------------------------------------------------
// Failover manager
// ---------------------------------------------------------------------------

/**
 * Create a failover-aware LLM client manager.
 *
 * Wraps LLM calls with automatic fallback logic:
 * 1. Try primary provider
 * 2. On failure, record in provider-health and try fallback
 * 3. If all providers down, enter DEGRADED mode
 * 4. Periodically retry to detect recovery
 */
export function createFailoverManager(
  chain: FallbackChain,
  queuePolicyOverrides: Partial<DegradedQueuePolicy> = {},
) {
  let currentMode: FailoverMode = 'normal';
  let activeProvider = chain.primary.provider;
  let activeModel = chain.primary.model;
  let lastModeChange = Date.now();
  const requestQueue: QueuedRequest[] = [];
  const stickySelections = new Map<string, { entry: ProviderModel; touchedAt: number }>();
  const stickyTtlMs = 15 * 60_000;
  let queueDraining = false;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  const recoveryIntervalMs = 60_000;
  const queuePolicy: DegradedQueuePolicy = {
    maxQueueLength: 50,
    requestTtlMs: 5 * 60_000,
    fullQueuePolicy: 'reject_new',
    ...queuePolicyOverrides,
  };

  // Notification callback (set externally, e.g. to send Telegram message)
  let onModeChange: ((mode: FailoverMode, message: string) => void) | null = null;

  /** Get the current failover state */
  function getState(): FailoverState {
    return {
      mode: currentMode,
      activeProvider,
      activeModel,
      queueLength: requestQueue.length,
      lastModeChange,
    };
  }

  /** Set a callback for mode changes */
  function onModeChangeCallback(cb: (mode: FailoverMode, message: string) => void): void {
    onModeChange = cb;
  }

  /** Switch to a new mode */
  function setMode(mode: FailoverMode, reason: string): void {
    if (mode === currentMode) return;
    const prevMode = currentMode;
    currentMode = mode;
    lastModeChange = Date.now();
    logger.warn({ from: prevMode, to: mode, reason }, 'Failover mode changed');

    if (onModeChange) {
      const message = mode === 'degraded'
        ? 'LLM provider unavailable, running in degraded mode. Complex tasks will be queued.'
        : mode === 'fallback'
          ? `Primary provider down. Using fallback: ${activeProvider}/${activeModel}`
          : `Provider recovered. Back to normal: ${activeProvider}/${activeModel}`;
      onModeChange(mode, message);
    }

    if (mode === 'degraded') {
      startRecoveryProbe();
    } else {
      stopRecoveryProbe();
      void drainQueue();
    }
  }

  /** Reject and remove expired queued requests according to TTL policy. */
  function evictExpiredQueueRequests(now = Date.now()): void {
    if (queuePolicy.requestTtlMs <= 0 || requestQueue.length === 0) return;
    const keep: QueuedRequest[] = [];
    let evicted = 0;
    for (const req of requestQueue) {
      if (now - req.queuedAt > queuePolicy.requestTtlMs) {
        evicted++;
        req.reject(new Error('Request expired in degraded queue'));
      } else {
        keep.push(req);
      }
    }
    if (evicted > 0) {
      requestQueue.length = 0;
      requestQueue.push(...keep);
      logger.warn({ evicted, queueLength: requestQueue.length }, 'Expired requests evicted from degraded queue');
    }
  }

  /**
   * Try to send a chat request with automatic failover.
   * Returns a ChatResponse or throws if in degraded mode and request is complex.
   */
  async function chat(
    messages: ChatMessage[],
    options?: FailoverChatOptions,
  ): Promise<ChatResponse> {
    // In degraded mode, queue complex requests
    if (currentMode === 'degraded') {
      if (options?.isComplex) {
        evictExpiredQueueRequests();
        if (requestQueue.length >= queuePolicy.maxQueueLength) {
          if (queuePolicy.fullQueuePolicy === 'drop_oldest' && requestQueue.length > 0) {
            const dropped = requestQueue.shift();
            dropped?.reject(new Error('Degraded queue overflow: dropped oldest request'));
          } else {
            throw new Error(
              `Degraded queue full (${queuePolicy.maxQueueLength}); rejecting new request`,
            );
          }
        }

        return new Promise<ChatResponse>((resolve, reject) => {
          const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          requestQueue.push({
            id,
            messages,
            options,
            resolve,
            reject,
            queuedAt: Date.now(),
          });
          logger.info(
            {
              queueId: id,
              queueLength: requestQueue.length,
              queueCapacity: queuePolicy.maxQueueLength,
              fullQueuePolicy: queuePolicy.fullQueuePolicy,
            },
            'Complex request queued in degraded mode',
          );
        });
      }
      // Simple requests in degraded mode — still try
    }

    // Try the active provider
    const providers = getEntitledProviderList(options);
    const sticky = getStickySelection(options);
    const candidates = sticky ? [sticky] : providers;
    let lastError: Error | null = null;
    const blockedProviders = new Set<string>();

    for (const entry of candidates) {
      if (blockedProviders.has(entry.provider)) continue;
      try {
        const client = createClient(entry.provider, entry.model);
        const startMs = Date.now();
        const response = await callWithProviderPermit(entry, messages, options, (clientOptions) =>
          client.chat(messages, clientOptions));
        const latencyMs = Date.now() - startMs;

        // Report success
        recordProviderSuccess(entry, latencyMs);
        pinStickySelection(options, entry);

        return response;
      } catch (err) {
        if (options?.abort_signal?.aborted) throw err;
        lastError = recordProviderFailure(entry, err, 'Provider call failed');
        if (sticky) {
          clearStickySelection(options);
          throw lastError;
        }
        if ('retryable' in lastError && lastError.retryable === false) blockedProviders.add(entry.provider);
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  /**
   * Try to stream a chat request with automatic failover.
   * Retries the same caller-selected chain used by chat().
   */
  async function* chatStream(
    messages: ChatMessage[],
    options?: FailoverChatOptions,
  ): AsyncGenerator<StreamChunk> {
    const providers = getEntitledProviderList(options);
    const sticky = getStickySelection(options);
    const candidates = sticky ? [sticky] : providers;
    let lastError: Error | null = null;
    const blockedProviders = new Set<string>();

    for (const entry of candidates) {
      if (blockedProviders.has(entry.provider)) continue;
      try {
        const client = createClient(entry.provider, entry.model);
        const startMs = Date.now();
        const clientOptions = await acquireProviderPermit(entry, messages, options);
        try {
          for await (const chunk of client.chatStream(messages, clientOptions)) yield chunk;
        } finally {
          providerRateLimiter.release(entry.provider);
        }
        const latencyMs = Date.now() - startMs;
        recordProviderSuccess(entry, latencyMs);
        pinStickySelection(options, entry);
        return;
      } catch (err) {
        if (options?.abort_signal?.aborted) throw err;
        lastError = recordProviderFailure(entry, err, 'Provider stream failed');
        if (sticky) {
          clearStickySelection(options);
          throw lastError;
        }
        if ('retryable' in lastError && lastError.retryable === false) blockedProviders.add(entry.provider);
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  /** Get ordered list of providers to try */
  function getProviderList(options?: FailoverChatOptions): ProviderModel[] {
    const requested = getRequestedSelection(options);
    if (requested) {
      return getRequestedProviderList(requested);
    }

    const list: ProviderModel[] = [];
    if (!shouldSkipPrimary()) {
      list.push(chain.primary);
    }
    for (const fb of chain.fallbacks) {
      appendProvider(list, fb);
    }

    return list;
  }

  function getRequestedProviderList(requested: ProviderModel): ProviderModel[] {
    const list: ProviderModel[] = [];
    const configured = [chain.primary, ...chain.fallbacks];
    const sameProviderSlots = configured.filter(entry => entry.provider === requested.provider);
    const retryCount = Math.max(1, sameProviderSlots.length);

    if (!(requested.provider === chain.primary.provider && shouldSkipPrimary())) {
      for (let i = 0; i < retryCount; i++) {
        list.push(requested);
      }
    }

    for (const entry of configured) {
      if (entry.provider === requested.provider) continue;
      if (entry.provider === chain.primary.provider && shouldSkipPrimary()) continue;
      appendProvider(list, entry);
    }

    return list;
  }

  function getRequestedSelection(options: FailoverChatOptions | undefined): ProviderModel | null {
    const provider = options?.provider?.trim();
    const model = options?.model?.trim();
    if (provider && model) {
      return { provider, model };
    }
    if (!model) return null;

    const configuredMatch = [chain.primary, ...chain.fallbacks].find(entry => entry.model === model);
    return configuredMatch ? { provider: configuredMatch.provider, model } : null;
  }

  function shouldSkipPrimary(): boolean {
    return currentMode !== 'normal' && providerHealth.getStatus(chain.primary.provider) === 'down';
  }

  function appendProvider(list: ProviderModel[], entry: ProviderModel): void {
    if (list.some(existing => existing.provider === entry.provider && existing.model === entry.model)) return;
    list.push(entry);
  }

  function getEntitledProviderList(options: FailoverChatOptions | undefined): ProviderModel[] {
    const list = getProviderList(options);
    const entitlement = options?.entitlements;
    if (!entitlement?.tenantId || !entitlement.userId) return list;

    const allowedModels = entitlement.allowedModels !== undefined
      ? entitlement.allowedModels
      : resolveAllowedModels(entitlement.tenantId, entitlement.userId).models;
    if (allowedModels === null) return list;

    const filtered = list.filter(entry => allowedModels.includes(entry.model));
    if (filtered.length > 0) return filtered;

    throw new ModelNotAllowedError(
      entitlement.tenantId,
      entitlement.userId,
      options?.model || chain.primary.model,
      allowedModels,
    );
  }

  /** Create an LLM client for a provider/model */
  function createClient(provider: string, model: string): LLMClient {
    return create(provider, { model, configProviders: getConfig().providers });
  }

  function createClientOptions(options: FailoverChatOptions | undefined, entry: ProviderModel): ChatOptions {
    const { provider: _provider, isComplex: _isComplex, failoverSessionKey: _failoverSessionKey, ...clientOptions } = options ?? {};
    return {
      ...clientOptions,
      model: entry.model,
    };
  }

  function pruneStickySelections(now = Date.now()): void {
    for (const [key, value] of stickySelections) {
      if (now - value.touchedAt > stickyTtlMs) stickySelections.delete(key);
    }
  }

  function getStickySelection(options?: FailoverChatOptions): ProviderModel | null {
    const key = options?.failoverSessionKey?.trim();
    if (!key) return null;
    pruneStickySelections();
    const pinned = stickySelections.get(key);
    if (!pinned) return null;
    pinned.touchedAt = Date.now();
    return pinned.entry;
  }

  function pinStickySelection(options: FailoverChatOptions | undefined, entry: ProviderModel): void {
    const key = options?.failoverSessionKey?.trim();
    if (!key) return;
    stickySelections.set(key, { entry, touchedAt: Date.now() });
  }

  function clearStickySelection(options?: FailoverChatOptions): void {
    const key = options?.failoverSessionKey?.trim();
    if (key) stickySelections.delete(key);
  }

  function estimateRequestTokens(messages: ChatMessage[], options?: FailoverChatOptions): number {
    let chars = 0;
    for (const message of messages) {
      chars += typeof message.content === 'string'
        ? message.content.length
        : message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 1024), 0);
      chars += message.reasoning_content?.length ?? 0;
      for (const toolCall of message.tool_calls ?? []) chars += toolCall.function.arguments.length + toolCall.function.name.length;
    }
    return Math.max(1, Math.ceil(chars / 4) + Math.max(0, options?.max_tokens ?? 0));
  }

  async function acquireProviderPermit(
    entry: ProviderModel,
    messages: ChatMessage[],
    options?: FailoverChatOptions,
  ): Promise<ChatOptions> {
    const limits = getConfig().rate_limits?.[entry.provider] ?? PROVIDER_SAFETY_LIMITS[entry.provider];
    let estimatedTokens = estimateRequestTokens(messages, options);
    if (limits) {
      providerRateLimiter.configure(entry.provider, limits);
      estimatedTokens = Math.min(estimatedTokens, limits.tpm);
    }
    await providerRateLimiter.acquire(entry.provider, estimatedTokens, 1, options?.abort_signal);
    return createClientOptions(options, entry);
  }

  async function callWithProviderPermit<T>(
    entry: ProviderModel,
    messages: ChatMessage[],
    options: FailoverChatOptions | undefined,
    call: (clientOptions: ChatOptions) => Promise<T>,
  ): Promise<T> {
    const clientOptions = await acquireProviderPermit(entry, messages, options);
    try {
      return await call(clientOptions);
    } finally {
      providerRateLimiter.release(entry.provider);
    }
  }

  function recordProviderSuccess(entry: ProviderModel, latencyMs: number): void {
    providerHealth.reportSuccess(entry.provider, latencyMs);

    // If we were in fallback/degraded, check if primary is back
    if (currentMode !== 'normal' && entry.provider === chain.primary.provider) {
      activeProvider = entry.provider;
      activeModel = entry.model;
      setMode('normal', 'Primary provider recovered');
    } else if (currentMode === 'degraded') {
      activeProvider = entry.provider;
      activeModel = entry.model;
      setMode('fallback', `Fallback provider ${entry.provider} responding`);
    }
  }

  function recordProviderFailure(entry: ProviderModel, err: unknown, message: string): Error {
    const error = normalizeProviderError(err);
    providerHealth.reportFailure(entry.provider);
    logger.warn({ provider: entry.provider, model: entry.model, error: error.message }, message);

    // Update mode based on health
    const primaryStatus = providerHealth.getStatus(chain.primary.provider);

    if (primaryStatus === 'down') {
      // Check if any fallback is healthy
      const healthyFallback = chain.fallbacks.find(f =>
        providerHealth.getStatus(f.provider) !== 'down'
      );

      if (healthyFallback) {
        activeProvider = healthyFallback.provider;
        activeModel = healthyFallback.model;
        setMode('fallback', `Primary down, using fallback ${healthyFallback.provider}`);
      } else {
        setMode('degraded', 'All providers down');
      }
    }

    return error;
  }

  /** Start periodic recovery probing */
  function startRecoveryProbe(): void {
    if (recoveryTimer) return;
    recoveryTimer = setInterval(async () => {
      logger.info('Probing providers for recovery...');
      // Try primary first, then fallbacks
      const allProviders = [chain.primary, ...chain.fallbacks];

      for (const entry of allProviders) {
        try {
          const client = createClient(entry.provider, entry.model);
          const startMs = Date.now();
          await client.chat(
            [{ role: 'user', content: 'ping' }],
            { max_tokens: 16 },
          );
          const latencyMs = Date.now() - startMs;
          providerHealth.reportSuccess(entry.provider, latencyMs);

          activeProvider = entry.provider;
          activeModel = entry.model;

          if (entry === chain.primary) {
            setMode('normal', 'Primary provider recovered during probe');
          } else {
            setMode('fallback', `Fallback provider ${entry.provider} recovered during probe`);
          }
          return; // Recovery detected, stop probing
        } catch {
          providerHealth.reportFailure(entry.provider);
        }
      }
    }, recoveryIntervalMs);
    (recoveryTimer as { unref?: () => void }).unref?.();
  }

  /** Stop recovery probing */
  function stopRecoveryProbe(): void {
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
  }

  /** Drain queued requests (called when provider recovers) */
  async function drainQueue(): Promise<void> {
    if (queueDraining) return;
    queueDraining = true;
    evictExpiredQueueRequests();
    const toProcess = [...requestQueue];
    requestQueue.length = 0;

    logger.info({ count: toProcess.length }, 'Draining request queue');

    try {
      for (const req of toProcess) {
        if (queuePolicy.requestTtlMs > 0 && Date.now() - req.queuedAt > queuePolicy.requestTtlMs) {
          req.reject(new Error('Request expired in degraded queue'));
          continue;
        }
        try {
          const response = await chat(req.messages, req.options);
          req.resolve(response);
        } catch (err) {
          req.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      queueDraining = false;
    }
  }

  /** Destroy the failover manager (clean up timers) */
  function destroy(): void {
    stopRecoveryProbe();
    // Reject all queued requests
    for (const req of requestQueue) {
      req.reject(new Error('Failover manager destroyed'));
    }
    requestQueue.length = 0;
    stickySelections.clear();
  }

  return {
    chat,
    chatStream,
    getState,
    setMode,
    onModeChange: onModeChangeCallback,
    destroy,
    /** Expose queue length for testing */
    getQueueLength: () => requestQueue.length,
  };
}

// ---------------------------------------------------------------------------
// Convenience: create a default failover manager from config
// ---------------------------------------------------------------------------

/**
 * Create a failover manager from the current MOZI config.
 * Respects brain_provider from config instead of hardcoding Anthropic.
 */
export function createDefaultFailoverManager() {
  const config = getConfig();
  const primary = config.model_router?.brain_provider ?? '';
  const fallbackProvider = config.model_router?.fallback_brain_provider;

  const chain: FallbackChain = {
    primary: {
      provider: primary,
      model: config.brain.model,
    },
    fallbacks: [],
  };

  // Add explicit fallback from config
  if (fallbackProvider) {
    chain.fallbacks.push({
      provider: fallbackProvider,
      model: config.brain.fallback_model,
    });
  }

  // Add a cheap fallback if available and different from primary
  if (primary !== 'minimax' && resolveApiKey('minimax')) {
    const def = getProvider('minimax');
    if (def) chain.fallbacks.push({ provider: 'minimax', model: def.defaultModel });
  } else if (primary !== 'anthropic' && resolveApiKey('anthropic')) {
    const def = getProvider('anthropic');
    if (def) chain.fallbacks.push({ provider: 'anthropic', model: def.defaultModel });
  }

  const queueMaxRaw = Number(process.env.MOZI_FAILOVER_QUEUE_MAX ?? 50);
  const queueTtlRaw = Number(process.env.MOZI_FAILOVER_QUEUE_TTL_MS ?? (5 * 60_000));
  const policyRaw = process.env.MOZI_FAILOVER_QUEUE_POLICY;
  const fullQueuePolicy: QueueFullPolicy = policyRaw === 'drop_oldest' ? 'drop_oldest' : 'reject_new';

  return createFailoverManager(chain, {
    maxQueueLength: Number.isFinite(queueMaxRaw) && queueMaxRaw > 0 ? Math.floor(queueMaxRaw) : 50,
    requestTtlMs: Number.isFinite(queueTtlRaw) && queueTtlRaw >= 0 ? Math.floor(queueTtlRaw) : 5 * 60_000,
    fullQueuePolicy,
  });
}
