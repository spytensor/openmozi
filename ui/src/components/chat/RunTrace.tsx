import { Check, Circle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDurationForLocale, useLocale, type MessageKey } from "@/i18n";

export interface RunTraceRow {
  key: string;
  timestamp: number;
  title: string;
  detail?: string;
  state: "started" | "ended" | "completed" | "failed";
  durationMs?: number;
}

export default function RunTrace({ rows }: { rows: RunTraceRow[] }) {
  const { locale, t } = useLocale();
  return (
    <section className="p-5" data-testid="run-tab-trace">
      <div className="border-l border-ink/[0.09] pl-4">
        {rows.map((row) => {
          const Icon = row.state === "failed" ? XCircle
            : row.state === "completed" ? Check
              : Circle;
          const stateLabel: MessageKey = row.state === "started" ? "run.trace.started"
            : row.state === "ended" ? "run.trace.ended"
            : row.state === "completed" ? "run.trace.completed"
              : "run.trace.failed";
          return (
            <article key={row.key} className="relative pb-5 last:pb-0">
              <Icon size={13} className={cn("absolute -left-[22px] top-0.5 bg-elevated", row.state === "failed" ? "text-danger" : "text-ink/42")} />
              <div className="flex items-start justify-between gap-3"><h3 className="text-[12.5px] font-medium text-ink/70">{row.title}</h3><time className="shrink-0 text-[10.5px] tabular-nums text-ink/28">{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(row.timestamp)}</time></div>
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink/34"><span className={row.state === "failed" ? "text-danger" : undefined}>{t(stateLabel)}</span>{row.durationMs != null && <span>· {formatDurationForLocale(row.durationMs, locale)}</span>}</div>
              {row.detail && <p className="mt-1.5 break-words text-[11.5px] leading-5 text-ink/42">{row.detail}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
