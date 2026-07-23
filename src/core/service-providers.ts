/**
 * Service provider registry — non-model API services (web search, and future
 * MCP / custom integrations). This is the service-side counterpart to the model
 * provider registry in `providers.ts`.
 *
 * Keys are persisted through the standard encrypted secret store
 * (`security/secrets.ts`): each provider declares the `envVar` its runtime
 * capability reads, and the store syncs that var into `process.env` on boot.
 *
 * Only providers whose runtime path is actually wired appear here — MOZI must
 * not offer a vendor it cannot use (Constitution: no fabricated capabilities).
 */

/** Categories of non-model service. Extend as new runtime integrations land. */
export type ServiceCategory = 'search';

export interface ServiceProvider {
  /** Stable id used in URLs and as the active-provider selector value. */
  id: string;
  category: ServiceCategory;
  /** Human-facing vendor name. */
  name: string;
  /** Short one-line description shown in the UI. */
  hint: string;
  /** The env var the runtime capability reads this provider's key from. */
  envVar: string;
  /** Where the user obtains an API key. */
  docsUrl: string;
  /** Whether this provider supports content extraction (powers web_fetch). */
  supportsFetch: boolean;
}

/**
 * Web search providers. `search1api` is the original integration; the others
 * are wired in `capabilities/search.ts`. Order is the auto-selection
 * precedence when no explicit active provider is set.
 */
export const SEARCH_PROVIDERS: ServiceProvider[] = [
  {
    id: 'search1api',
    category: 'search',
    name: 'Search1API',
    hint: 'Search + page crawl in one API. Powers web_search and web_fetch.',
    envVar: 'SEARCH1API_KEY',
    docsUrl: 'https://www.search1api.com',
    supportsFetch: true,
  },
  {
    id: 'tavily',
    category: 'search',
    name: 'Tavily',
    hint: 'Search API built for LLMs, with a content extract endpoint.',
    envVar: 'TAVILY_API_KEY',
    docsUrl: 'https://tavily.com',
    supportsFetch: true,
  },
  {
    id: 'serper',
    category: 'search',
    name: 'Serper',
    hint: 'Fast Google SERP API. Search only — web_fetch falls back to a direct fetch.',
    envVar: 'SERPER_API_KEY',
    docsUrl: 'https://serper.dev',
    supportsFetch: false,
  },
  {
    id: 'brave',
    category: 'search',
    name: 'Brave Search',
    hint: 'Independent web index. Search only — web_fetch falls back to a direct fetch.',
    envVar: 'BRAVE_API_KEY',
    docsUrl: 'https://brave.com/search/api',
    supportsFetch: false,
  },
];

/** All registered service providers across every category. */
export const SERVICE_PROVIDERS: ServiceProvider[] = [...SEARCH_PROVIDERS];

/** Look up a service provider by id. */
export function getServiceProvider(id: string): ServiceProvider | undefined {
  return SERVICE_PROVIDERS.find((p) => p.id === id);
}

/** Providers for a given category, in precedence order. */
export function getServiceProvidersByCategory(category: ServiceCategory): ServiceProvider[] {
  return SERVICE_PROVIDERS.filter((p) => p.category === category);
}

/** True if the provider's key is present in the environment. */
export function isServiceProviderConfigured(provider: ServiceProvider): boolean {
  return typeof process.env[provider.envVar] === 'string' && process.env[provider.envVar]!.trim().length > 0;
}

/** True if any search provider has a key configured. */
export function isAnySearchProviderConfigured(): boolean {
  return SEARCH_PROVIDERS.some(isServiceProviderConfigured);
}

/**
 * Resolve the active search provider:
 * 1. `MOZI_SEARCH_PROVIDER` if it names a configured provider, else
 * 2. the first configured provider in precedence order, else
 * 3. null (nothing configured).
 */
export function resolveActiveSearchProvider(): ServiceProvider | null {
  const explicitId = process.env.MOZI_SEARCH_PROVIDER?.trim();
  if (explicitId) {
    const explicit = SEARCH_PROVIDERS.find((p) => p.id === explicitId);
    if (explicit && isServiceProviderConfigured(explicit)) return explicit;
  }
  return SEARCH_PROVIDERS.find(isServiceProviderConfigured) ?? null;
}
