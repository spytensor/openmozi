import pino from 'pino';
import type { ChatMessage } from '../core/llm.js';
import { sanitizeToolPairs } from '../gateway/tool-loop-guards.js';
import { buildRuntimeTimeSystemPrompt } from '../core/time-context.js';
import { discoverSkills, formatSkillsForPrompt } from '../skills/loader.js';
import { getConfig } from '../config/index.js';
import { getWorkspaceDir } from '../tools/tool-utils.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { join } from 'node:path';
import { getHistory, getSessionHistoryAfter } from './conversations.js';
import { reduceSessionContext } from './conversation-context-reducer.js';
import { getRankedLessonsForContext } from './lessons.js';
import { getFacts, recordRecall, recallFacts, type MemoryFact } from './long-term.js';
import { getProfileSection } from './user-profile.js';
import { getProjectSection } from './project-context.js';
import { getRecentDigests, searchDigests } from './session-digest.js';
import {
  formatSessionDeliverableLines,
  getVerifiedSessionDeliverables,
} from './session-deliverables.js';
import { estimateTokens } from './token-counter.js';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';
import {
  type ContextSlotBreakdown,
  type SlotContentResult,
  normalizeContent,
  fitTextSlot,
  fitLineSlot,
  fitActiveSkillsSlot,
  formatMemoryFactLines,
  formatCoreMemoryFactLines,
  formatLessonLines,
  isFreshDigest,
  formatDigestLines,
  buildSystemSlotSpecs,
  orderSystemSlotsForAllocation,
} from './context-slots.js';
import {
  activeSkillScope,
  beginActiveSkillUserTurn,
} from '../skills/active-skills.js';
import {
  assembleHistory,
  markHistoricalPhotoAnalysis,
  sanitizeStaleAttachmentPaths,
  isRecentManagedWorkerForChat,
  sanitizeLegacyShellDelegationMessage,
  extractArtifactSummary,
  extractPersistedArtifactSummary,
  isChatRole,
} from './context-history.js';

// Re-export types for backward compatibility
export type {
  ContextSlotName,
  ContextSlotDedupeRule,
  ContextSlotFreshnessRule,
  ContextSlotFallbackRule,
  ContextSlotFallbackApplied,
  ContextSlotBreakdown,
} from './context-slots.js';
export { markHistoricalPhotoAnalysis, sanitizeStaleAttachmentPaths } from './context-history.js';

const logger = pino({ name: 'mozi:context-builder' });

const MAX_FACTS = 20;
const HISTORY_LIMIT = 50;
const DIGEST_FRESHNESS_DAYS = 14;

export interface CompiledContextResult {
  messages: ChatMessage[];
  slotBreakdown: ContextSlotBreakdown[];
  totalBudget: number;
  availableContextBudget: number;
  systemSlotBudget: number;
  historyTokenBudget: number;
}

function tokenize(text: string): Set<string> {
  return new Set(tokenizeText(text).filter(token => !isHanToken(token) || hanTokenLength(token) >= 2));
}

function isRelevantFact(fact: MemoryFact, currentTokens: Set<string>): boolean {
  if (fact.category === 'preference' || fact.category === 'fact') {
    return true;
  }

  if (currentTokens.size === 0) return false;
  const factTokens = tokenize(`${fact.key} ${fact.value}`);
  for (const token of factTokens) {
    if (currentTokens.has(token)) {
      return true;
    }
  }
  return false;
}

function scoreMemoryFact(fact: MemoryFact): number {
  const daysSinceUpdate = (Date.now() - Date.parse(fact.updated_at)) / 86_400_000;
  const recencyWeight = 1.0 / (1 + daysSinceUpdate / 30);
  const recallSignal = Math.min(1, Math.log2(2 + fact.recall_count) / 4);
  const baseScore = (fact.salience_score * 0.5) + (fact.confidence * 0.3) + (recallSignal * 0.2);
  return baseScore * recencyWeight;
}

