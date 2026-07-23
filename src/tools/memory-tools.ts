import { getConfig } from '../config/index.js';
import { getFacts, recallFacts } from '../memory/long-term.js';
import type { FactCategory, MemoryFact } from '../memory/long-term.js';
import { saveLesson } from '../memory/lessons.js';
import { searchDigests } from '../memory/session-digest.js';
import { applyMemoryMutation } from '../memory/mutations.js';
import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';

// ── Definitions ──

export const rememberTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'remember',
    description: [
      // Confirmed incident (2026-07-18/19): "key facts" in the old description
      // invited plan steps to store bond-market findings and arithmetic
      // intermediates as the user's personal memory. The description must
      // define memory-worthiness, not just list categories.
      'Store a durable fact about the user in long-term memory. Memory is the',
      'user\'s biography, not a task workspace: store only what the user disclosed',
      'about themselves or their world — role, projects, people, environment,',
      'constraints, preferences, decisions they made. Apply this test before',
      'storing: would the user expect their assistant to already know this in a',
      'NEW conversation next week? Anything produced by your own work always',
      'fails the test — step results, calculations, research findings, market',
      'data, analysis conclusions belong to the task (the runtime persists task',
      'results separately), never to memory. Do not store session-specific',
      'temporary state or trivially re-discoverable information.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Category of the fact: "preference", "fact", "decision", or "lesson"',
          enum: ['preference', 'fact', 'decision', 'lesson'],
        },
        key: {
          type: 'string',
          description: 'A short identifier for the fact (e.g. "favorite_language", "project_deadline")',
        },
        value: {
          type: 'string',
          description: 'The value or content to remember',
        },
      },
      required: ['category', 'key', 'value'],
      additionalProperties: false,
    },
  },
};

export const recallTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'recall',
    description: 'Retrieve stored facts from long-term memory. Small memory sets use local SQLite search; larger sets can use an explicitly configured embedding index. Results include source and timestamp grounding.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Semantic retrieval query text (recommended for hybrid/semantic recall)',
        },
        category: {
          type: 'string',
          description: 'Filter by category: "preference", "fact", "decision", or "lesson"',
          enum: ['preference', 'fact', 'decision', 'lesson'],
        },
        key: {
          type: 'string',
          description: 'Filter by specific key',
        },
        top_k: {
          type: 'number',
          description: 'Maximum results to return (1-50)',
        },
        strategy: {
          type: 'string',
          enum: ['keyword', 'semantic', 'hybrid'],
          description: 'Recall strategy override (default from config.memory.recall_strategy)',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const learnLessonTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'learn_lesson',
    description: 'Save a lesson learned from a trigger pattern for future requests. The trigger describes when this lesson applies; the lesson is the actionable takeaway. Do NOT store obvious things or user-specific preferences (use remember for those).',
    parameters: {
      type: 'object',
      properties: {
        trigger: {
          type: 'string',
          description: 'Trigger pattern that should activate the lesson in the future',
        },
        lesson: {
          type: 'string',
          description: 'The lesson to remember and apply',
        },
      },
      required: ['trigger', 'lesson'],
      additionalProperties: false,
    },
  },
};

