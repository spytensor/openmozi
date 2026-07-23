import type { TaskBrief } from '../agents/protocol.js';

export type CliWorkerOutputMode = 'json' | 'jsonl' | 'text';
export type CliWorkerSystemPromptFormat = 'raw' | 'codex-config-instructions' | undefined;

export function buildManagedWorkerTaskPrompt(task: TaskBrief): string {
  const lines = [
    'You are a managed external worker running a single MOZI job.',
    'Work directly in the repository when changes are required.',
    `Task ID: ${task.task_id}`,
    `Objective:\n${task.objective}`,
    task.done_criteria ? `Done criteria:\n${task.done_criteria}` : '',
    task.constraints.allowed_tools.length > 0
      ? `Allowed tools: ${task.constraints.allowed_tools.join(', ')}`
      : '',
    task.constraints.forbidden_paths.length > 0
      ? `Forbidden paths: ${task.constraints.forbidden_paths.join(', ')}`
      : '',
    'Return a concise final summary of completed work, tests run, and blockers.',
  ];

  return lines.filter(Boolean).join('\n\n');
}

export function formatCliWorkerSystemPromptValue(
  systemPrompt: string,
  format: CliWorkerSystemPromptFormat,
): string {
  if (format === 'codex-config-instructions') {
    return `developer_instructions=${JSON.stringify(systemPrompt)}`;
  }
  return systemPrompt;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(collectText).filter(Boolean).join('\n').trim();
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['result', 'content', 'text', 'message', 'output', 'response']) {
      if (key in obj) {
        const extracted = collectText(obj[key]);
        if (extracted) return extracted;
      }
    }
  }
  return '';
}

function parseCliJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  try {
    return collectText(JSON.parse(trimmed) as Record<string, unknown>) || trimmed;
  } catch {
    return trimmed;
  }
}

function extractJsonlLineText(obj: Record<string, unknown>): string {
  const eventType = typeof obj.type === 'string' ? obj.type : '';

  if (eventType === 'error') {
    // Surface error messages (e.g. quota/limit errors) instead of silently dropping them
    const errorMsg = typeof obj.message === 'string' ? obj.message : '';
    if (errorMsg) return `[ERROR] ${errorMsg}`;
    return collectText(obj) || '';
  }

  if (eventType === 'item.completed' && obj.item && typeof obj.item === 'object') {
    const item = obj.item as Record<string, unknown>;
    const itemType = typeof item.type === 'string' ? item.type : '';
    if (itemType === 'error' || itemType === 'reasoning') return '';

    const directText = collectText(item.text ?? item.content ?? item.message ?? item.output ?? item.response);
    if (directText) return directText;
    return collectText(item);
  }

  if (eventType === 'response.output_text.delta' && typeof obj.delta === 'string') {
    return obj.delta;
  }
  if (eventType === 'response.output_text.done' && typeof obj.text === 'string') {
    return obj.text;
  }

  return collectText(obj);
}

function parseCliJsonl(raw: string): string {
  const lines = raw.split('\n').filter(line => line.trim());
  let aggregated = '';

  for (const line of lines) {
    try {
      aggregated += extractJsonlLineText(JSON.parse(line) as Record<string, unknown>);
    } catch {
      aggregated += line.trim();
    }
  }

  return aggregated.trim();
}

export function parseCliWorkerOutput(raw: string, mode: CliWorkerOutputMode): string {
  if (mode === 'jsonl') return parseCliJsonl(raw);
  if (mode === 'json') return parseCliJson(raw);
  return raw.trim();
}

export function sanitizeCliWorkerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const sanitized = { ...env } as Record<string, string | undefined>;
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_CLI_SESSION',
    'CODEX_SANDBOX_ACTIVE',
    'GEMINI_CLI_SESSION',
  ]) {
    delete sanitized[key];
  }

  return Object.fromEntries(
    Object.entries(sanitized).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
