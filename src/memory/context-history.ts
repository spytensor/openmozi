/**
 * Context History — history assembly, sanitization, and compression.
 *
 * Handles loading, sanitizing, and compressing conversation history
 * to fit within the context budget. Used by context-builder.ts.
 */

import pino from 'pino';
import { readFileSync } from 'node:fs';
import type { ChatMessage } from '../core/llm.js';
import { getTextContent } from '../core/llm.js';
import { compress as compressSummary } from '../core/running-summary.js';
import { parseArtifactMarker } from '../artifacts/marker.js';
import { estimateMessagesTokens, estimateTokens } from './token-counter.js';
import { getLatestExternalWorkerJobForChat } from '../workers/job-state.js';
import type { ContextSlotFallbackApplied } from './context-slots.js';

const logger = pino({ name: 'mozi:context-builder' });
const DEFAULT_PERSISTED_ARTIFACT_CONTEXT_CHARS = 4000;
const HARD_PERSISTED_ARTIFACT_CONTEXT_CHARS = 8000;
const MIN_FULL_ARTIFACT_CONTEXT_TOKENS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryAssemblyResult {
  messages: ChatMessage[];
  rawTokens: number;
  usedTokens: number;
  itemCount: number;
  fallbackApplied: ContextSlotFallbackApplied;
}

export interface PersistedArtifactSummaryOptions {
  contentCharLimit?: number;
  remainingTokenBudget?: number;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Regex matching stale attachment paths from workspace tmp dir.
 * Pattern: absolute path ending in  /tmp/<timestamp>-<random>-<filename>
 * where path contains .mozi/workspace or any workspace-style tmp dir.
 *
 * Captures the trailing filename portion (after the last dash-group)
 * so we can produce a readable placeholder.
 */
const STALE_ATTACHMENT_PATH_RE =
  /(?:\/[^\s"'<>]+\/\.mozi\/workspace|\/[^\s"'<>]*workspace|workspace)\/tmp\/\d{6,}-[a-z0-9]+-([^\s"'<>:,;)}\]]+)/gi;
const GENERATED_ATTACHMENT_BASENAME_RE =
  /\b\d{6,}-[a-z0-9]+-([a-z0-9_-]+\.(?:jpe?g|png|gif|webp|pdf|txt|md|csv|json|ya?ml|ogg|mp3|mp4|webm))\b/gi;
const OPAQUE_ATTACHMENT_NAME_RE =
  /^[a-z0-9_-]{20,}\.(?:jpe?g|png|gif|webp|pdf|txt|md|csv|json|ya?ml|ogg|mp3|mp4|webm)$/i;
const PHOTO_ANALYSIS_HEADING_RE = /^Photo Analysis:/gm;
const CURRENT_PHOTO_ANALYSIS_HEADING_RE = /^Current Photo Analysis \(attached to this message\):/gm;
const LEGACY_SHELL_DELEGATION_PATTERNS = [
  /process_id:\s*[a-f0-9-]{8,}/i,
  /\bprocess_status\b/i,
  /\bprocess_output\b/i,
  /\bshell_exec_bg\b/i,
  /background process started/i,
  /后台.{0,12}(启动|进程|审查任务|状态)/,
  /(Claude Code|Codex CLI|Gemini CLI).{0,20}(后台|background)/i,
];
const RECENT_MANAGED_WORKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Neutralise stale absolute attachment paths in persisted message content.
 *
 * Historical messages may contain paths like
 *   /home/user/.mozi/workspace/tmp/1234567890-abc123-photo.jpg
 * that point to temp files deleted on restart.  Replace them with a safe
 * placeholder so the Brain does not try to operate on missing files.
 *
 * Normal code/file paths and non-workspace paths are left untouched.
 */
export function sanitizeStaleAttachmentPaths(content: string): string {
  return content
    .replace(STALE_ATTACHMENT_PATH_RE, (_match, filename: string) => formatAttachmentPlaceholder(filename))
    .replace(GENERATED_ATTACHMENT_BASENAME_RE, (_match, filename: string) => formatAttachmentPlaceholder(filename));
}

export function markHistoricalPhotoAnalysis(content: string): string {
  return content
    .replace(
      CURRENT_PHOTO_ANALYSIS_HEADING_RE,
      'Historical Photo Analysis (previous turn; not attached to the current message):',
    )
    .replace(
      PHOTO_ANALYSIS_HEADING_RE,
      'Historical Photo Analysis (previous turn; not attached to the current message):',
    );
}