export const recallEpisodesTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'recall_episodes',
    description: 'Search past conversation sessions by topic or keyword. Returns session digests with dates, summaries, and unresolved threads. Use when you need to recall what happened in previous conversations.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — describe what you want to recall (e.g. "Israel Iran military flights", "project deadline discussion")',
        },
        days: {
          type: 'number',
          description: 'How many days back to search (default 30)',
        },
        top_k: {
          type: 'number',
          description: 'Maximum results to return (default 5)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const MEMORY_TOOLS: ToolDefinition[] = [rememberTool, recallTool, learnLessonTool, recallEpisodesTool];

// ── Executor ──

export async function executeMemoryTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'remember': {
      const category = args.category as string;
      const key = args.key as string;
      const value = args.value as string;
      if (!category || typeof category !== 'string') {
        return { tool_call_id: id, content: 'Error: "category" parameter is required and must be a string', is_error: true };
      }
      const validCategories = ['preference', 'fact', 'decision', 'lesson'];
      if (!validCategories.includes(category)) {
        return { tool_call_id: id, content: `Error: "category" must be one of: ${validCategories.join(', ')}`, is_error: true };
      }
      if (!key || typeof key !== 'string') {
        return { tool_call_id: id, content: 'Error: "key" parameter is required and must be a string', is_error: true };
      }
      if (!value || typeof value !== 'string') {
        return { tool_call_id: id, content: 'Error: "value" parameter is required and must be a string', is_error: true };
      }
      const rememberChatId = (args._chat_id as string) || 'global';
      const mutation = applyMemoryMutation({
        chatId: rememberChatId,
        tenantId: context?.tenantId ?? 'default',
        userId: context?.userId,
        turnId: context?.turnId,
        category: category as FactCategory,
        key,
        value,
        source: 'tool',
        requestedAction: 'AUTO',
      });
      return {
        tool_call_id: id,
        content: `${mutation.action}: ${mutation.fact.category}/${mutation.fact.key}: ${mutation.fact.value}`,
        is_error: false,
      };
    }

    case 'recall': {
      const recallCategory = args.category as string | undefined;
      const recallKey = args.key as string | undefined;
      const recallQuery = args.query as string | undefined;
      const recallTopK = args.top_k as number | undefined;
      const recallStrategyArg = args.strategy as string | undefined;
      if (recallCategory !== undefined && typeof recallCategory !== 'string') {
        return { tool_call_id: id, content: 'Error: "category" must be a string', is_error: true };
      }
      if (recallQuery !== undefined && typeof recallQuery !== 'string') {
        return { tool_call_id: id, content: 'Error: "query" must be a string', is_error: true };
      }
      if (recallTopK !== undefined && typeof recallTopK !== 'number') {
        return { tool_call_id: id, content: 'Error: "top_k" must be a number', is_error: true };
      }
      if (recallStrategyArg !== undefined && typeof recallStrategyArg !== 'string') {
        return { tool_call_id: id, content: 'Error: "strategy" must be a string', is_error: true };
      }
      if (recallTopK !== undefined && (!Number.isInteger(recallTopK) || recallTopK < 1 || recallTopK > 50)) {
        return { tool_call_id: id, content: 'Error: "top_k" must be an integer between 1 and 50', is_error: true };
      }
      if (recallCategory) {
        const validCats = ['preference', 'fact', 'decision', 'lesson'];
        if (!validCats.includes(recallCategory)) {
          return { tool_call_id: id, content: `Error: "category" must be one of: ${validCats.join(', ')}`, is_error: true };
        }
      }
      const config = getConfig();
      const recallStrategy = (recallStrategyArg ?? config.memory.recall_strategy) as 'keyword' | 'semantic' | 'hybrid';
      if (!['keyword', 'semantic', 'hybrid'].includes(recallStrategy)) {
        return { tool_call_id: id, content: 'Error: "strategy" must be one of: keyword, semantic, hybrid', is_error: true };
      }
      const recallChatId = (args._chat_id as string) || 'global';
      const tenantId = context?.tenantId ?? 'default';
      const merged = new Map<number, { fact: MemoryFact; score?: number }>();

      if (recallStrategy === 'keyword' || recallStrategy === 'hybrid') {
        const facts = getFacts(
          recallChatId,
          recallCategory as FactCategory | undefined,
          tenantId,
        );
        for (const fact of facts) {
          if (recallKey && fact.key !== recallKey) continue;
          merged.set(fact.id, { fact });
        }
      }

      if (recallStrategy === 'semantic' || recallStrategy === 'hybrid') {
        const semanticQuery = (recallQuery?.trim() || recallKey || '').trim();
        if (semanticQuery) {
          const semanticHits = await recallFacts(
            recallChatId,
            semanticQuery,
            tenantId,
            recallTopK,
          );
          for (const hit of semanticHits) {
            if (recallCategory && hit.fact.category !== recallCategory) continue;
            if (recallKey && hit.fact.key !== recallKey) continue;
            const existing = merged.get(hit.fact.id);
            if (!existing || (existing.score ?? 0) < hit.score) {
              merged.set(hit.fact.id, { fact: hit.fact, score: hit.score });
            }
          }
        }
      }

      const combined = [...merged.values()]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Date.parse(b.fact.updated_at) - Date.parse(a.fact.updated_at));

      if (combined.length === 0) {
        return { tool_call_id: id, content: '(no facts stored)', is_error: false };
      }
      const formatted = combined
        .slice(0, recallTopK ?? config.memory.semantic_top_k)
        .map((entry) => {
          const source = entry.fact.source ?? 'unknown';
          const updated = entry.fact.updated_at;
          const score = entry.score !== undefined ? `; score=${entry.score.toFixed(3)}` : '';
          return `[${entry.fact.category}] ${entry.fact.key}: ${entry.fact.value} (source=${source}; updated=${updated}${score})`;
        })
        .join('\n');
      return { tool_call_id: id, content: formatted, is_error: false };
    }

    case 'recall_episodes': {
      const query = args.query as string;
      if (!query || typeof query !== 'string') {
        return { tool_call_id: id, content: 'Error: "query" parameter is required and must be a string', is_error: true };
      }
      const days = typeof args.days === 'number' ? Math.max(1, Math.min(365, Math.floor(args.days))) : 30;
      const topK = typeof args.top_k === 'number' ? Math.max(1, Math.min(20, Math.floor(args.top_k))) : 5;
      const userId = (args._user_id as string) || (args._chat_id as string) || 'global';
      const tenantId = context?.tenantId ?? 'default';

      const results = searchDigests(userId, query, tenantId, topK);
      if (results.length === 0) {
        return { tool_call_id: id, content: '(no matching session episodes found)', is_error: false };
      }
      const formatted = results.map(d => {
        const date = d.created_at.slice(0, 10);
        const topics = d.topics.length > 0 ? ` | Topics: ${d.topics.join(', ')}` : '';
        const threads = d.open_threads.length > 0 ? ` | Open: ${d.open_threads.join('; ')}` : '';
        return `[${date}] (score=${d.score.toFixed(3)}) ${d.digest}${topics}${threads}`;
      }).join('\n');
      return { tool_call_id: id, content: formatted, is_error: false };
    }

    case 'learn_lesson': {
      const trigger = args.trigger as string;
      const lesson = args.lesson as string;
      if (!trigger || typeof trigger !== 'string') {
        return { tool_call_id: id, content: 'Error: "trigger" parameter is required and must be a string', is_error: true };
      }
      if (!lesson || typeof lesson !== 'string') {
        return { tool_call_id: id, content: 'Error: "lesson" parameter is required and must be a string', is_error: true };
      }
      saveLesson(trigger, lesson, 'tool', context?.tenantId);
      return { tool_call_id: id, content: `Lesson learned for trigger: ${trigger}`, is_error: false };
    }

    default:
      return null;
  }
}
