/**
 * Starting points, shown wherever someone is about to schedule something.
 *
 * Originally these only appeared when the list was empty, which made them a
 * first-run tutorial that vanished the moment you had one task — and "I want to
 * add another" is exactly when an example is most useful. They belong to the
 * *act of creating*, not to the empty state, so the composer shows them too
 * whenever its body is still blank.
 */
import { useLocale } from "@/i18n";
import type { ScheduleDraft } from "./draft";
import { SCHEDULE_TEMPLATES } from "./templates";

export function TemplateGrid({
  onPick,
  columns = 3,
}: {
  onPick: (draft: ScheduleDraft) => void;
  columns?: 2 | 3;
}) {
  const { t } = useLocale();
  return (
    <div className={columns === 2
      ? "grid gap-2 sm:grid-cols-2"
      : "grid gap-2 sm:grid-cols-2 lg:grid-cols-3"}>
      {SCHEDULE_TEMPLATES.map(template => {
        const Glyph = template.icon;
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onPick(template.draft())}
            className="flex min-w-0 items-start gap-2.5 rounded-lg border border-ink/[0.08] bg-elevated p-3 text-left transition-colors hover:bg-ink/[0.03]"
          >
            <Glyph className="mt-0.5 h-4 w-4 shrink-0 text-ink/45" strokeWidth={1.75} />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink/78">{t(template.titleKey)}</span>
              <span className="mt-0.5 block text-[11.5px] leading-4 text-ink/38">{t(template.blurbKey)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