export async function compileIntelligentContext(
  chatId: string,
  systemPrompt: string,
  currentMessage: string,
  tenantId?: string,
  userId?: string,
  sessionId?: string,
  modelContextWindow?: number,
): Promise<CompiledContextResult> {
  const effectiveTenantId = tenantId ?? 'default';
  const config = getConfig();
  const memoryCfg = config.memory;
  const maxTokens = (config.context?.max_tokens ?? 0) || modelContextWindow || 128_000;
  const compressionThreshold = config.context?.compression_threshold ?? 0.7;
  const recallStrategy = memoryCfg.recall_strategy;
  const currentTokens = tokenize(currentMessage);
  const factsChatId = userId ?? chatId;
  const factAccessScope = userId
    ? { userId, accessibleChatIds: [chatId, factsChatId, '__semantic__'] }
    : undefined;
  const coreFacts: MemoryFact[] = [];
  const turnFacts: MemoryFact[] = [];
  const semanticScores = new Map<number, number>();

  // Core memory is a deterministic cacheable snapshot. Preferences and durable
  // facts are small enough to include directly; query-dependent decisions and
  // lessons belong to the per-turn context below.
  const factLocations = [...new Set([factsChatId, ...(userId && userId !== chatId ? [chatId] : []), '__semantic__'])];
  const coreKeys = new Set<string>();
  const dynamicIds = new Set<number>();
  for (const location of factLocations) {
    for (const fact of getFacts(location, undefined, effectiveTenantId)) {
      const dedupeKey = `${fact.category}:${fact.key}`;
      if (fact.category === 'preference' || fact.category === 'fact') {
        if (!coreKeys.has(dedupeKey)) {
          coreFacts.push(fact);
          coreKeys.add(dedupeKey);
        }
      } else if (
        (recallStrategy === 'keyword' || recallStrategy === 'hybrid')
        && isRelevantFact(fact, currentTokens)
        && !dynamicIds.has(fact.id)
      ) {
        turnFacts.push(fact);
        dynamicIds.add(fact.id);
      }
    }
  }

  if (recallStrategy === 'semantic' || recallStrategy === 'hybrid') {
    const semanticHits = await recallFacts(
      factsChatId,
      currentMessage,
      effectiveTenantId,
      memoryCfg.semantic_top_k,
      factAccessScope,
    );
    for (const hit of semanticHits) {
      if (hit.fact.category === 'preference' || hit.fact.category === 'fact') continue;
      if (
        (hit.fact.category === 'decision' || hit.fact.category === 'lesson')
        && !isRelevantFact(hit.fact, currentTokens)
        && hit.score < 0.35
      ) {
        continue;
      }
      if (!dynamicIds.has(hit.fact.id)) {
        turnFacts.push(hit.fact);
        dynamicIds.add(hit.fact.id);
      }
      semanticScores.set(hit.fact.id, hit.score);
    }
  }

  coreFacts.sort((left, right) => left.category.localeCompare(right.category) || left.key.localeCompare(right.key) || left.id - right.id);
  coreFacts.splice(MAX_FACTS);
  turnFacts.sort((left, right) => {
    const semanticDelta = (semanticScores.get(right.id) ?? 0) - (semanticScores.get(left.id) ?? 0);
    if (semanticDelta !== 0) return semanticDelta;
    return scoreMemoryFact(right) - scoreMemoryFact(left);
  });
  turnFacts.splice(MAX_FACTS);

  try {
    const factIds = turnFacts.map(fact => fact.id).filter(id => id > 0);
    if (factIds.length > 0) {
      recordRecall(factIds);
    }
  } catch {
    // Non-fatal.
  }

  const profileSection = getProfileSection(effectiveTenantId);
  const projectSection = getProjectSection(effectiveTenantId, userId);
  const lessons = getRankedLessonsForContext(currentMessage, effectiveTenantId, 5);
  const loadedSkills = await discoverSkills({
    bundledDir: join(getRuntimeProjectRoot(), 'skills'),
    workspaceDir: join(getWorkspaceDir(), 'skills'),
  });
  const activeSkillScopeId = activeSkillScope({ tenantId: effectiveTenantId, sessionId, chatId });
  const activeSkills = activeSkillScopeId
    ? beginActiveSkillUserTurn(activeSkillScopeId)
    : [];
  const skillSection = formatSkillsForPrompt(loadedSkills);

  const digestLines: string[] = [];
  if (userId) {
    try {
      const recentDigests = getRecentDigests(userId, effectiveTenantId, DIGEST_FRESHNESS_DAYS, 5);
      const semanticDigests = searchDigests(userId, currentMessage, effectiveTenantId, 3);
      const seenSessionIds = new Set<string>();
      const mergedDigests: Array<{ digest: string; open_threads: string[]; created_at: string; session_id: string }> = [];

      for (const digest of [...recentDigests, ...semanticDigests]) {
        if (seenSessionIds.has(digest.session_id) || !isFreshDigest(digest.created_at)) continue;
        seenSessionIds.add(digest.session_id);
        mergedDigests.push(digest);
      }

      digestLines.push(...formatDigestLines(mergedDigests));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg }, 'Failed to load session digests');
    }
  }

  let sessionDeliverableLines: string[] = [];
  if (userId && sessionId) {
    try {
      sessionDeliverableLines = formatSessionDeliverableLines(getVerifiedSessionDeliverables({
        tenantId: effectiveTenantId,
        userId,
        sessionId,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg, tenantId: effectiveTenantId, userId, sessionId }, 'Failed to load verified session deliverables');
    }
  }

  const totalBudget = Math.floor(maxTokens * compressionThreshold);
  const currentMessageTokens = estimateTokens(currentMessage);
  const availableContextBudget = Math.max(0, totalBudget - currentMessageTokens);
  const systemSlotBudget = availableContextBudget > 0
    ? Math.min(availableContextBudget, Math.max(768, Math.floor(availableContextBudget * 0.6)))
    : 0;

  const seenExactContent = new Set<string>();
  const seenLines = new Set<string>();
  const slotContents = new Map<string, string>();
  const slotBreakdown: ContextSlotBreakdown[] = [];
  let remainingSystemBudget = systemSlotBudget;

  const slotSpecs = orderSystemSlotsForAllocation(buildSystemSlotSpecs(systemSlotBudget));
  for (const slot of slotSpecs) {
    const effectiveTokenCap = Math.min(slot.tokenCap, remainingSystemBudget);
    let rawTokens = 0;
    let compiled: SlotContentResult = {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: effectiveTokenCap > 0 ? 'omitted' : 'omitted',
    };

    if (slot.name === 'identity') {
      rawTokens = estimateTokens(systemPrompt);
      const normalized = normalizeContent(systemPrompt);
      if (normalized && !seenExactContent.has(normalized) && effectiveTokenCap > 0) {
        compiled = fitTextSlot(systemPrompt, effectiveTokenCap, slot.fallbackRule);
        if (compiled.content) {
          seenExactContent.add(normalized);
        }
      }
    } else if (slot.name === 'user_profile') {
      rawTokens = profileSection ? estimateTokens(profileSection) : 0;
      const normalized = normalizeContent(profileSection ?? '');
      if (profileSection && !seenExactContent.has(normalized) && effectiveTokenCap > 0) {
        compiled = fitTextSlot(profileSection, effectiveTokenCap, slot.fallbackRule);
        if (compiled.content) {
          seenExactContent.add(normalized);
        }
      }
    } else if (slot.name === 'project_knowledge') {
      rawTokens = projectSection ? estimateTokens(projectSection) : 0;
      const normalized = normalizeContent(projectSection ?? '');
      if (projectSection && !seenExactContent.has(normalized) && effectiveTokenCap > 0) {
        compiled = fitTextSlot(projectSection, effectiveTokenCap, slot.fallbackRule);
        if (compiled.content) {
          seenExactContent.add(normalized);
        }
      }
    } else if (slot.name === 'session_deliverables') {
      rawTokens = sessionDeliverableLines.length > 0
        ? estimateTokens(`## Current Session Deliverables\n${sessionDeliverableLines.join('\n')}`)
        : 0;
      compiled = fitLineSlot(
        'Current Session Deliverables',
        sessionDeliverableLines,
        effectiveTokenCap,
        seenLines,
        slot.fallbackRule,
      );
    } else if (slot.name === 'memory_facts') {
      const lines = formatCoreMemoryFactLines(coreFacts);
      rawTokens = lines.length > 0 ? estimateTokens(`## What I Remember\n${lines.join('\n')}`) : 0;
      compiled = fitLineSlot('What I Remember', lines, effectiveTokenCap, seenLines, slot.fallbackRule);
    } else if (slot.name === 'turn_memory') {
      const lines = formatMemoryFactLines(turnFacts, semanticScores);
      rawTokens = lines.length > 0 ? estimateTokens(`## Relevant Memory For This Turn\n${lines.join('\n')}`) : 0;
      compiled = fitLineSlot('Relevant Memory For This Turn', lines, effectiveTokenCap, seenLines, slot.fallbackRule);
    } else if (slot.name === 'lessons') {
      const lines = formatLessonLines(lessons);
      rawTokens = lines.length > 0
        ? estimateTokens(`## Lessons Learned\nThese are past observations for reference only. Always prioritize executing the user's current request.\n${lines.join('\n')}`)
        : 0;
      const lessonLines = [
        "These are past observations for reference only. Always prioritize executing the user's current request.",
        ...lines,
      ];
      compiled = fitLineSlot('Lessons Learned', lessonLines, effectiveTokenCap, seenLines, slot.fallbackRule);
    } else if (slot.name === 'episodic_digests') {
      rawTokens = digestLines.length > 0 ? estimateTokens(`## Recent Sessions\n${digestLines.join('\n')}`) : 0;
      compiled = fitLineSlot('Recent Sessions', digestLines, effectiveTokenCap, seenLines, slot.fallbackRule);
    } else if (slot.name === 'active_skills') {
      rawTokens = activeSkills.length > 0
        ? estimateTokens(`## Active Skills\n\n${activeSkills.map(skill => `${skill.name}\n${skill.description}\n${skill.instructions}`).join('\n\n')}`)
        : 0;
      if (activeSkills.length > 0 && effectiveTokenCap > 0) {
        compiled = fitActiveSkillsSlot(activeSkills, effectiveTokenCap, slot.fallbackRule);
      }
    } else if (slot.name === 'skills') {
      rawTokens = skillSection ? estimateTokens(skillSection) : 0;
      const normalized = normalizeContent(skillSection ?? '');
      if (skillSection && !seenExactContent.has(normalized) && effectiveTokenCap > 0) {
        compiled = fitTextSlot(skillSection, effectiveTokenCap, slot.fallbackRule);
        if (compiled.content) {
          seenExactContent.add(normalized);
        }
      }
    }

    if (compiled.content) {
      slotContents.set(slot.name, compiled.content);
      remainingSystemBudget = Math.max(0, remainingSystemBudget - compiled.usedTokens);
    }

    slotBreakdown.push({
      name: slot.name,
      priority: slot.priority,
      tokenCap: effectiveTokenCap,
      rawTokens,
      usedTokens: compiled.usedTokens,
      included: Boolean(compiled.content),
      itemCount: compiled.itemCount,
      dedupeRule: slot.dedupeRule,
      freshnessRule: slot.freshnessRule,
      fallbackRule: slot.fallbackRule,
      fallbackApplied: compiled.fallbackApplied,
    });
  }

  // Budget priority and message placement are separate. Stable content stays
  // in the first system message; volatile content is emitted after append-only
  // history so providers that preserve interleaved system/developer messages
  // can cache both the stable prefix and prior conversation.
  const stableSlotEmissionOrder: string[] = [
    'identity',
    'skills',
    'project_knowledge',
    'user_profile',
    'memory_facts',
  ];
  const volatileSlotEmissionOrder: string[] = [
    'session_deliverables',
    'episodic_digests',
    'turn_memory',
    'lessons',
    'active_skills',
  ];
  const stableParts = stableSlotEmissionOrder
    .map(name => slotContents.get(name))
    .filter((part): part is string => Boolean(part));
  const volatileParts = volatileSlotEmissionOrder
    .map(name => slotContents.get(name))
    .filter((part): part is string => Boolean(part));

  const compiledSystemPrompt = stableParts.join('\n\n').trim();
  const turnContext = [
    ...volatileParts,
    buildRuntimeTimeSystemPrompt(),
  ].filter(Boolean).join('\n\n').trim();
  // Scope history to the current session when available so prior sessions
  // for the same chat_id don't bleed into the active conversation.
  const historyRows = sessionId
    ? getSessionHistoryAfter(sessionId, 0, effectiveTenantId)
    : getHistory(chatId, HISTORY_LIMIT, effectiveTenantId);
  const hasRecentManagedWorkerJob = isRecentManagedWorkerForChat(chatId, effectiveTenantId);
  if (
    historyRows.length > 0
    && historyRows[historyRows.length - 1].role === 'user'
    && historyRows[historyRows.length - 1].content === currentMessage
  ) {
    historyRows.pop();
  }

  const reducerMessages = historyRows
    .filter(row => isChatRole(row.role))
    .map((row) => {
      const role = row.role as ChatMessage['role'];
      if (row.role === 'tool') {
        const persistedArtifactSummary = extractPersistedArtifactSummary(row.content);
        if (persistedArtifactSummary) {
          return { stored: row, message: {
            role: 'assistant' as const,
            content: `[Artifact Summary] ${persistedArtifactSummary}`,
          } };
        }
      }
      let content = markHistoricalPhotoAnalysis(sanitizeStaleAttachmentPaths(row.content));
      if (!hasRecentManagedWorkerJob && row.role === 'assistant') {
        content = sanitizeLegacyShellDelegationMessage(content);
      }
      if (row.role !== 'assistant') {
        return { stored: row, message: { role, content } };
      }
      const artifactSummary = extractArtifactSummary(content);
      if (!artifactSummary) {
        return { stored: row, message: { role: row.role as ChatMessage['role'], content } };
      }
      return { stored: row, message: {
        role: 'assistant' as const,
        content: `[Artifact Summary] ${artifactSummary}`,
      } };
    });
  const historyMessages = reducerMessages.map(entry => entry.message);

  const systemTokens = estimateTokens(compiledSystemPrompt);
  const turnContextTokens = estimateTokens(turnContext);
  const historyTokenBudget = Math.max(0, availableContextBudget - systemTokens - turnContextTokens);
  const assembledHistory = sessionId && userId
    ? await reduceSessionContext({
        tenantId: effectiveTenantId,
        userId,
        sessionId,
        chatId,
        messages: reducerMessages,
        historyTokenBudget,
        baseTokenCount: systemTokens + turnContextTokens + currentMessageTokens,
        modelContextWindow: maxTokens,
        threshold: compressionThreshold,
      })
    : await assembleHistory(historyMessages, historyTokenBudget);
  slotBreakdown.push({
    name: 'recent_history',
    priority: 40,
    tokenCap: historyTokenBudget,
    rawTokens: assembledHistory.rawTokens,
    usedTokens: assembledHistory.usedTokens,
    included: assembledHistory.messages.length > 0,
    itemCount: assembledHistory.itemCount,
    dedupeRule: 'message_identity',
    freshnessRule: 'conversation_tail',
    fallbackRule: 'summary',
    fallbackApplied: assembledHistory.fallbackApplied,
  });

  logger.debug({
    totalBudget,
    currentMessageTokens,
    availableContextBudget,
    systemSlotBudget,
    historyTokenBudget,
    slotBreakdown,
  }, 'Context compiled into slots');

  const messages = sanitizeToolPairs([
    { role: 'system', content: compiledSystemPrompt },
    ...assembledHistory.messages,
    ...(turnContext ? [{ role: 'system' as const, content: turnContext }] : []),
    { role: 'user', content: currentMessage },
  ]);

  return {
    messages,
    slotBreakdown,
    totalBudget,
    availableContextBudget,
    systemSlotBudget,
    historyTokenBudget,
  };
}

export async function buildIntelligentContext(
  chatId: string,
  systemPrompt: string,
  currentMessage: string,
  tenantId?: string,
  userId?: string,
  sessionId?: string,
): Promise<ChatMessage[]> {
  const compiled = await compileIntelligentContext(
    chatId,
    systemPrompt,
    currentMessage,
    tenantId,
    userId,
    sessionId,
  );
  return compiled.messages;
}