function formatAttachmentPlaceholder(filename: string): string {
  if (OPAQUE_ATTACHMENT_NAME_RE.test(filename)) {
    return '[attachment file omitted]';
  }
  return `[attachment: ${filename}]`;
}

export function isRecentManagedWorkerForChat(chatId: string, tenantId: string): boolean {
  const latest = getLatestExternalWorkerJobForChat(chatId, tenantId);
  if (!latest) return false;
  const updatedMs = Date.parse(latest.updated_at);
  if (!Number.isFinite(updatedMs)) return false;
  return Date.now() - updatedMs <= RECENT_MANAGED_WORKER_MAX_AGE_MS;
}

export function sanitizeLegacyShellDelegationMessage(content: string): string {
  if (!LEGACY_SHELL_DELEGATION_PATTERNS.some(pattern => pattern.test(content))) {
    return content;
  }
  return '[Legacy shell-based delegation omitted by runtime: no active managed worker job exists for this chat.]';
}

export function extractArtifactSummary(content: string): string | null {
  const artifact = parseArtifactMarker(content);
  if (!artifact) return null;

  const data = artifact.data as Record<string, unknown>;
  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  if (summary.length > 0) return summary;

  const fallback = artifact.fallback_text.trim();
  return fallback.length > 0 ? fallback : null;
}

function compactArtifactText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function resolvePersistedArtifactContentCharLimit(configured?: number): number {
  const envValue = Number(process.env.MOZI_ARTIFACT_CONTEXT_CHAR_LIMIT ?? '');
  const value = typeof configured === 'number' && Number.isFinite(configured)
    ? configured
    : Number.isFinite(envValue) && envValue > 0
      ? envValue
      : DEFAULT_PERSISTED_ARTIFACT_CONTEXT_CHARS;
  return Math.max(0, Math.min(Math.floor(value), HARD_PERSISTED_ARTIFACT_CONTEXT_CHARS));
}

function persistedArtifactPath(artifact: Record<string, unknown>, data: Record<string, unknown>): string {
  const path = artifact.persisted_path ?? data.persisted_path;
  return typeof path === 'string' ? path.trim() : '';
}

