import { existsSync } from 'node:fs';
import { search, fetchUrl } from '../capabilities/search.js';
import { analyzeImage } from '../capabilities/vision.js';
import type { ToolDefinition } from '../core/llm.js';
import { validatePath } from '../tel/router.js';
import type { ToolResult, ToolContext, ToolSourceRef } from './types.js';
import { resolveReadPath } from './tool-utils.js';

/** Caps keep the source list a lean UI payload, not a transcript. */
const MAX_SOURCES_PER_CALL = 10;
const MAX_SOURCE_TITLE_CHARS = 200;
const MAX_SOURCE_SNIPPET_CHARS = 240;
const MAX_SOURCE_URL_CHARS = 2048;
/** Sources render as clickable hrefs in the UI — only web URLs may pass. */
const HTTP_SOURCE_URL_RE = /^https?:\/\//i;

/**
 * Project structured search hits into the `ToolResult.sources` payload the UI
 * source list consumes. The model still receives the formatted text `content`;
 * this preserves the per-hit title/url that formatting otherwise discards.
 */
export function searchResultsToSources(
  results: Array<{ title?: string; url?: string; snippet?: string }>,
): ToolSourceRef[] {
  const sources: ToolSourceRef[] = [];
  for (const r of results) {
    if (typeof r.url !== 'string' || !HTTP_SOURCE_URL_RE.test(r.url) || r.url.length > MAX_SOURCE_URL_CHARS) continue;
    const title = typeof r.title === 'string' && r.title.trim().length > 0
      ? r.title.trim().slice(0, MAX_SOURCE_TITLE_CHARS)
      : undefined;
    const snippet = typeof r.snippet === 'string' && r.snippet.trim().length > 0
      ? r.snippet.trim().slice(0, MAX_SOURCE_SNIPPET_CHARS)
      : undefined;
    sources.push({ title, url: r.url, snippet });
    if (sources.length >= MAX_SOURCES_PER_CALL) break;
  }
  return sources;
}

// ── Definitions ──

export const webSearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for information. Returns results with title, URL, and snippet. Use for ANY factual question — your training data may be outdated. Write specific targeted queries; parallelize multiple searches for complex research. Do NOT rely on training data for versions, dates, or API details. When the user asks for "latest/recent/最新" anything: include the current year in the query, check each result\'s publication date against the runtime time anchor, and never present an older item as latest without stating its date.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (optional)',
        },
        service: {
          type: 'string',
          description: 'Search service to use (optional)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const webFetchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch a URL and extract its text content. Use to read full content of documentation pages, articles, or API responses. NEVER fabricate URLs — use web_search to find URLs first.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (optional)',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
};

export const analyzeImageTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'analyze_image',
    description: 'Analyze an image file and return a textual description. Use for screenshots, charts, photos, diagrams, and UI mockups. Do NOT guess image contents without using this tool.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image file path to analyze (relative to workspace)',
        },
        prompt: {
          type: 'string',
          description: 'Optional custom analysis prompt',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

export const WEB_TOOLS: ToolDefinition[] = [webSearchTool, webFetchTool, analyzeImageTool];

// ── Executor ──

export async function executeWebTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'web_search': {
      const query = args.query as string;
      if (!query || typeof query !== 'string') {
        return { tool_call_id: id, content: 'Error: "query" parameter is required and must be a string', is_error: true };
      }
      const maxResultsRaw = args.max_results;
      if (maxResultsRaw !== undefined && typeof maxResultsRaw !== 'number') {
        return { tool_call_id: id, content: 'Error: "max_results" parameter must be a number', is_error: true };
      }
      const serviceRaw = args.service;
      if (serviceRaw !== undefined && typeof serviceRaw !== 'string') {
        return { tool_call_id: id, content: 'Error: "service" parameter must be a string', is_error: true };
      }
      let results: Awaited<ReturnType<typeof search>>;
      try {
        results = await search(query, {
          max_results: maxResultsRaw as number | undefined,
          search_service: serviceRaw as string | undefined,
        });
      } catch (searchErr) {
        const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
        return {
          tool_call_id: id,
          content: `Error: web search failed — ${msg}\nIMPORTANT: Do NOT answer this question from training data. Tell the user the search failed and ask them to retry.`,
          is_error: true,
        };
      }
      if (results.length === 0) {
        return {
          tool_call_id: id,
          content: 'No search results found. Do NOT fall back to training data — tell the user no results were found and suggest refining the query.',
          is_error: false,
        };
      }
      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
        .join('\n\n');
      return { tool_call_id: id, content: formatted, is_error: false, sources: searchResultsToSources(results) };
    }

    case 'web_fetch': {
      const url = args.url as string;
      if (!url || typeof url !== 'string') {
        return { tool_call_id: id, content: 'Error: "url" parameter is required and must be a string', is_error: true };
      }
      // SSRF protection
      const { checkSSRF } = await import('../security/ssrf-guard.js');
      const ssrfCheck = await checkSSRF(url);
      if (!ssrfCheck.safe) {
        return { tool_call_id: id, content: `Error: URL blocked by SSRF protection — ${ssrfCheck.reason}`, is_error: true };
      }

      const maxCharsRaw = args.max_chars;
      if (maxCharsRaw !== undefined && typeof maxCharsRaw !== 'number') {
        return { tool_call_id: id, content: 'Error: "max_chars" parameter must be a number', is_error: true };
      }
      const maxChars = (maxCharsRaw as number | undefined) ?? 10_000;
      const text = await fetchUrl(url, maxChars);
      const fetchSources = HTTP_SOURCE_URL_RE.test(url) && url.length <= MAX_SOURCE_URL_CHARS ? [{ url }] : undefined;
      return { tool_call_id: id, content: text, is_error: false, sources: fetchSources };
    }

    case 'analyze_image': {
      const path = args.path as string;
      const prompt = args.prompt as string | undefined;
      if (!path || typeof path !== 'string') {
        return { tool_call_id: id, content: 'Error: "path" parameter is required and must be a string', is_error: true };
      }
      if (prompt !== undefined && typeof prompt !== 'string') {
        return { tool_call_id: id, content: 'Error: "prompt" parameter must be a string', is_error: true };
      }
      let resolved: string;
      try {
        resolved = resolveReadPath(path, context?.userId, context?.workspaceRootPath);
        validatePath(resolved, context?.allowedPaths, context?.agentId, context?.tenantId ?? 'default');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { tool_call_id: id, content: `Error: ${msg}`, is_error: true };
      }
      if (!existsSync(resolved)) {
        return {
          tool_call_id: id,
          content: `Error: file not found at "${path}". It may be a temporary file from a previous session that no longer exists. Ask the user to re-send the image if needed.`,
          is_error: true,
        };
      }
      const analysis = await analyzeImage(resolved, prompt, {
        tenantId: context?.tenantId,
        userId: context?.userId,
      });
      return { tool_call_id: id, content: analysis, is_error: false };
    }

    default:
      return null;
  }
}
