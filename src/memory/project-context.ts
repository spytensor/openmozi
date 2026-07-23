import pino from 'pino';
import { saveFact, getFacts, deleteFact, type FactCategory, type MemoryFact } from './long-term.js';
import { applyMemoryMutation, type RequestedMemoryMutationAction } from './mutations.js';
import type { LLMClient, ChatMessage } from '../core/llm.js';

const logger = pino({ name: 'mozi:memory:project-context' });

/** Stable project namespace. Facts inside it remain user-scoped. */
export const PROJECT_CHAT_ID = '__project__';

/** User-specific namespace avoids cross-user collisions under the legacy unique key. */
export function projectChatId(userId?: string): string {
  return userId ? `${PROJECT_CHAT_ID}:${userId}` : PROJECT_CHAT_ID;
}

/**
 * Save a project-level fact. When userId is present it is shared across that
 * user's sessions without becoming tenant-global.
 */
export function saveProjectFact(
  key: string,
  value: string,
  category: FactCategory = 'fact',
  source?: string,
  tenantId = 'default',
  userId?: string,
): void {
  saveFact(projectChatId(userId), category, key, value, source, tenantId, userId, undefined, 'active', userId ? 'user' : 'legacy');
}

/**
 * Get project-level facts, optionally filtered by category.
 */
export function getProjectFacts(
  category?: FactCategory,
  tenantId = 'default',
  userId?: string,
  includeInactive = false,
): MemoryFact[] {
  const scope = userId ? { userId, accessibleChatIds: [] } : undefined;
  return getFacts(projectChatId(userId), category, tenantId, scope, includeInactive);
}

/**
 * Delete a project-level fact.
 */
export function deleteProjectFact(
  key: string,
  category: FactCategory,
  tenantId = 'default',
): void {
  deleteFact(PROJECT_CHAT_ID, category, key, tenantId);
}

/**
 * Build the project knowledge section for injection into the system prompt.
 * Returns empty string if no project facts exist.
 */
export function getProjectSection(tenantId = 'default', userId?: string): string {
  const facts = getProjectFacts(undefined, tenantId, userId);
  if (facts.length === 0) return '';

  const groups: Record<string, MemoryFact[]> = {
    architecture: [],
    conventions: [],
    decisions: [],
    lessons: [],
  };

  for (const fact of facts) {
    switch (fact.category) {
      case 'fact':
        groups.architecture.push(fact);
        break;
      case 'preference':
        groups.conventions.push(fact);
        break;
      case 'decision':
        groups.decisions.push(fact);
        break;
      case 'lesson':
        groups.lessons.push(fact);
        break;
    }
  }

  const sections: string[] = ['## Project Knowledge'];

  if (groups.architecture.length > 0) {
    sections.push('### Architecture');
    for (const f of groups.architecture) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  if (groups.conventions.length > 0) {
    sections.push('### Conventions');
    for (const f of groups.conventions) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  if (groups.decisions.length > 0) {
    sections.push('### Decisions');
    for (const f of groups.decisions) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  if (groups.lessons.length > 0) {
    sections.push('### Lessons');
    for (const f of groups.lessons) {
      sections.push(`- [${f.category}] ${f.key}: ${f.value}`);
    }
  }

  return sections.join('\n');
}

const PROJECT_EXTRACTION_PROMPT = `Extract durable project-level knowledge asserted by the USER in this turn.
Look for information about:
- Tech stack / frameworks (e.g. "this project uses React", "we use PostgreSQL")
- Architecture patterns (e.g. "the API follows REST", "we use a monorepo")
- Project conventions (e.g. "always use pnpm", "tests go in __tests__")
- Key file paths (e.g. "the main entry is src/index.ts")
- Architectural decisions (e.g. "we chose SQLite over PostgreSQL for simplicity")
- Project lessons learned (e.g. "avoid using ORM X because of performance issues")

Classify each item into one of these categories:
- "fact": project architecture, tech stack, key files
- "preference": code conventions, tool preferences
- "decision": architectural decisions
- "lesson": project-specific lessons learned

Existing project memories are supplied with stable numeric ids. For a repeated claim use action "reinforce" and target_id. For an explicit correction use action "update" and target_id. Use "add" only for new information.
Never infer facts from an assistant statement. Never promote an assistant suggestion unless the user explicitly confirms it in the supplied user message.

Output JSON only: {"items":[{"key":"short_key","value":"description","category":"fact|preference|decision|lesson","action":"add|reinforce|update","target_id":123}]}
Empty array if no project-level knowledge found.
Only extract information clearly about the PROJECT, not user personal preferences.`;

export interface ProjectExtractionContext {
  tenantId?: string;
  userId?: string;
  chatId?: string;
  turnId?: string;
}

/**
 * Use LLM to extract project-level knowledge from a conversation turn.
 * Returns the number of extracted facts.
 */
export async function extractProjectKnowledge(
  userMessage: string,
  client: LLMClient,
  context: ProjectExtractionContext = {},
): Promise<number> {
  if (!client || typeof client.chat !== 'function' || !context.userId) {
    return 0;
  }

  const tenantId = context.tenantId ?? 'default';
  const candidates = getProjectFacts(undefined, tenantId, context.userId).map(fact => ({
    id: fact.id,
    category: fact.category,
    key: fact.key,
    value: fact.value,
  }));

  const messages: ChatMessage[] = [
    { role: 'system', content: PROJECT_EXTRACTION_PROMPT },
    {
      role: 'user',
      content: `Existing project memories (may be empty):\n${JSON.stringify(candidates)}\n\nUser message:\n${userMessage}`,
    },
  ];

  let response;
  try {
    response = await client.chat(messages, { max_tokens: 300, temperature: 0 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, 'Project knowledge extraction LLM call failed');
    return 0;
  }

  const content = response.content.trim();
  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    logger.debug('Project knowledge extraction returned non-JSON');
    return 0;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  } catch {
    logger.debug('Project knowledge extraction JSON parse failed');
    return 0;
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const validCategories = new Set<string>(['fact', 'preference', 'decision', 'lesson']);
  let count = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key.trim() : '';
    const value = typeof rec.value === 'string' ? rec.value.trim() : '';
    const category = typeof rec.category === 'string' ? rec.category.trim() : '';
    const rawAction = typeof rec.action === 'string' ? rec.action.trim().toUpperCase() : 'ADD';
    const requestedAction: RequestedMemoryMutationAction = rawAction === 'REINFORCE' || rawAction === 'UPDATE'
      ? rawAction
      : 'ADD';
    const rawTargetId = rec.target_id ?? rec.targetId;
    const targetFactId = typeof rawTargetId === 'number' && Number.isInteger(rawTargetId) && rawTargetId > 0
      ? rawTargetId
      : undefined;

    if (!key || !value || !validCategories.has(category)) continue;

    applyMemoryMutation({
      chatId: projectChatId(context.userId),
      tenantId,
      userId: context.userId,
      turnId: context.turnId,
      category: category as FactCategory,
      key,
      value,
      source: requestedAction === 'UPDATE' ? 'project_user_correction' : 'project_user_assertion',
      requestedAction,
      targetFactId,
      salienceHint: category === 'lesson' ? 0.8 : 0.7,
      status: 'active',
      originKind: 'user',
      candidateScope: 'chat',
    });
    count++;
  }

  if (count > 0) {
    logger.info({ count, tenantId }, 'Extracted project-level knowledge');
  }

  return count;
}