function persistedArtifactVersionNumber(artifact: Record<string, unknown>, data: Record<string, unknown>): number {
  const value = artifact.version_number ?? data.version_number;
  const version = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function compactPersistedArtifactSummary(artifact: Record<string, unknown>, data: Record<string, unknown>): string {
  const title = compactArtifactText(artifact.title, 96) || 'Untitled artifact';
  const contentType = compactArtifactText(data.content_type ?? artifact.content_type, 48);
  const summary = compactArtifactText(data.summary ?? artifact.summary ?? artifact.fallback_text, 160);
  const descriptor = contentType ? `${title} (${contentType})` : title;
  return summary ? `[Artifact: ${descriptor}] ${summary}` : `[Artifact: ${descriptor}]`;
}

export function extractPersistedArtifactSummary(
  content: string,
  options: PersistedArtifactSummaryOptions = {},
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const artifact = parsed as Record<string, unknown>;
  if (artifact._artifact !== true) return null;

  const data = artifact.data && typeof artifact.data === 'object' && !Array.isArray(artifact.data)
    ? artifact.data as Record<string, unknown>
    : {};
  const compactSummary = compactPersistedArtifactSummary(artifact, data);
  const persistedPath = persistedArtifactPath(artifact, data);
  if (!persistedPath) return compactSummary;

  const remainingBudget = options.remainingTokenBudget;
  if (remainingBudget !== undefined && remainingBudget < MIN_FULL_ARTIFACT_CONTEXT_TOKENS) {
    return compactSummary;
  }

  try {
    const fileContent = readFileSync(persistedPath, 'utf-8');
    const configuredLimit = resolvePersistedArtifactContentCharLimit(options.contentCharLimit);
    const budgetLimit = remainingBudget === undefined
      ? configuredLimit
      : Math.min(configuredLimit, Math.max(0, Math.floor(remainingBudget * 4)));
    const injectedContent = fileContent.slice(0, budgetLimit);
    const title = compactArtifactText(artifact.title, 96) || 'Untitled artifact';
    const contentType = compactArtifactText(data.content_type ?? artifact.content_type, 48);
    const descriptor = contentType ? `${title} (${contentType})` : title;
    const versionNumber = persistedArtifactVersionNumber(artifact, data);
    const truncatedNote = injectedContent.length < fileContent.length
      ? `\n[Content truncated at ${injectedContent.length} of ${fileContent.length} chars]`
      : '';
    return [
      `[Artifact: ${descriptor}]`,
      `[Full content from v${versionNumber} — ${injectedContent.length} chars injected for iteration context]`,
      `${injectedContent}${truncatedNote}`,
    ].join('\n');
  } catch (err) {
    logger.warn({
      err: err instanceof Error ? err.message : String(err),
      persistedPath,
    }, 'Failed to read persisted artifact content; using compact summary');
    return compactSummary;
  }
}

export function isChatRole(role: string): role is ChatMessage['role'] {
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool';
}

// ---------------------------------------------------------------------------
// History assembly
// ---------------------------------------------------------------------------

export async function assembleHistory(
  historyMessages: ChatMessage[],
  historyTokenBudget: number,
): Promise<HistoryAssemblyResult> {
  const rawTokens = estimateMessagesTokens(historyMessages);

  if (historyMessages.length === 0 || historyTokenBudget <= 0 && historyMessages.length === 0) {
    return {
      messages: [],
      rawTokens,
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  if (historyTokenBudget > 0 && rawTokens <= historyTokenBudget) {
    return {
      messages: historyMessages,
      rawTokens,
      usedTokens: rawTokens,
      itemCount: historyMessages.length,
      fallbackApplied: 'none',
    };
  }

  let tokensUsed = 0;
  let splitIndex = historyMessages.length;

  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const historyMessage = historyMessages[i];
    let messageTokens = estimateTokens(getTextContent(historyMessage)) + 4;
    const toolCalls = (historyMessage as unknown as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        const fn = (toolCall as Record<string, unknown>).function as Record<string, unknown> | undefined;
        if (fn) {
          messageTokens += estimateTokens(String(fn.name ?? '')) + estimateTokens(String(fn.arguments ?? ''));
        }
      }
    }
    if (tokensUsed + messageTokens > historyTokenBudget) {
      splitIndex = i + 1;
      break;
    }
    tokensUsed += messageTokens;
    if (i === 0) splitIndex = 0;
  }

  const keptMessages = historyMessages.slice(splitIndex);
  const olderMessages = historyMessages.slice(0, splitIndex);

  if (olderMessages.length === 0) {
    const usedTokens = estimateMessagesTokens(keptMessages);
    return {
      messages: keptMessages,
      rawTokens,
      usedTokens,
      itemCount: keptMessages.length,
      fallbackApplied: 'none',
    };
  }

  try {
    const result = await compressSummary(olderMessages, 1, 0);
    if (result.summary) {
      const summaryMessages: ChatMessage[] = [
        { role: 'system', content: `[Conversation Summary]\n${result.summary}` },
        ...keptMessages,
      ];
      logger.info({
        compressed: olderMessages.length,
        kept: keptMessages.length,
        summary_tokens: result.summary_tokens,
      }, 'History compressed via running-summary');
      return {
        messages: summaryMessages,
        rawTokens,
        usedTokens: estimateMessagesTokens(summaryMessages),
        itemCount: summaryMessages.length,
        fallbackApplied: 'summary',
      };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, 'Running summary compression failed, using truncation fallback');
  }

  const fallbackSummary = olderMessages
    .map(message => `${message.role}: ${getTextContent(message).replace(/\s+/g, ' ').trim().slice(0, 100)}`)
    .join(' | ')
    .slice(0, 1200);

  if (!fallbackSummary) {
    return {
      messages: keptMessages,
      rawTokens,
      usedTokens: estimateMessagesTokens(keptMessages),
      itemCount: keptMessages.length,
      fallbackApplied: keptMessages.length > 0 ? 'trimmed' : 'omitted',
    };
  }

  const summaryMessages: ChatMessage[] = [
    { role: 'system', content: `[Compressed History] ${fallbackSummary}` },
    ...keptMessages,
  ];

  return {
    messages: summaryMessages,
    rawTokens,
    usedTokens: estimateMessagesTokens(summaryMessages),
    itemCount: summaryMessages.length,
    fallbackApplied: 'summary',
  };
}
