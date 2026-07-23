import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Artifact } from "@/types";
import { useLocale } from "@/i18n";
import ArtifactCard from "./ArtifactCard";

interface SupportingFilesGroupProps {
  artifacts: Artifact[];
  onOpen?: (artifact: Artifact) => void;
}

/**
 * Collapsed group for files a turn produced on the way to its deliverable —
 * generated charts, render frames, build scripts.
 *
 * A report task can emit a dozen of these, and publishing each as a sibling
 * card buries the one file the user actually asked for. They are still real
 * output, so they stay reachable behind a single disclosure rather than being
 * dropped: collapsed by default, one click from the full cards.
 *
 * The backend decides what is supporting (see `curateDeliverables`); this
 * component only renders that decision.
 */
export function SupportingFilesGroup({ artifacts, onOpen }: SupportingFilesGroupProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);

  if (artifacts.length === 0) return null;

  const label = expanded
    ? t("chat.supportingFiles.hide")
    : artifacts.length === 1
      ? t("chat.supportingFiles.showOne")
      : t("chat.supportingFiles.show", { count: artifacts.length });

  return (
    <div className="w-full max-w-[460px]">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] leading-4 text-ink/38 transition-colors hover:text-ink/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {artifacts.map((artifact, index) => (
            <ArtifactCard key={artifact.id ?? index} artifact={artifact} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export default SupportingFilesGroup;
