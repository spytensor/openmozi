import { useEffect, useState } from "react";
import { Activity, ChevronRight, Loader2 } from "lucide-react";
import type { TurnEnvelope } from "@/types";
import { formatDurationForLocale, useLocale } from "@/i18n";

interface RunSummaryProps {
  turn: TurnEnvelope;
  turnIds?: ReadonlySet<string>;
  turns?: TurnEnvelope[];
  onOpen: () => void;
}

interface LiveRunSummaryProps {
  startedAt: number;
  headline: string;
  completed: number;
  total: number;
  onOpen: () => void;
}

export function LiveRunSummary({ startedAt, headline, completed, total, onOpen }: LiveRunSummaryProps) {
  const { locale, t } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const progress = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;

  return (
    <button
      type="button"
      data-testid="live-run-summary"
      onClick={onOpen}
      aria-label={t("run.live.open")}
      className="work-capsule group relative mt-2 flex min-h-[72px] w-full max-w-[640px] items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus/45"
    >
      <Loader2 className="work-active-ink h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={2} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--work-active)]">
          <span>{t("run.live.running")}</span>
          {total > 0 && <span className="tabular-nums text-ink/38">{completed}/{total}</span>}
        </span>
        <span className="mt-1 block truncate text-[13px] text-ink/72">{headline}</span>
        <span className="mt-1 block text-[10.5px] tabular-nums text-ink/34">{formatDurationForLocale(Math.max(0, now - startedAt), locale)}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink/28 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-ink/[0.04]">
        <span
          className="block h-full origin-left bg-[color:var(--work-active)] transition-transform duration-300 motion-reduce:transition-none"
          style={{ transform: `scaleX(${progress})` }}
        />
      </span>
    </button>
  );
}

export default function RunSummary({ turn, turnIds, turns, onOpen }: RunSummaryProps) {
  const { locale, t } = useLocale();
  const claimedTurnIds = turnIds ?? new Set([turn.turnId]);
  const claimedTurns = (turns ?? [turn]).filter((candidate) => claimedTurnIds.has(candidate.turnId));
  const starts = claimedTurns.map((candidate) => candidate.startedAt);
  const ends = claimedTurns.map((candidate) => candidate.endedAt).filter((value): value is number => typeof value === "number");
  const duration = starts.length > 0 && ends.length > 0 ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0;
  const facts = [
    duration > 0 ? formatDurationForLocale(duration, locale) : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <button
      type="button"
      data-testid="run-summary"
      onClick={onOpen}
      aria-label={t("run.summary.open")}
      className="group mt-2 flex min-h-11 w-full max-w-[640px] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-ink/42 outline-none transition-[background-color,color] duration-150 hover:bg-ink/[0.035] hover:text-ink/62 focus-visible:ring-2 focus-visible:ring-focus/40 active:bg-ink/[0.055]"
    >
      <Activity className="h-3.5 w-3.5 shrink-0 text-ink/38" strokeWidth={1.9} aria-hidden="true" />
      <span className="shrink-0 font-medium text-ink/52">{t("run.summary.details")}</span>
      {facts.length > 0 && <span className="min-w-0 flex-1 truncate tabular-nums">{facts.join(" · ")}</span>}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink/24 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
    </button>
  );
}
