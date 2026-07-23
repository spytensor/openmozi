function collectStrings(value: unknown, seen: Set<unknown>, output: string[], depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    if (value.message.trim()) output.push(value.message.trim());
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, seen, output, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'reason', 'responseBody', 'error', 'lastError', 'cause', 'errors', 'code', 'type']) {
    if (key in record) {
      collectStrings(record[key], seen, output, depth + 1);
    }
  }
}

export type ProviderErrorKind = 'authentication' | 'quota' | 'rate_limit' | 'transient' | 'request';

export class ProviderRuntimeError extends Error {
  readonly kind: ProviderErrorKind;
  readonly code?: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(input: {
    message: string;
    kind: ProviderErrorKind;
    code?: string;
    retryable: boolean;
    cause: unknown;
  }) {
    super(input.message);
    this.name = 'ProviderRuntimeError';
    this.kind = input.kind;
    this.code = input.code;
    this.retryable = input.retryable;
    this.cause = input.cause;
  }
}

function findStringField(value: unknown, key: string, seen = new Set<unknown>(), depth = 0): string | undefined {
  if (depth > 4 || value == null || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  for (const nestedKey of ['error', 'cause', 'lastError', 'data']) {
    const found = findStringField(record[nestedKey], key, seen, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function classifyProviderError(message: string, code?: string): { kind: ProviderErrorKind; retryable: boolean } {
  const text = `${code ?? ''} ${message}`.toLowerCase();
  if (/invalid.*api.?key|authentication|unauthorized|forbidden|\b401\b|\b403\b/.test(text)) {
    return { kind: 'authentication', retryable: false };
  }
  if (
    /insufficient.?quota|exceeded your current quota|quota.?exceeded|billing|insufficient.?(?:balance|funds)|credit|token plan|用量上限|\b2056\b/.test(text)
  ) {
    return { kind: 'quota', retryable: false };
  }
  if (/rate.?limit|too many requests|throttl|\b429\b/.test(text)) {
    return { kind: 'rate_limit', retryable: true };
  }
  if (/timeout|timed?.?out|\b5\d{2}\b|server.?error|service.?unavailable|bad.?gateway|overloaded|econnreset|econnrefused|enotfound|eai_again|fetch failed|network error|socket hang up/.test(text)) {
    return { kind: 'transient', retryable: true };
  }
  // Preserve the existing failover behavior for unknown failures. Only errors
  // positively identified as deterministic (auth/quota) suppress a retry.
  return { kind: 'request', retryable: true };
}

/**
 * Preserve structured provider/AI SDK failures as a stable Error contract.
 * In particular, never let `String({ error: ... })` destroy a useful provider
 * code/message into `[object Object]` at a stream or failover boundary.
 */
export function normalizeProviderError(error: unknown): ProviderRuntimeError {
  if (error instanceof ProviderRuntimeError) return error;
  const extracted = extractRecoveryErrorText(error);
  const message = extracted || (error instanceof Error ? error.message : 'Unknown provider error');
  const code = findStringField(error, 'code') ?? findStringField(error, 'type');
  const classification = classifyProviderError(message, code);
  return new ProviderRuntimeError({
    message,
    code,
    kind: classification.kind,
    retryable: classification.retryable,
    cause: error,
  });
}

/**
 * Extract the most useful user-facing error text from nested provider/runtime errors.
 */
export function extractRecoveryErrorText(error: unknown): string {
  const parts: string[] = [];
  collectStrings(error, new Set<unknown>(), parts);
  const unique = [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
  return unique.join('\n');
}

/**
 * Convert verified runtime/provider failure text into deterministic user-facing wording.
 */
export function buildDeterministicRecoveryMessage(rawError: string): string {
  const message = rawError.toLowerCase();
  if (
    message.includes('invalid api key')
    || message.includes('invalid x-api-key')
    || message.includes('authentication_error')
    || message.includes('authentication failed')
    || message.includes('unauthorized')
  ) {
    return 'Request failed because the current provider API key is invalid. Update the provider key in Settings, then retry.';
  }
  if (
    message.includes('insufficient balance')
    || message.includes('no resource package')
    || message.includes('exhausted your capacity')
    || message.includes('quota')
    || message.includes('token plan')
    || message.includes('2056')
    || message.includes('用量上限')
  ) {
    return 'Request failed because the current provider account hit a quota/balance limit. Please recharge or switch to another configured provider, then retry.';
  }
  if (/rate.?limit/.test(message) || message.includes('too many requests') || message.includes('throttl')) {
    return 'Request failed because the current provider is temporarily rate limited. Please wait briefly and retry.';
  }
  if (message.includes('session id') && message.includes('already in use')) {
    return 'Request failed due to a temporary provider session conflict. Please retry once.';
  }
  if (message.includes('aborted') || message.includes('timeout') || message.includes('timed out')) {
    return 'Request timed out or was cancelled before completion. Please retry the same instruction.';
  }
  if (message.includes('message is too long')) {
    return 'The reply exceeded Telegram message limits. MOZI now chunks long replies, so please resend the same instruction.';
  }
  if (message.includes('chat not found')) {
    return 'The target chat is no longer reachable on its original channel. Reconnect that client or retry from the same channel.';
  }
  // Surface the actual error to the user instead of hiding it behind a generic message.
  // Truncate to keep it readable but include enough for diagnosis.
  const summary = rawError
    .replace(/\s*\{\s*"type"[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const readableSummary = summary.length > 300 ? summary.slice(0, 300) + '…' : summary;
  return `Request failed: ${readableSummary}`;
}
