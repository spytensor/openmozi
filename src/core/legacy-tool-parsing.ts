/**
 * Legacy Tool Call Parsing — recovers malformed tool calls from LLM text output.
 *
 * Handles formats from providers that don't natively support tool calling:
 * - <function=name>{json}</function> (Groq/DeepSeek style)
 * - [TOOL_CALL]...[/TOOL_CALL]
 * - <tool_call>...</tool_call>
 * - Markdown JSON code blocks with tool/name/function fields
 * - Arrow notation: {tool => "name", args => {...}}
 */

import type { ToolCall } from './llm.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function coerceScalarValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;
  return trimmed;
}

function unescapeQuoted(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\'/g, '\'')
    .replace(/\\\\/g, '\\');
}

function parseCliStyleArgs(raw: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const normalized = raw.replace(/[{}]/g, ' ').trim();
  const tokenRegex = /--([a-zA-Z0-9_-]+)(?:\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(normalized)) !== null) {
    const key = match[1].replace(/-/g, '_');
    const valueRaw = match[2] ?? match[3] ?? match[4];
    if (valueRaw === undefined) {
      args[key] = true;
      continue;
    }
    args[key] = coerceScalarValue(unescapeQuoted(valueRaw));
  }

  return args;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseArgumentsCandidate(value: unknown): Record<string, unknown> {
  const direct = asPlainObject(value);
  if (direct) return direct;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const obj = asPlainObject(parsed);
      if (obj) return obj;
    } catch {
      // fall through to CLI-style parsing
    }
    return parseCliStyleArgs(trimmed);
  }
  return {};
}

