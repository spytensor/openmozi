import { FolderKanban, GitBranch } from "lucide-react";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import { runtimeRootLabel } from "@/lib/runtime-display";
import { useLocale } from "@/i18n";

interface ProjectContextBarProps {
  root: RuntimeWorkspaceRoot;
}

/**
 * A slim, quiet scope indicator shown above the conversation when a project is
 * active. Deliberately one low-contrast line — the composer already carries the
 * project selector, so this never becomes a banner that competes with the chat.
 * The raw filesystem path is meaningless noise for the operator, so it lives in
 * the hover tooltip rather than on the visible line.
 */
export default function ProjectContextBar({ root }: ProjectContextBarProps) {
  const { locale, t } = useLocale();
  const label = runtimeRootLabel(root, locale);

  return (
    <div data-testid="project-window-drag-region" className="desktop-window-drag-region shrink-0 px-5 pt-2">
      <div
        data-testid="project-context-bar"
        title={root.path}
        className="mx-auto flex w-full max-w-[920px] items-center gap-2 overflow-hidden text-[11.5px] text-ink/40"
      >
        <FolderKanban className="h-3.5 w-3.5 flex-shrink-0 text-selection/70" />
        <span className="min-w-0 truncate font-medium text-ink/60">{label}</span>
        {root.git?.branch && (
          <>
            <span className="text-ink/20">·</span>
            <span className="inline-flex max-w-[180px] flex-shrink items-center gap-1 truncate">
              <GitBranch className="h-3 w-3 flex-shrink-0 opacity-60" />
              <span className="truncate">{root.git.branch}</span>
            </span>
          </>
        )}
        <span className="text-ink/20">·</span>
        <span className={root.exists ? "flex-shrink-0 text-success/70" : "flex-shrink-0 text-warning/70"}>
          {root.exists ? t("project.context.connected") : t("project.context.missing")}
        </span>
      </div>
    </div>
  );
}
