import { Activity, ChevronRight } from "lucide-react";
import { ActivityOrb } from "@/components/ActivityOrb";
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

/**
 * Faithful thinking-orbs demo pill (operator, 2026-08-05): rounded-full soft
 * fill, orb + one shimmer line. The headline IS the label; the only extra is
 * the plan count the chat contract requires. Timer/progress live in Run
 * details, which the whole pill opens.
 */
export function LiveRunSummary({ headline, completed, total, onOpen }: LiveRunSummaryProps) {
  const { t } = useLocale();

  return (
    <button
      type="button"
      data-testid="live-run-summary"
      onClick={onOpen}
      aria-label={t("run.live.open")}
      className="work-live group mt-2 inline-flex max-w-[640px] items-center gap-4 rounded-full bg-ink/[0.04] py-3.5 pl-4 pr-6 text-left outline-none transition-colors duration-150 hover:bg-ink/[0.065] focus-visible:ring-2 focus-visible:ring-focus/45 active:bg-ink/[0.08]"
    >
      <ActivityOrb activity="working" size="capsule" className="shrink-0" />
      <span className="live-verb-shimmer min-w-0 truncate text-[14.5px] font-medium text-ink/62">
        {headline || t("run.live.running")}
      </span>
      {total > 0 && <span className="shrink-0 text-[11px] tabular-nums text-ink/38">{completed}/{total}</span>}
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
