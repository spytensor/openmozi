import pino from 'pino';
import {
  resolveActiveSearchProvider,
  type ServiceProvider,
} from '../core/service-providers.js';
import { ssrfSafeFetch } from '../security/ssrf-guard.js';

const logger = pino({ name: 'mozi:capability:search' });

/** Result from a web search query */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Options for the search function */
export interface SearchOptions {
  max_results?: number;
  search_service?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve the active search provider or throw a message the Brain can relay.
 * NOTE: The non-Search1API request/response shapes below follow each vendor's
 * public API docs and still need a smoke test with a real key.
 */
function requireActiveProvider(): { provider: ServiceProvider; apiKey: string } {
  const provider = resolveActiveSearchProvider();
  if (!provider) {
    throw new Error(
      'No web search provider is configured. Add a key under Settings → API Services (Search1API, Tavily, Serper, or Brave).',
    );
  }
  const apiKey = process.env[provider.envVar]?.trim();
  if (!apiKey) {
    throw new Error(`${provider.name} is selected but ${provider.envVar} is not set.`);
  }
  return { provider, apiKey };
}

// ── Per-provider search implementations ────────────────────────────────────

interface Search1ApiResponse {
  results?: Array<{ title?: string; link?: string; url?: string; snippet?: string; description?: string }>;
}

async function searchSearch1Api(apiKey: string, query: string, options: SearchOptions): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    query,
    max_results: options.max_results ?? 5,
    crawl_results: 0,
  };
  if (options.search_service) body.search_service = options.search_service;

  const response = await ssrfSafeFetch('https://api.search1api.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Search API error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as Search1ApiResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? r.url ?? '',
    snippet: r.snippet ?? r.description ?? '',
  }));
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

async function searchTavily(apiKey: string, query: string, options: SearchOptions): Promise<SearchResult[]> {
  const response = await ssrfSafeFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: options.max_results ?? 5 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily API error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as TavilyResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

interface SerperResponse {
  organic?: Array<{ title?: string; link?: string; snippet?: string }>;
}

async function searchSerper(apiKey: string, query: string, options: SearchOptions): Promise<SearchResult[]> {
  const response = await ssrfSafeFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: options.max_results ?? 5 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Serper API error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as SerperResponse;
  return (data.organic ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

async function searchBrave(apiKey: string, query: string, options: SearchOptions): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(options.max_results ?? 5) });
  const response = await ssrfSafeFetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    method: 'GET',
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Brave API error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as BraveResponse;
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }));
}

/**
 * Search the web using the active provider (Settings → API Services).
 */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const { provider, apiKey } = requireActiveProvider();
  logger.debug({ query, provider: provider.id, max_results: options.max_results ?? 5 }, 'Executing web search');

  switch (provider.id) {
    case 'search1api': return searchSearch1Api(apiKey, query, options);
    case 'tavily': return searchTavily(apiKey, query, options);
    case 'serper': return searchSerper(apiKey, query, options);
    case 'brave': return searchBrave(apiKey, query, options);
    default:
      throw new Error(`Unsupported search provider: ${provider.id}`);
  }
}

// ── Per-provider content extraction (web_fetch) ─────────────────────────────

interface Search1CrawlResponse {
  text?: string;
  content?: string;
  results?: { title?: string; link?: string; content?: string };
}

async function fetchViaSearch1Api(apiKey: string, url: string): Promise<string> {
  const response = await ssrfSafeFetch('https://api.search1api.com/crawl', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, crawl_type: 'text' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Crawl API error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as Search1CrawlResponse;
  return data.text ?? data.content ?? data.results?.content ?? '';
}

interface TavilyExtractResponse {
  results?: Array<{ url?: string; raw_content?: string }>;
}

async function fetchViaTavily(apiKey: string, url: string): Promise<string> {
  const response = await ssrfSafeFetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, urls: [url] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily extract error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as TavilyExtractResponse;
  return data.results?.[0]?.raw_content ?? '';
}

/** Crude HTML→text fallback for providers without an extract endpoint. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchDirect(url: string): Promise<string> {
  const response = await ssrfSafeFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MOZI/1.0; +https://github.com)', Accept: 'text/html,text/plain,*/*' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Fetch error ${response.status} for ${url}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  return /html/i.test(contentType) ? stripHtml(body) : body;
}

/**
 * Fetch and extract text from a URL. Uses the active provider's extract
 * endpoint when available, otherwise a direct HTTP fetch with HTML stripping.
 */
export async function fetchUrl(url: string, maxChars?: number): Promise<string> {
  const { provider, apiKey } = requireActiveProvider();
  logger.debug({ url, provider: provider.id, maxChars }, 'Fetching URL content');

  let text: string;
  if (provider.id === 'search1api') {
    text = await fetchViaSearch1Api(apiKey, url);
  } else if (provider.id === 'tavily') {
    text = await fetchViaTavily(apiKey, url);
  } else {
    // Serper / Brave have no extract endpoint — fetch the page directly.
    text = await fetchDirect(url);
  }

  if (typeof text !== 'string') {
    text = typeof text === 'object' ? JSON.stringify(text) : String(text);
  }
  if (maxChars !== undefined && maxChars >= 0 && text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  return text;
}
