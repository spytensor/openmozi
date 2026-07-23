/**
 * Runtime time context helpers.
 *
 * Goal:
 * - Keep "current time" as authoritative system context every turn.
 * - Avoid noisy time banners in normal answers unless user explicitly asks.
 */

export interface RuntimeTimeAnchor {
  utcIso: string;
  localIso: string;
  timezone: string;
  utcOffset: string;
  epochMs: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatUtcOffset(date: Date): string {
  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function formatLocalIso(date: Date, utcOffset: string): string {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${utcOffset}`,
  ].join('T');
}

export function buildRuntimeTimeAnchor(now: Date = new Date()): RuntimeTimeAnchor {
  const utcOffset = formatUtcOffset(now);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  return {
    utcIso: now.toISOString(),
    localIso: formatLocalIso(now, utcOffset),
    timezone,
    utcOffset,
    epochMs: now.getTime(),
  };
}

function formatAnchorLines(anchor: RuntimeTimeAnchor): string[] {
  return [
    `utc_iso=${anchor.utcIso}`,
    `local_iso=${anchor.localIso}`,
    `timezone=${anchor.timezone}`,
    `utc_offset=${anchor.utcOffset}`,
    `epoch_ms=${anchor.epochMs}`,
  ];
}

export function buildRuntimeTimeSystemPrompt(now: Date = new Date()): string {
  const anchor = buildRuntimeTimeAnchor(now);
  return [
    '[RUNTIME TIME FACTS — authoritative]',
    ...formatAnchorLines(anchor),
    'Treat this as the only ground truth for "now".',
    'Do NOT prepend a time banner in normal replies.',
    'Only mention current time/date when user explicitly asks for it.',
  ].join('\n');
}

export function buildRuntimeTimeRefreshDirective(now: Date = new Date()): string {
  const anchor = buildRuntimeTimeAnchor(now);
  return [
    '[INTERNAL DIRECTIVE — not a user message] Refresh runtime time anchor (authoritative):',
    ...formatAnchorLines(anchor),
    'Use this for temporal reasoning. Do NOT print this block to the user unless asked.',
  ].join('\n');
}

const EN_TIME_PATTERNS: RegExp[] = [
  /\bwhat(?:'s| is)\s+the\s+time\b/i,
  /\bcurrent\s+time\b/i,
  /\bwhat(?:'s| is)\s+the\s+date\b/i,
  /\bcurrent\s+date\b/i,
  /\bwhat\s+day\s+is\s+it\b/i,
  /\btimezone\b/i,
  /\butc\b/i,
  /\bgmt\b/i,
  /\blocal\s+time\b/i,
];

const ZH_TIME_PATTERNS: RegExp[] = [
  /几点/,
  /现在.*时间/,
  /当前.*时间/,
  /现在.*几号/,
  /今天.*几号/,
  /日期/,
  /时区/,
  /utc/i,
  /gmt/i,
];

export function isExplicitTimeRequest(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  return EN_TIME_PATTERNS.some(pattern => pattern.test(text))
    || ZH_TIME_PATTERNS.some(pattern => pattern.test(text));
}

const TIME_PREAMBLE_LINE = /^\s*(?:\[(?:系统时间|当前时间|SYSTEM_TIME|System Time|Current Time)[^\]]*\]|(?:系统时间|当前时间|SYSTEM_TIME|System Time|Current Time)\s*[:：].*)\s*$/i;

export function stripUnrequestedTimePreamble(responseText: string, userMessage: string): string {
  if (!responseText || isExplicitTimeRequest(userMessage)) return responseText;

  const lines = responseText.split('\n');
  let idx = 0;
  while (idx < lines.length && lines[idx].trim().length === 0) idx++;

  if (idx >= lines.length || !TIME_PREAMBLE_LINE.test(lines[idx])) {
    return responseText;
  }

  idx++;
  while (idx < lines.length && lines[idx].trim().length === 0) idx++;
  const cleaned = lines.slice(idx).join('\n').trimStart();
  return cleaned.length > 0 ? cleaned : responseText;
}
