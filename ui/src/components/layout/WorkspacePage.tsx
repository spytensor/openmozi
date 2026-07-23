import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WorkspacePageProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  testId?: string;
}

export default function WorkspacePage({
  children,
  className,
  contentClassName,
  testId,
}: WorkspacePageProps) {
  return (
    <section
      data-testid={testId}
      className={cn("min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4", className)}
      style={{ color: "var(--text-primary)" }}
    >
      <div className={cn("w-full min-w-0 space-y-4", contentClassName)}>{children}</div>
    </section>
  );
}