function parseLegacyToolCallBlock(block: string, index: number): ToolCall | null {
  const trimmed = block.trim();
  if (!trimmed) return null;

  // JSON-ish block first
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const row = asPlainObject(parsed);
    if (row) {
      const functionRow = asPlainObject(row.function);
      const toolName = (
        (typeof row.tool === 'string' && row.tool.trim())
        || (typeof row.name === 'string' && row.name.trim())
        || (typeof functionRow?.name === 'string' && functionRow.name.trim())
      );
      if (toolName) {
        const argsCandidate = row.args ?? row.arguments ?? row.input ?? functionRow?.arguments ?? functionRow?.input;
        return {
          id: `legacy_tool_call_${Date.now()}_${index}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(parseArgumentsCandidate(argsCandidate)),
          },
        };
      }
    }
  } catch {
    // non-JSON legacy format
  }

  // Legacy textual format:
  // {tool => "web_search", args => { --query "..." }}
  const toolMatch = trimmed.match(/(?:^|[,{]\s*)(?:tool|name)\s*=>\s*["']([^"']+)["']/i)
    ?? trimmed.match(/["'](?:tool|name)["']\s*:\s*["']([^"']+)["']/i);
  if (!toolMatch) return null;

  const toolName = toolMatch[1].trim();
  const argsArrow = trimmed.match(/(?:args|arguments|input)\s*=>\s*\{([\s\S]*?)\}\s*$/i)?.[1] ?? '';
  const argsJsonish = trimmed.match(/["'](?:args|arguments|input)["']\s*:\s*(\{[\s\S]*\})\s*$/i)?.[1] ?? '';

  let args: Record<string, unknown> = {};
  if (argsJsonish) {
    try {
      const parsed = JSON.parse(argsJsonish) as unknown;
      args = asPlainObject(parsed) ?? {};
    } catch {
      args = parseCliStyleArgs(argsJsonish);
    }
  } else if (argsArrow) {
    args = parseCliStyleArgs(argsArrow);
  }

  return {
    id: `legacy_tool_call_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * DSML / prefixed-XML tool-call markup, emitted as visible text by some models
 * that failed to route a tool call through the native channel:
 *
 *   <|DSML|invoke name="web_fetch">
 *     <|DSML|parameter name="url" string="true">https://…</|DSML|parameter>
 *     <|DSML|parameter name="max_chars" string="false">15000</|DSML|parameter>
 *   </|DSML|invoke>
 *
 * The `string="false"` attribute marks a non-string value, so it is coerced to
 * number/bool/null; otherwise the raw text is kept. The `<|PREFIX|…>` delimiter
 * is matched generically so sibling variants (not just DSML) are recovered too.
 */
// DeepSeek emits its special-token delimiters with FULLWIDTH vertical bars
// (｜ U+FF5C), not ASCII pipes — a live leak of `<｜DSML｜tool_calls>` sailed
// straight past ASCII-only patterns and rendered as garbage in the chat.
// Match both forms, with whitespace tolerance around the delimiters.
const P = '[|\\uFF5C]';
const DSML_INVOKE = new RegExp(
  `<\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*invoke\\s*>`,
  'gi',
);
const DSML_PARAMETER = new RegExp(
  `<\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?[^>]*>([\\s\\S]*?)<\\/\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*parameter\\s*>`,
  'gi',
);
const DSML_TAG_PREFIX = `<\\/?\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*`;

/** Strip every DSML/prefixed-XML tool-call fragment from visible text. */
export function stripDsmlToolCallMarkup(text: string): string {
  return text
    .replace(new RegExp(`${DSML_TAG_PREFIX}tool_calls\\s*>[\\s\\S]*?<\\/\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*tool_calls\\s*>`, 'gi'), ' ')
    .replace(new RegExp(`${DSML_TAG_PREFIX}tool_calls\\s*>[\\s\\S]*$`, 'gi'), ' ')
    .replace(new RegExp(`${DSML_TAG_PREFIX}invoke\\b[\\s\\S]*?<\\/\\s*${P}+\\s*[A-Z0-9_]+\\s*${P}+\\s*invoke\\s*>`, 'gi'), ' ')
    .replace(new RegExp(`${DSML_TAG_PREFIX}invoke\\b[\\s\\S]*$`, 'gi'), ' ')
    .replace(new RegExp(`${DSML_TAG_PREFIX}(?:tool_calls|invoke|parameter)\\b[^>]*>`, 'gi'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the text contains DSML/prefixed-XML tool-call markup. */
export function hasDsmlToolCallMarkup(text: string): boolean {
  return new RegExp(`${DSML_TAG_PREFIX}(?:tool_calls|invoke|parameter)\\b`, 'i').test(text);
}

function parseDsmlToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let invokeMatch: RegExpExecArray | null;
  DSML_INVOKE.lastIndex = 0;
  while ((invokeMatch = DSML_INVOKE.exec(content)) !== null) {
    const name = invokeMatch[1].trim();
    const body = invokeMatch[2];
    const args: Record<string, unknown> = {};
    let paramMatch: RegExpExecArray | null;
    DSML_PARAMETER.lastIndex = 0;
    while ((paramMatch = DSML_PARAMETER.exec(body)) !== null) {
      const key = paramMatch[1].trim();
      const isString = paramMatch[2] !== 'false';
      const raw = paramMatch[3];
      args[key] = isString ? raw.trim() : coerceScalarValue(raw);
    }
    calls.push({
      id: `legacy_tool_call_${Date.now()}_dsml_${calls.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return calls;
}

/**
 * Attempt to extract tool calls from raw LLM text output.
 * Returns null if no tool calls found.
 */
export function extractLegacyToolCallsFromText(content: string): { toolCalls: ToolCall[]; cleanedContent: string } | null {
  if (!content) return null;

  const toolCalls: ToolCall[] = [];
  let cleaned = content;

  // 0. DSML / prefixed-XML invoke markup
  if (hasDsmlToolCallMarkup(content)) {
    toolCalls.push(...parseDsmlToolCalls(content));
    cleaned = stripDsmlToolCallMarkup(cleaned);
  }

  // 1. <function=name>{json}</function> — Groq / DeepSeek style
  const functionTagRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = functionTagRegex.exec(content)) !== null) {
    const toolName = fnMatch[1];
    const bodyStr = fnMatch[2]?.trim() ?? '';
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(bodyStr) as unknown;
      args = asPlainObject(parsed) ?? {};
    } catch {
      args = parseCliStyleArgs(bodyStr);
    }
    toolCalls.push({
      id: `legacy_tool_call_${Date.now()}_fn_${toolCalls.length}`,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(args) },
    });
  }
  cleaned = cleaned.replace(/<function=\w+>[\s\S]*?<\/function>/g, ' ');

  // 2. Block-based formats: [TOOL_CALL], <tool_call>, markdown code blocks
  const blocks: string[] = [];
  const collectBlocks = (pattern: RegExp) => {
    cleaned = cleaned.replace(pattern, (_match: string, inner: string) => {
      blocks.push(typeof inner === 'string' ? inner : '');
      return ' ';
    });
  };

  collectBlocks(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/gi);
  collectBlocks(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi);
  collectBlocks(/```(?:json)?\s*\n(\{[\s\S]*?"(?:tool|name|function)"[\s\S]*?\})\s*\n```/g);

  for (let i = 0; i < blocks.length; i++) {
    const parsed = parseLegacyToolCallBlock(blocks[i], toolCalls.length + i);
    if (parsed) toolCalls.push(parsed);
  }

  if (toolCalls.length === 0) return null;

  const cleanedContent = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { toolCalls, cleanedContent };
}
