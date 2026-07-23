import { DEFAULT_LOCALE, type Locale, translateMessage } from "./messages";

export function parseTimestampMs(ts: string): number {
  const trimmed = ts.trim();
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasTimeZone ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}

export function formatRelativeTimeForLocale(ts: string | number, locale: Locale = DEFAULT_LOCALE): string {
  const now = Date.now();
  const then = typeof ts === "string" ? parseTimestampMs(ts) : ts;
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 60) return translateMessage(locale, "time.justNow");
  if (diff < 3600) return translateMessage(locale, "time.minutesAgo", { count: Math.floor(diff / 60) });
  if (diff < 86400) return translateMessage(locale, "time.hoursAgo", { count: Math.floor(diff / 3600) });
  if (diff < 604800) return translateMessage(locale, "time.daysAgo", { count: Math.floor(diff / 86400) });
  return new Date(then).toLocaleDateString(locale);
}

export function formatDurationForLocale(ms: number, locale: Locale = DEFAULT_LOCALE): string {
  if (locale === "zh-CN") {
    if (ms < 1000) return `${ms} 毫秒`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
    return `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
  }
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** User-facing elapsed time: silent below one minute, approximate thereafter. */
export function formatApproximateDurationForLocale(ms: number, locale: Locale = DEFAULT_LOCALE): string | null {
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return translateMessage(locale, "execution.duration.approximate", { count: minutes });
}
