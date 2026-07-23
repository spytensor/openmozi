/**
 * Context Slots — types, slot specs, and content fitting for context builder.
 *
 * Manages the budget allocation and content fitting for system prompt slots.
 * Pure functions with no I/O except token estimation.
 */

import { estimateTokens } from './token-counter.js';
import type { MemoryFact } from './long-term.js';
import type { ActiveSkillEntry } from '../skills/active-skills.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextSlotName =
  | 'identity'
  | 'user_profile'
  | 'project_knowledge'
  | 'session_deliverables'
  | 'memory_facts'
  | 'turn_memory'
  | 'lessons'
  | 'episodic_digests'
  | 'active_skills'
  | 'skills'
  | 'recent_history';

export type ContextSlotDedupeRule = 'exact' | 'line' | 'message_identity';
export type ContextSlotFreshnessRule =
  | 'immutable'
  | 'live_profile'
  | 'live_project'
  | 'session_timeline'
  | 'stable_revision'
  | 'retrieval_scored'
  | 'context_match'
  | 'recent_14d'
  | 'per_request'
  | 'conversation_tail';
export type ContextSlotFallbackRule = 'trim' | 'omit' | 'summary';
export type ContextSlotFallbackApplied = 'none' | 'trimmed' | 'omitted' | 'summary';

export interface ContextSlotBreakdown {
  name: ContextSlotName;
  priority: number;
  tokenCap: number;
  rawTokens: number;
  usedTokens: number;
  included: boolean;
  itemCount: number;
  dedupeRule: ContextSlotDedupeRule;
  freshnessRule: ContextSlotFreshnessRule;
  fallbackRule: ContextSlotFallbackRule;
  fallbackApplied: ContextSlotFallbackApplied;
}

export interface SlotSpec {
  name: ContextSlotName;
  priority: number;
  tokenCap: number;
  dedupeRule: ContextSlotDedupeRule;
  freshnessRule: ContextSlotFreshnessRule;
  fallbackRule: ContextSlotFallbackRule;
}

