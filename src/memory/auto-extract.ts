import pino from 'pino';
import { createHash } from 'node:crypto';
import type { LLMClient, ChatMessage } from '../core/llm.js';
import { getAccessibleFacts, type FactCategory, type MemoryFact } from './long-term.js';
import { extractProjectKnowledge } from './project-context.js';
import {
  applyMemoryMutation,
  type MemoryMutationResult,
  type RequestedMemoryMutationAction,
} from './mutations.js';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';

const logger = pino({ name: 'mozi:memory:auto-extract' });

interface ExtractedMemoryPayload {
  preferences: unknown[];
  facts: unknown[];
  decisions: unknown[];
  corrections: unknown[];
}

export interface MemoryExtractionResult {
  mutations: MemoryMutationResult[];
}

const EXTRACTION_PROMPT = [
  'You extract durable long-term memory from one conversation turn between a user and their assistant.',
  '',
  'Extract into four categories:',
  '- preferences: how the user likes things done — tone, language, format, tools, workflow habits, AND how they phrase requests (e.g. {"key":"report_format","value":"when the user says \'写个报告\' they want a markdown doc, not slides"}).',
  '- facts: stable information about the user or their world — role, projects, environment, people, constraints (e.g. {"key":"deploy_target","value":"production runs on a VPS, deploys via docker compose"}).',
  '- decisions: choices made in this turn that future turns must respect (e.g. {"key":"db_choice","value":"chose SQLite over Postgres for the MVP, revisit at 10k users"}).',
  '- corrections: things the user corrected or pushed back on (e.g. {"key":"no_emoji","value":"user rejected emoji in output; never use emoji"}).',
  '',
  'Quality bar — extract ONLY what will still matter in future conversations:',
  '- Skip session-specific state (current file being edited, transient errors, one-off numbers).',
  '- Skip anything re-derivable from files or code, and pleasantries or meta-chat.',
  '- Skip project architecture, conventions, file paths, and technical decisions; a separate user-only project-memory extractor handles those.',
  '- Skip the assistant\'s own suggestions unless the user confirmed them.',
  '- Write each value as a complete, self-contained statement in the user\'s language — a future reader has no other context.',
  '- Existing memories are supplied with stable numeric ids. If the user repeats the same durable meaning, use action "reinforce" and target_id instead of creating another memory.',
  '- If the user explicitly changes or corrects an existing memory, use action "update" and target_id.',
  '- Use action "add" only for genuinely new durable information. Never emit the same idea in more than one category.',
  '',
  'Output STRICT JSON only, no prose: {"preferences":[{"key":"...","value":"...","action":"add|reinforce|update","target_id":123}],"facts":[],"decisions":[],"corrections":[]}. Omit target_id for add. Use empty arrays when a category has nothing worth keeping — most turns have nothing.',
].join('\n');
const MAX_MEMORY_KEY_LENGTH = 48;
const MIN_MEMORY_KEY_LENGTH = 2;

function contentHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function normalizeKey(input: string, fallbackPrefix: string, _index: number): string {
  const normalized = input.trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    return `${fallbackPrefix}_${contentHash(input)}`;
  }

  if (normalized.length < MIN_MEMORY_KEY_LENGTH) {
    return `${normalized}_${contentHash(input)}`.slice(0, MAX_MEMORY_KEY_LENGTH);
  }

  if (normalized.length > MAX_MEMORY_KEY_LENGTH) {
    const hash = contentHash(input);
    const prefixLength = MAX_MEMORY_KEY_LENGTH - hash.length - 1;
    return `${normalized.slice(0, prefixLength)}_${hash}`;
  }

  return normalized;
}

function normalizeItem(
  item: unknown,
  fallbackPrefix: string,
  index: number,
): { key: string; value: string; requestedAction: RequestedMemoryMutationAction; targetFactId?: number } | null {
  if (typeof item === 'string') {
    const value = item.trim();
    if (!value) return null;
    return {
      key: normalizeKey(value, fallbackPrefix, index),
      value,
      requestedAction: 'ADD',
    };
  }

  if (!item || typeof item !== 'object') {
    return null;
  }

  const record = item as Record<string, unknown>;
  const keyCandidate = typeof record.key === 'string'
    ? record.key
    : (typeof record.subject === 'string' ? record.subject : `${fallbackPrefix}_${index + 1}`);

  const valueCandidate = typeof record.value === 'string'
    ? record.value
    : (typeof record.text === 'string' ? record.text : JSON.stringify(record));

  const key = normalizeKey(keyCandidate, fallbackPrefix, index);
  const value = valueCandidate.trim();
  if (!value) return null;
  const rawAction = typeof record.action === 'string' ? record.action.trim().toUpperCase() : 'ADD';
  const requestedAction: RequestedMemoryMutationAction =
    rawAction === 'REINFORCE' || rawAction === 'UPDATE' ? rawAction : 'ADD';
  const rawTargetId = record.target_id ?? record.targetId;
  const targetFactId = typeof rawTargetId === 'number' && Number.isInteger(rawTargetId) && rawTargetId > 0
    ? rawTargetId
    : undefined;
  return { key, value, requestedAction, ...(targetFactId ? { targetFactId } : {}) };
}

