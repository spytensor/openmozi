import { lazy, Suspense, useState } from "react";
import { ArrowDownRight, CalendarClock, Coffee, Compass, ListTodo } from "lucide-react";
import MoziAvatar from "@/components/MoziAvatar";
import { useLocale, type MessageKey } from "@/i18n";

const TaskTemplatesSurface = lazy(() => import("@/components/task-templates/TaskTemplatesSurface"));

/**
 * Two-level starters, MOZI's own card language (operator decisions
 * 2026-07-19): level one keeps the original bordered starter CARDS — but the
 * cards are CATEGORIES now. Clicking a card reveals that category's concrete
 * example chips beneath the grid; hovering a chip previews the exact brief
 * the click fills (operator decision 2026-07-18 — every chip maps to a
 * complete self-contained showcase task exercising a capability that is
 * registered and was exercised on a real build; never advertise more).
 *
 * "My tasks" is a fourth card in the same language (operator decision
 * 2026-07-19): clicking it reveals the user's saved task templates as
 * quick-start chips — one click fills the composer with the template's
 * full instructions — plus a "new task" entry and a "manage" link into
 * the library dialog.
 */
interface StarterChip {
  chipKey: MessageKey;
  detailKey: MessageKey;
}

const STARTER_CATEGORIES: Array<{
  categoryKey: MessageKey;
  icon: typeof Coffee;
  iconClassName: string;
  chips: StarterChip[];
}> = [
  {
    categoryKey: "app.starters.cat.office",
    icon: Coffee,
    iconClassName: "text-sky-400",
    chips: [
      { chipKey: "app.starters.chip.minutes", detailKey: "app.starters.office.detail" },
      { chipKey: "app.starters.chip.prd", detailKey: "app.starters.documents.detail" },
      { chipKey: "app.starters.chip.deck", detailKey: "app.starters.slides.detail" },
    ],
  },
  {
    categoryKey: "app.starters.cat.research",
    icon: Compass,
    iconClassName: "text-violet-400",
    chips: [
      { chipKey: "app.starters.chip.pricing", detailKey: "app.starters.research.detail" },
      { chipKey: "app.starters.chip.retail", detailKey: "app.starters.data.detail" },
    ],
  },
  {
    categoryKey: "app.starters.cat.auto",
    icon: CalendarClock,
    iconClassName: "text-amber-400",
    chips: [
      { chipKey: "app.starters.chip.plan", detailKey: "app.starters.background.detail" },
      { chipKey: "app.starters.chip.watch", detailKey: "app.starters.schedule.detail" },
      { chipKey: "app.starters.chip.folder", detailKey: "app.starters.workspace.detail" },
    ],
  },
];

export function NewChatWelcome({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  const { t } = useLocale();
  const [activeCategory, setActiveCategory] = useState<number | "mine" | null>(null);
  const category = typeof activeCategory === "number" ? STARTER_CATEGORIES[activeCategory] : null;
  const cardClassName =
    "group flex h-[104px] min-w-0 flex-col justify-between rounded-2xl border px-4 py-3.5 text-left transition-[background-color,border-color,transform] hover:-translate-y-0.5 hover:bg-ink/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/35";
  const cardStyle = (active: boolean) => ({
    borderColor: active ? "var(--border-medium)" : "var(--border-subtle)",
    background: active ? "rgb(var(--ink-rgb) / 0.03)" : "transparent",
  });

  return (
    <div className="w-full text-center" data-testid="new-chat-welcome">
      <MoziAvatar size={44} className="mb-4 opacity-65" />
      <h1 className="text-[26px] font-medium tracking-[-0.02em] text-ink/88 sm:text-[28px]">
        {t("app.emptyHeadline")}
      </h1>
      <p className="mt-1.5 text-[12.5px] text-ink/42">{t("app.emptySubtitle")}</p>

      <div className="mx-auto mt-7 grid max-w-[640px] grid-cols-2 gap-3 text-left sm:grid-cols-4" data-testid="starter-category-grid">
        {STARTER_CATEGORIES.map(({ categoryKey, icon: Icon, iconClassName }, index) => {
          const active = index === activeCategory;
          return (
            <button
              key={categoryKey}
              type="button"
              aria-pressed={active}
              data-testid="starter-category-card"
              onClick={() => setActiveCategory(active ? null : index)}
              className={cardClassName}
              style={cardStyle(active)}
            >
              <Icon className={`h-[17px] w-[17px] ${iconClassName}`} aria-hidden="true" />
              <span className="text-[13px] font-medium leading-[1.45] text-ink/78">{t(categoryKey)}</span>
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={activeCategory === "mine"}
          data-testid="my-tasks-card"
          onClick={() => setActiveCategory(activeCategory === "mine" ? null : "mine")}
          className={cardClassName}
          style={cardStyle(activeCategory === "mine")}
        >
          <ListTodo className="h-[17px] w-[17px] text-emerald-400" aria-hidden="true" />
          <span className="text-[13px] font-medium leading-[1.45] text-ink/78">{t("app.taskTemplates.mine")}</span>
        </button>
      </div>

      {category && (
        <div
          className="mx-auto mt-4 flex max-w-[640px] flex-wrap items-start justify-center gap-2 duration-180ms motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
          data-testid="starter-chip-row"
        >
          {category.chips.map(({ chipKey, detailKey }) => {
            const detail = t(detailKey);
            return (
              <div key={chipKey} className="group relative">
                <button
                  type="button"
                  data-testid="starter-chip"
                  onClick={() => onSelectPrompt(detail)}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] text-ink/70 transition-colors hover:bg-ink/[0.03] hover:text-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/35"
                  style={{ borderColor: "var(--border-subtle)", background: "transparent" }}
                >
                  {t(chipKey)}
                  <ArrowDownRight className="h-3 w-3 text-ink/30 transition-colors group-hover:text-ink/55" aria-hidden="true" />
                </button>
                {/* Hover preview: the REAL prompt the chip fills — the chip
                    advertises nothing the click does not deliver verbatim. */}
                <div
                  data-testid="starter-chip-preview"
                  className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-20 hidden w-[340px] -translate-x-1/2 rounded-lg border p-3 text-left text-[11.5px] leading-[1.6] text-ink/65 shadow-lg group-hover:block group-focus-within:block"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}
                >
                  <p className="line-clamp-6 whitespace-pre-wrap">{detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeCategory === "mine" && (
        <Suspense fallback={<div className="mx-auto mt-4 h-9 w-44 animate-pulse rounded-lg bg-ink/[0.035]" />}>
          <TaskTemplatesSurface onSelectPrompt={onSelectPrompt} />
        </Suspense>
      )}
    </div>
  );
}

export default NewChatWelcome;
