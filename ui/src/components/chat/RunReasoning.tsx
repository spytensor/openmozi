import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatDurationForLocale, useLocale } from "@/i18n";
import type { RunReasoningPass } from "./run-metrics";

function ReasoningPassRow({ reasoning, index }: { reasoning: RunReasoningPass; index: number }) {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const summary = reasoning.summary?.trim() ?? "";
  const expandable = summary.length > 0;
  return (
    <article className="py-3 first:pt-0">
      <button
        type="button"
        onClick={() => expandable && setOpen((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        data-testid={`run-reasoning-toggle-${index}`}
        className={`flex w-full items-center justify-between gap-3 text-left text-[11px] text-ink/34 ${expandable ? "cursor-pointer hover:text-ink/55" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1.5">
          {expandable && (
            <ChevronDown className={`h-3 w-3 shrink-0 text-ink/30 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          )}
          {t("run.reasoning.pass", { count: String(index + 1) })}{reasoning.provider ? ` · ${reasoning.provider}` : ""}
        </span>
        {reasoning.durationMs ? <span className="tabular-nums">{formatDurationForLocale(reasoning.durationMs, locale)}</span> : null}
      </button>
      {expandable ? (
        open && (
          <p className="mt-2 whitespace-pre-wrap pl-[18px] text-[13px] leading-6 text-ink/68" data-testid={`run-reasoning-content-${index}`}>{summary}</p>
        )
      ) : (
        <p className="mt-1.5 text-[12.5px] leading-5 text-ink/38">{t("run.reasoning.privateUnavailable")}</p>
      )}
    </article>
  );
}

export default function RunReasoning({ passes }: { passes: RunReasoningPass[] }) {
  const { t } = useLocale();
  return (
    <section className="p-5" data-testid="run-tab-reasoning">
      {passes.length === 0 ? <p className="py-12 text-center text-[12.5px] text-ink/38">{t("run.reasoning.empty")}</p> : (
        <div className="divide-y divide-ink/[0.06]">
          {passes.map((reasoning, index) => (
            <ReasoningPassRow key={`${reasoning.startedAt}:${index}`} reasoning={reasoning} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}
