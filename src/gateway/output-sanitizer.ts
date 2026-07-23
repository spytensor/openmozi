/**
 * Output sanitization — strips internal reasoning and legacy protocol artifacts
 * from LLM output before sending to users.
 */
import { hasDsmlToolCallMarkup, stripDsmlToolCallMarkup } from '../core/legacy-tool-parsing.js';

/**
 * Strip <think>...</think> blocks from LLM output.
 * MOZI is an autonomous agent — internal reasoning is never exposed to users.
 */
export function stripThinkBlocks(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const openIdx = cleaned.indexOf('<think>');
  if (openIdx !== -1) {
    cleaned = cleaned.slice(0, openIdx);
  }
  return cleaned.trimStart();
}

export function hasLegacyToolCallProtocol(text: string): boolean {
  return (
    /\[TOOL_CALL\]|\[\/TOOL_CALL\]|<tool_call\b|<\/tool_call>|<minimax:tool_call>|<\/minimax:tool_call>|<invoke\s+name="/i.test(text)
    || hasDsmlToolCallMarkup(text)
  );
}

/**
 * Parse legacy XML tool calls emitted as raw text by some models (e.g. MiniMax).
 * Returns parsed tool calls or null if parsing fails.
 *
 * Supported formats:
 * - <minimax:tool_call><invoke name="..."><parameter name="...">...</parameter></invoke></minimax:tool_call>
 * - <tool_call>{"name":"...","arguments":{...}}</tool_call>
 */
export function parseLegacyToolCalls(text: string): Array<{ name: string; arguments: Record<string, string> }> | null {
  const minimaxPattern = /<minimax:tool_call>\s*<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>\s*<\/minimax:tool_call>/gi;
  const paramPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;

  const calls: Array<{ name: string; arguments: Record<string, string> }> = [];

  let match: RegExpExecArray | null;
  while ((match = minimaxPattern.exec(text)) !== null) {
    const toolName = match[1];
    const body = match[2];
    const args: Record<string, string> = {};

    let paramMatch: RegExpExecArray | null;
    paramPattern.lastIndex = 0;
    while ((paramMatch = paramPattern.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2];
    }

    calls.push({ name: toolName, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

export function stripLegacyToolCallBlocks(text: string): string {
  const withoutDsml = hasDsmlToolCallMarkup(text) ? stripDsmlToolCallMarkup(text) : text;
  return withoutDsml
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, ' ')
    .replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, ' ')
    .replace(/\[TOOL_CALL\][\s\S]*$/gi, ' ')
    .replace(/<tool_call[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<minimax:tool_call>[\s\S]*$/gi, ' ')
    .replace(/\[\/TOOL_CALL\]/gi, ' ')
    .replace(/<\/tool_call>/gi, ' ')
    .replace(/<\/minimax:tool_call>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeVisibleOutput(text: string): string {
  return stripLegacyToolCallBlocks(stripThinkBlocks(text));
}
