import { ActivityOrb } from "@/components/ActivityOrb";
import { formatDurationForLocale, useLocale } from "@/i18n";

interface RunOverviewProps {
  running: boolean;
  duration: number;
  metrics: { reasoningPasses: number; toolCalls: number; outputs: number };
}

export default function RunOverview({ running, duration, metrics }: RunOverviewProps) {
  const { locale, t } = useLocale();
  return (
    <section className="p-5" data-testid="run-tab-overview">
      <div className={running
        ? "rounded-xl border border-[color:color-mix(in_srgb,var(--work-active)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--work-active)_6%,transparent)] p-4"
        : "rounded-xl border border-ink/[0.07] bg-ink/[0.018] p-4"}
      >
        {running && (
          <div className="flex items-center gap-2 text-[14px] font-medium text-[color:var(--work-active)]">
            <ActivityOrb activity="working" size="inline" />{t("run.live.running")}
          </div>
        )}
        <div className={`${running ? "mt-4 " : ""}grid grid-cols-2 gap-x-5 gap-y-3 text-[11px] text-ink/38 sm:grid-cols-4`}>
          <div><div className="text-[16px] tabular-nums text-ink/70">{formatDurationForLocale(duration, locale)}</div><div className="mt-1">{t("run.overview.duration")}</div></div>
          <div><div className="text-[16px] tabular-nums text-ink/70">{metrics.reasoningPasses}</div><div className="mt-1">{t("run.tab.reasoning")}</div></div>
          <div><div className="text-[16px] tabular-nums text-ink/70">{metrics.toolCalls}</div><div className="mt-1">{t("run.overview.toolCalls")}</div></div>
          <div><div className="text-[16px] tabular-nums text-ink/70">{metrics.outputs}</div><div className="mt-1">{t("run.tab.outputs")}</div></div>
        </div>
      </div>
    </section>
  );
}
