import { Brain } from "lucide-react";
import { useLocale } from "@/i18n";
import type { MemoryUpdate } from "@/types";

function labelKey(update: MemoryUpdate) {
  if (update.count === update.added) return "memory.notice.added" as const;
  if (update.count === update.reinforced) return "memory.notice.reinforced" as const;
  if (update.count === update.updated) return "memory.notice.updated" as const;
  return "memory.notice.mixed" as const;
}

export function MemoryUpdateNotice({ update, onOpen }: { update: MemoryUpdate; onOpen?: () => void }) {
  const { t } = useLocale();
  const label = t(labelKey(update), { count: update.count });

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] text-ink/42 transition-colors hover:bg-ink/[0.04] hover:text-ink/62 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-ink/42"
      title={onOpen ? t("memory.notice.open") : label}
      aria-label={onOpen ? `${label}. ${t("memory.notice.open")}` : label}
    >
      <Brain className="h-3.5 w-3.5 text-activity/65" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
