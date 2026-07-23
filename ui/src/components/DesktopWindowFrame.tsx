import type { ReactNode } from "react";

export default function DesktopWindowFrame({ children }: { children: ReactNode }) {
  if (!window.moziDesktop) return children;

  return (
    <div data-testid="desktop-window-frame" className="desktop-window-frame">
      <div
        data-testid="desktop-titlebar-drag-region"
        aria-hidden="true"
        className="desktop-titlebar-drag-region"
      />
      <div className="desktop-window-content">{children}</div>
    </div>
  );
}
