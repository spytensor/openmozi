import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatRelativeTimeForLocale } from "@/i18n/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(ts: string | number): string {
  return formatRelativeTimeForLocale(ts);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "$0.0000";
  return `$${usd.toFixed(4)}`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return "0h 0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

let idCounter = 0;
export function genId(): string {
  return `${Date.now()}-${++idCounter}`;
}