export interface SlotContentResult {
  content?: string;
  usedTokens: number;
  itemCount: number;
  fallbackApplied: ContextSlotFallbackApplied;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Slot fitting functions
// ---------------------------------------------------------------------------

export function fitTextSlot(
  content: string | undefined,
  tokenCap: number,
  fallbackRule: ContextSlotFallbackRule = 'trim',
): SlotContentResult {
  if (fallbackRule === 'summary') {
    throw new Error('System context slots do not support summary fallback');
  }
  const trimmed = content?.trim() ?? '';
  if (!trimmed || tokenCap <= 0) {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  const rawTokens = estimateTokens(trimmed);
  if (rawTokens <= tokenCap) {
    return {
      content: trimmed,
      usedTokens: rawTokens,
      itemCount: 1,
      fallbackApplied: 'none',
    };
  }

  if (fallbackRule === 'omit') {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  const lines = trimmed.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = kept.length > 0 ? `${kept.join('\n')}\n${line}` : line;
    if (estimateTokens(candidate) > tokenCap) break;
    kept.push(line);
  }

  if (kept.length > 0) {
    const limited = kept.join('\n').trim();
    return {
      content: limited,
      usedTokens: estimateTokens(limited),
      itemCount: 1,
      fallbackApplied: 'trimmed',
    };
  }

  let approxChars = Math.max(1, tokenCap * 4);
  let limited = trimmed.slice(0, approxChars).trim();
  while (limited && estimateTokens(limited) > tokenCap) {
    approxChars = Math.floor(approxChars * 0.75);
    limited = approxChars > 0 ? trimmed.slice(0, approxChars).trim() : '';
  }
  if (!limited) {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  return {
    content: limited,
    usedTokens: estimateTokens(limited),
    itemCount: 1,
    fallbackApplied: 'trimmed',
  };
}

export function fitLineSlot(
  title: string,
  rawLines: string[],
  tokenCap: number,
  seenLines: Set<string>,
  fallbackRule: ContextSlotFallbackRule = 'trim',
): SlotContentResult {
  if (fallbackRule === 'summary') {
    throw new Error('System context slots do not support summary fallback');
  }
  if (tokenCap <= 0) {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  const uniqueLines: string[] = [];
  const localSeen = new Set<string>();
  for (const line of rawLines) {
    const normalized = normalizeLine(line);
    if (!normalized || seenLines.has(normalized) || localSeen.has(normalized)) continue;
    uniqueLines.push(line);
    localSeen.add(normalized);
  }

  if (uniqueLines.length === 0) {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  const header = `## ${title}`;
  const completeContent = `${header}\n${uniqueLines.join('\n')}`;
  if (fallbackRule === 'omit') {
    if (estimateTokens(completeContent) > tokenCap) {
      return {
        usedTokens: 0,
        itemCount: 0,
        fallbackApplied: 'omitted',
      };
    }
    for (const line of uniqueLines) {
      seenLines.add(normalizeLine(line));
    }
    return {
      content: completeContent,
      usedTokens: estimateTokens(completeContent),
      itemCount: uniqueLines.length,
      fallbackApplied: 'none',
    };
  }

  const kept: string[] = [];
  for (const line of uniqueLines) {
    const candidateBody = kept.length > 0 ? `${kept.join('\n')}\n${line}` : line;
    const candidate = `${header}\n${candidateBody}`;
    if (estimateTokens(candidate) > tokenCap) break;
    kept.push(line);
  }

  if (kept.length === 0) {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  for (const line of kept) {
    seenLines.add(normalizeLine(line));
  }

  const content = `${header}\n${kept.join('\n')}`;
  return {
    content,
    usedTokens: estimateTokens(content),
    itemCount: kept.length,
    fallbackApplied: kept.length < uniqueLines.length ? 'trimmed' : 'none',
  };
}

export function formatActiveSkillSection(skill: Pick<ActiveSkillEntry, 'name' | 'description' | 'instructions'>): string {
  return [
    `### ${skill.name}`,
    skill.description,
    '',
    skill.instructions.trim(),
  ].filter(part => part.length > 0).join('\n');
}

export function fitActiveSkillsSlot(
  skills: ActiveSkillEntry[],
  tokenCap: number,
  fallbackRule: ContextSlotFallbackRule = 'trim',
): SlotContentResult {
  if (fallbackRule === 'summary') {
    throw new Error('System context slots do not support summary fallback');
  }
  if (skills.length === 0 || tokenCap <= 0) {
    return {
      usedTokens: 0,
      itemCount: 0,
      fallbackApplied: 'omitted',
    };
  }

  const header = '## Active Skills';
  const sections = skills.map(formatActiveSkillSection);
  const completeContent = `${header}\n\n${sections.join('\n\n')}`;
  if (fallbackRule === 'omit') {
    const completeTokens = estimateTokens(completeContent);
    return completeTokens <= tokenCap
      ? {
          content: completeContent,
          usedTokens: completeTokens,
          itemCount: sections.length,
          fallbackApplied: 'none',
        }
      : {
          usedTokens: 0,
          itemCount: 0,
          fallbackApplied: 'omitted',
        };
  }

  const kept: string[] = [];
  for (const section of sections) {
    const candidate = `${header}\n\n${[...kept, section].join('\n\n')}`;
    if (estimateTokens(candidate) > tokenCap) break;
    kept.push(section);
  }

  if (kept.length > 0) {
    const content = `${header}\n\n${kept.join('\n\n')}`;
    return {
      content,
      usedTokens: estimateTokens(content),
      itemCount: kept.length,
      fallbackApplied: kept.length < sections.length ? 'trimmed' : 'none',
    };
  }

  const firstSection = `${header}\n\n${sections[0]}`;
  const trimmed = fitTextSlot(firstSection, tokenCap, fallbackRule);
  return {
    ...trimmed,
    itemCount: trimmed.content ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatMemoryFactLines(
  facts: MemoryFact[],
  semanticScores: Map<number, number>,
): string[] {
  return facts.map((fact) => {
    const score = semanticScores.get(fact.id);
    const source = fact.source ?? 'unknown';
    const updated = fact.updated_at || 'unknown';
    const scorePart = typeof score === 'number' ? `; score=${score.toFixed(3)}` : '';
    return `- [${fact.category}] ${fact.key}: ${fact.value} (source=${source}; updated=${updated}${scorePart})`;
  });
}

/**
 * Byte-stable representation for core memory placed in the cacheable system
 * prefix. Retrieval scores, timestamps, sources, and read counters are
 * intentionally excluded: reading memory must not rewrite the next prompt.
 */
export function formatCoreMemoryFactLines(facts: MemoryFact[]): string[] {
  return [...facts]
    .sort((left, right) =>
      left.category.localeCompare(right.category)
      || left.key.localeCompare(right.key)
      || left.id - right.id)
    .map(fact => `- [${fact.category}] ${fact.key}: ${fact.value}`);
}

export function formatLessonLines(
  lessons: Array<{ trigger_pattern: string; lesson: string }>,
): string[] {
  return lessons.map(lesson => `- [${lesson.trigger_pattern}] ${lesson.lesson}`);
}

export function isFreshDigest(createdAt: string, maxAgeDays = 14): boolean {
  const normalized = createdAt.includes('T') ? createdAt : `${createdAt}Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= maxAgeDays * 86_400_000;
}

export function formatDigestLines(
  digests: Array<{ digest: string; open_threads: string[]; created_at: string }>,
): string[] {
  return digests.map((digest) => {
    const date = digest.created_at.slice(0, 10);
    const openPart = digest.open_threads.length > 0 ? ` [Open: ${digest.open_threads.join('; ')}]` : '';
    return `- [${date}] ${digest.digest}${openPart}`;
  });
}

// ---------------------------------------------------------------------------
// Slot specification builder
// ---------------------------------------------------------------------------

/**
 * Allocation order is an executable part of the slot contract. The explicit
 * declaration index keeps equal-priority slots deterministic without relying
 * on the host runtime's Array#sort stability.
 */
export function orderSystemSlotsForAllocation(specs: SlotSpec[]): SlotSpec[] {
  return specs
    .map((spec, declarationIndex) => ({ spec, declarationIndex }))
    .sort((left, right) => (
      right.spec.priority - left.spec.priority
      || left.declarationIndex - right.declarationIndex
    ))
    .map(entry => entry.spec);
}

export function buildSystemSlotSpecs(systemSlotBudget: number): SlotSpec[] {
  // These fractions are independent per-slot ceilings, not reserved shares.
  // They intentionally total 1.38 so several slot types can use a generous cap
  // when peers are empty. The builder's remaining-budget deduction is the hard
  // aggregate boundary. The 256-token floor is likewise only a ceiling floor.
  const cap = (fraction: number) => Math.max(256, Math.floor(systemSlotBudget * fraction));

  return [
    {
      name: 'identity',
      priority: 100,
      tokenCap: cap(0.30),
      dedupeRule: 'exact',
      freshnessRule: 'immutable',
      fallbackRule: 'trim',
    },
    {
      name: 'user_profile',
      priority: 90,
      tokenCap: cap(0.08),
      dedupeRule: 'exact',
      freshnessRule: 'live_profile',
      fallbackRule: 'trim',
    },
    {
      name: 'project_knowledge',
      priority: 85,
      tokenCap: cap(0.10),
      dedupeRule: 'exact',
      freshnessRule: 'live_project',
      fallbackRule: 'trim',
    },
    {
      name: 'session_deliverables',
      priority: 83,
      tokenCap: cap(0.08),
      dedupeRule: 'line',
      freshnessRule: 'session_timeline',
      fallbackRule: 'trim',
    },
    {
      name: 'memory_facts',
      priority: 80,
      tokenCap: cap(0.15),
      dedupeRule: 'line',
      freshnessRule: 'stable_revision',
      fallbackRule: 'trim',
    },
    {
      name: 'turn_memory',
      priority: 78,
      tokenCap: cap(0.10),
      dedupeRule: 'line',
      freshnessRule: 'retrieval_scored',
      fallbackRule: 'trim',
    },
    {
      name: 'lessons',
      priority: 75,
      tokenCap: cap(0.07),
      dedupeRule: 'line',
      freshnessRule: 'context_match',
      fallbackRule: 'trim',
    },
    {
      name: 'episodic_digests',
      priority: 70,
      tokenCap: cap(0.10),
      dedupeRule: 'line',
      freshnessRule: 'recent_14d',
      fallbackRule: 'trim',
    },
    {
      name: 'active_skills',
      priority: 55,
      tokenCap: cap(0.30),
      dedupeRule: 'exact',
      freshnessRule: 'per_request',
      fallbackRule: 'trim',
    },
    {
      name: 'skills',
      priority: 50,
      tokenCap: cap(0.10),
      dedupeRule: 'exact',
      freshnessRule: 'per_request',
      fallbackRule: 'trim',
    },
  ];
}