function parseExtractionPayload(content: string): ExtractedMemoryPayload | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return null;
  }

  const jsonBlock = trimmed.slice(jsonStart, jsonEnd + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const payload = parsed as Record<string, unknown>;
  const preferences = Array.isArray(payload.preferences) ? payload.preferences : [];
  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  const corrections = Array.isArray(payload.corrections) ? payload.corrections : [];

  return { preferences, facts, decisions, corrections };
}

function tokenize(text: string): Set<string> {
  const tokens = tokenizeText(text);
  const hasContentToken = tokens.some(token => !isHanToken(token) || hanTokenLength(token) >= 2);
  return new Set(hasContentToken
    ? tokens.filter(token => !isHanToken(token) || hanTokenLength(token) >= 2)
    : tokens);
}

/**
 * Check if two values are substantially similar using Jaccard similarity on tokens.
 * Returns true if similarity > 0.8.
 */
export function isSubstantiallySimilar(existing: string, incoming: string): boolean {
  const a = tokenize(existing);
  const b = tokenize(incoming);
  if (a.size === 0 && b.size === 0) return true;
  if (a.size === 0 || b.size === 0) return false;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union > 0.8 : false;
}

function persistItems(
  chatId: string,
  category: FactCategory,
  items: unknown[],
  fallbackPrefix: string,
  tenantId = 'default',
  source = 'auto_extract',
  userId?: string,
  salienceHint?: number,
  turnId?: string,
): MemoryMutationResult[] {
  const mutations: MemoryMutationResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const normalized = normalizeItem(items[i], fallbackPrefix, i);
    if (!normalized) continue;

    mutations.push(applyMemoryMutation({
      chatId,
      tenantId,
      userId,
      turnId,
      category,
      key: normalized.key,
      value: normalized.value,
      source,
      salienceHint,
      requestedAction: normalized.requestedAction,
      targetFactId: normalized.targetFactId,
    }));
  }
  return mutations;
}

function extractionCandidates(chatId: string, tenantId: string, userId?: string): MemoryFact[] {
  const scope = userId ? { userId, accessibleChatIds: [chatId, '__semantic__'] } : undefined;
  return getAccessibleFacts(tenantId, scope)
    .filter(fact => !fact.chat_id.startsWith('__project__'))
    .sort((a, b) => {
      if (b.salience_score !== a.salience_score) return b.salience_score - a.salience_score;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    })
    .slice(0, 24);
}

/**
 * Extract structured memories from a single turn and persist to long-term memory.
 */
export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  client: LLMClient,
  chatId = 'default',
  tenantId = 'default',
  userId?: string,
  turnId?: string,
): Promise<MemoryExtractionResult> {
  // Skip if client doesn't have chat method
  if (!client || typeof (client as any).chat !== 'function') {
    return { mutations: [] };
  }

  const candidates = extractionCandidates(chatId, tenantId, userId).map(fact => ({
    id: fact.id,
    scope: 'conversation',
    category: fact.category,
    key: fact.key,
    value: fact.value,
  }));

  const extractionMessages: ChatMessage[] = [
    { role: 'system', content: EXTRACTION_PROMPT },
    {
      role: 'user',
      content: `Existing memories (may be empty):\n${JSON.stringify(candidates)}\n\nUser message:\n${userMessage}\n\nAssistant response:\n${assistantResponse}`,
    },
  ];

  const result = await client.chat(extractionMessages, {
    // Structured {key, value} items are longer than the bare strings the old
    // one-line prompt produced; 200 truncated mid-JSON and lost whole turns.
    max_tokens: 400,
    temperature: 0,
  });

  const payload = parseExtractionPayload(result.content);
  if (!payload) {
    logger.debug({ chatId }, 'Auto-extract returned non-JSON payload');
    return { mutations: [] };
  }

  const mutations = [
    ...persistItems(chatId, 'preference', payload.preferences, 'preference', tenantId, 'auto_extract', userId, undefined, turnId),
    ...persistItems(chatId, 'fact', payload.facts, 'fact', tenantId, 'auto_extract', userId, undefined, turnId),
    ...persistItems(chatId, 'decision', payload.decisions, 'decision', tenantId, 'auto_extract', userId, undefined, turnId),
    ...persistItems(chatId, 'fact', payload.corrections, 'correction', tenantId, 'auto_extract_correction', userId, 0.95, turnId),
  ];

  // Also extract project-level knowledge (non-fatal)
  try {
    await extractProjectKnowledge(userMessage, client, { tenantId, userId, chatId, turnId });
  } catch (err) {
    logger.debug({ err }, 'Project knowledge extraction failed (non-fatal)');
  }
  return { mutations };
}
