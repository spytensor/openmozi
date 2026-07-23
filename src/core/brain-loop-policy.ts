import { hasDsmlToolCallMarkup, stripDsmlToolCallMarkup } from './legacy-tool-parsing.js';

function stripThinkBlocks(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const openIdx = cleaned.indexOf('<think>');
  if (openIdx !== -1) {
    cleaned = cleaned.slice(0, openIdx);
  }
  return cleaned.trimStart();
}

export function hasLegacyToolCallProtocol(text: string): boolean {
  return (
    /\[TOOL_CALL\]|\[\/TOOL_CALL\]|<tool_call\b|<\/tool_call>|<minimax:tool_call>|<\/minimax:tool_call>|<invoke\s+name="/i.test(text) ||
    hasDsmlToolCallMarkup(text)
  );
}

function stripLegacyToolCallBlocks(text: string): string {
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

export function buildAbortError(abortSignal: AbortSignal, fallbackMessage: string): Error {
  const reason = abortSignal.reason;
  if (reason instanceof Error) {
    reason.name = 'AbortError';
    return reason;
  }
  const message = typeof reason === 'string' && reason.trim().length > 0
    ? reason
    : fallbackMessage;
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(abortSignal: AbortSignal | undefined, fallbackMessage: string): void {
  if (!abortSignal?.aborted) return;
  throw buildAbortError(abortSignal, fallbackMessage);
}

export function errorMessageForTerminalPatch(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  if (typeof err === 'string' && err.trim().length > 0) return err;
  return fallback;
}
