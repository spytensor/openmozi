import { formatDurationForLocale, useLocale } from "@/i18n";
import type { RunReasoningPass } from "./run-metrics";

export default function RunReasoning({ passes }: { passes: RunReasoningPass[] }) {
  const { locale, t } = useLocale();
  return (
    <section className="p-5" data-testid="run-tab-reasoning">
      {passes.length === 0 ? <p className="py-12 text-center text-[12.5px] text-ink/38">{t("run.reasoning.empty")}</p> : (
        <div className="divide-y divide-ink/[0.06]">
          {passes.map((reasoning, index) => (
            <article key={`${reasoning.startedAt}:${index}`} className="py-4 first:pt-0">
              <div className="flex items-center justify-between gap-3 text-[11px] text-ink/34">
                <span>{t("run.reasoning.pass", { count: String(index + 1) })}{reasoning.provider ? ` · ${reasoning.provider}` : ""}</span>
                {reasoning.durationMs ? <span className="tabular-nums">{formatDurationForLocale(reasoning.durationMs, locale)}</span> : null}
              </div>
              {reasoning.summary ? (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-ink/68">{reasoning.summary}</p>
              ) : (
                <p className="mt-2 text-[12.5px] leading-5 text-ink/38">{t("run.reasoning.privateUnavailable")}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
