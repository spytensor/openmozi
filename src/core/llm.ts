import { getProvider, resolveBaseUrl } from './providers.js';
import { resolveCliOAuthKey } from './cli-credentials.js';
import { createModelFactory } from './model-factory.js';
import { resolveRuntimeApiKey } from './runtime-provider-keys.js';
import { createAIAdapter } from './ai-sdk-adapter.js';
import type { LLMClient } from './llm-contracts.js';

export * from './llm-contracts.js';
export {
  applyThinkOption,
  consolidateSystemMessages,
  createAIAdapter,
  resolveAbortSignal,
  resolveTemperature,
  toCoreMessages,
} from './ai-sdk-adapter.js';
export { resolveMaxOutputTokens, type ModelFactory } from './model-factory.js';

// ---------------------------------------------------------------------------
// Factory — create LLMClient for any registered provider
// ---------------------------------------------------------------------------

/** Thrown when a chat is attempted before any brain model is configured. */
export class BrainNotConfiguredError extends Error {
  public readonly code = 'brain_not_configured';

  constructor() {
    super('No brain model is configured yet. Complete onboarding (or set a provider API key and brain model in Settings) to start chatting.');
    this.name = 'BrainNotConfiguredError';
  }
}
/**
 * LLM client for a not-yet-onboarded runtime (fresh install, empty
 * `model_router.brain_provider`). The server must still boot so web
 * onboarding and the admin/settings surfaces can run. Every call re-resolves
 * through `resolveClient`, so completing onboarding activates the brain
 * without a process restart; until then calls fail with a typed, honest
 * error instead of crashing the process at startup.
 */
export function createDeferredClient(resolveClient: () => LLMClient | null): LLMClient {
  let real: LLMClient | null = null;
  const ensure = (): LLMClient => {
    if (!real) real = resolveClient();
    if (!real) throw new BrainNotConfiguredError();
    return real;
  };
  return {
    get provider(): string {
      return real?.provider ?? 'unconfigured';
    },
    chat: async (messages, options) => ensure().chat(messages, options),
    chatStream: async function* (messages, options) {
      yield* ensure().chatStream(messages, options);
    },
    getAIModel: (modelId) => {
      const client = ensure();
      if (!client.getAIModel) throw new BrainNotConfiguredError();
      return client.getAIModel(modelId);
    },
  };
}

/** Create an LLM client for the given provider */
export function create(
  provider: string,
  options: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    configProviders?: Record<string, { apikey?: string; baseurl?: string }>;
    tenantId?: string;
  } = {}
): LLMClient {
  const def = getProvider(provider);

  // Known provider — resolve defaults from registry
  if (def) {
    // CLI-pipe providers:
    // - default: run local CLI subprocess (matches OpenClaw-style local auth behavior)
    // - optional: allow direct API mode via CLI OAuth token when explicitly enabled
    if (def.apiMode === 'cli-pipe' && def.cliBackend) {
      const directApiEnabled = /^(1|true|yes)$/i.test(process.env.MOZI_CLI_OAUTH_DIRECT_API ?? '');
      if (directApiEnabled) {
        const oauthKey = resolveCliOAuthKey(provider);
        if (oauthKey) {
          const model = options.model || def.defaultModel;
          return createAIAdapter(
            provider,
            model,
            createModelFactory({
              providerId: provider,
              apiMode: oauthKey.apiMode,
              apiKey: oauthKey.accessToken,
              baseUrl: oauthKey.baseUrl,
            }),
          );
        }
      }
      const model = options.model || def.defaultModel;
      return createAIAdapter(
        provider,
        model,
        createModelFactory({
          providerId: provider,
          apiMode: def.apiMode,
          apiKey: '',
          baseUrl: '',
        }),
      );
    }

    const apiKey = resolveRuntimeApiKey(provider, {
      apiKey: options.apiKey,
      configProviders: options.configProviders,
      tenantId: options.tenantId,
    }) || '';
    const baseUrl = options.baseUrl || resolveBaseUrl(provider, process.env, options.configProviders);
    const model = options.model || def.defaultModel;

    return createAIAdapter(
      provider,
      model,
      createModelFactory({
        providerId: provider,
        apiMode: def.apiMode,
        apiKey,
        baseUrl,
      }),
    );
  }

  // Unknown provider — must provide baseUrl, treated as OpenAI-compatible
  if (options.baseUrl) {
    return createAIAdapter(
      provider,
      options.model || 'default',
      createModelFactory({
        providerId: provider,
        apiMode: 'openai-compat',
        apiKey: options.apiKey || '',
        baseUrl: options.baseUrl,
      }),
    );
  }

  throw new Error(`Unknown provider "${provider}". Register it in providers.ts or provide a baseUrl.`);
}
