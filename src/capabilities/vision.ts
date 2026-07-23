import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import pino from 'pino';
import { getSelectionForRole, type RoutingContext } from '../core/model-router.js';
import { getProvider, resolveApiKey, resolveBaseUrl, getVisionCapableProviders, type ProviderApiMode } from '../core/providers.js';

const logger = pino({ name: 'mozi:capability:vision' });

const DEFAULT_PROMPT = 'Analyze this image and describe what is visible.';

// 2048 covers most vision payloads (data tables, multi-field reports, K-line
// charts) while staying well under context limits. The previous 500 was too
// tight: ~200 Chinese chars under DeepSeek's tokenizer, which truncated
// real reports mid-sentence (issue #267). Override via env when a specific
// model needs more headroom.
const DEFAULT_VISION_MAX_TOKENS = 2048;

function getVisionMaxTokens(): number {
  const raw = process.env.MOZI_VISION_MAX_TOKENS;
  if (!raw) return DEFAULT_VISION_MAX_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VISION_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
}

interface VisionTarget {
  provider: string;
  model: string;
  apiMode: ProviderApiMode;
  baseUrl: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferMimeType(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function extractOpenAIText(data: OpenAIChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
      .trim();
  }
  return '';
}

function extractAnthropicText(data: AnthropicMessageResponse): string {
  if (!Array.isArray(data.content)) return '';
  return data.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// API call — two formats
// ---------------------------------------------------------------------------

async function callOpenAIVision(target: VisionTarget, imageBase64: string, mime: string, prompt: string): Promise<string> {
  const url = `${target.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
        ],
      }],
      max_tokens: getVisionMaxTokens(),
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Vision API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const analysis = extractOpenAIText(data);
  if (!analysis) throw new Error('Vision response was empty');
  return analysis;
}

async function callAnthropicVision(target: VisionTarget, imageBase64: string, mime: string, prompt: string): Promise<string> {
  const base = target.baseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: target.model,
      max_tokens: getVisionMaxTokens(),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Vision API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as AnthropicMessageResponse;
  const analysis = extractAnthropicText(data);
  if (!analysis) throw new Error('Vision response was empty');
  return analysis;
}

async function callVision(target: VisionTarget, imageBase64: string, mime: string, prompt: string): Promise<string> {
  if (target.apiMode === 'anthropic') {
    return callAnthropicVision(target, imageBase64, mime, prompt);
  }
  return callOpenAIVision(target, imageBase64, mime, prompt);
}

// ---------------------------------------------------------------------------
// Build ordered vision provider chain
// ---------------------------------------------------------------------------

function buildVisionChain(routingContext?: RoutingContext): VisionTarget[] {
  const chain: VisionTarget[] = [];
  const seen = new Set<string>();

  // 1. Primary: model-router's vision role pick (may already be vision-capable)
  const selection = getSelectionForRole('vision', routingContext);
  if (selection.provider && selection.model) {
    const providerDef = getProvider(selection.provider);
    const apiKey = resolveApiKey(selection.provider);
    if (providerDef && apiKey) {
      const key = `${selection.provider}:${selection.model}`;
      seen.add(key);
      chain.push({
        provider: selection.provider,
        model: selection.model,
        apiMode: providerDef.apiMode,
        baseUrl: resolveBaseUrl(selection.provider),
        apiKey,
      });
    }
  }

  // 2. All other vision-capable providers (already sorted by format preference)
  for (const entry of getVisionCapableProviders()) {
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const apiKey = resolveApiKey(entry.provider);
    if (!apiKey) continue;
    chain.push({
      provider: entry.provider,
      model: entry.model,
      apiMode: entry.apiMode,
      baseUrl: entry.baseUrl,
      apiKey,
    });
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze an image using the best available vision-capable model.
 *
 * Tries the model-router's vision pick first, then iterates through all
 * vision-capable providers with valid API keys until one succeeds.
 */
export async function analyzeImage(
  imagePath: string,
  prompt = DEFAULT_PROMPT,
  routingContext?: RoutingContext,
): Promise<string> {
  const imageBytes = readFileSync(imagePath);
  const mime = inferMimeType(imagePath);
  const imageBase64 = imageBytes.toString('base64');

  const chain = buildVisionChain(routingContext);
  if (chain.length === 0) {
    throw new Error('No vision-capable provider available (no API keys configured for providers with supportsVision models)');
  }

  let lastError: Error | null = null;
  for (const target of chain) {
    try {
      logger.debug({ provider: target.provider, model: target.model, imagePath, mime }, 'Trying vision provider');
      const result = await callVision(target, imageBase64, mime, prompt);
      logger.info({ provider: target.provider, model: target.model }, 'Vision analysis succeeded');
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn({ provider: target.provider, model: target.model, error: lastError.message }, 'Vision provider failed, trying next');
    }
  }

  throw lastError ?? new Error('All vision providers failed');
}
