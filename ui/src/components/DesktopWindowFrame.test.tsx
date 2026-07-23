import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import DesktopWindowFrame from "./DesktopWindowFrame";

afterEach(() => {
  delete window.moziDesktop;
  cleanup();
});

describe("DesktopWindowFrame", () => {
  it("leaves the Web surface unchanged", () => {
    render(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>);

    expect(screen.queryByTestId("desktop-window-frame")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-titlebar-drag-region")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("adds integrated macOS window chrome only when the desktop bridge exists", () => {
    window.moziDesktop = { selectDirectory: async () => ({ canceled: true }) };

    render(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>);

    expect(screen.getByTestId("desktop-window-frame")).toContainElement(screen.getByText("Workspace"));
    expect(screen.getByTestId("desktop-titlebar-drag-region")).toBeInTheDocument();
  });

  it("keeps fixed artifact chrome below the native macOS titlebar", () => {
    window.moziDesktop = { selectDirectory: async () => ({ canceled: true }) };

    render(
      <DesktopWindowFrame>
        <section className="artifact-panel" data-testid="artifact-panel" />
      </DesktopWindowFrame>,
    );

    expect(screen.getByTestId("desktop-window-frame").querySelector(".desktop-window-content"))
      .toContainElement(screen.getByTestId("artifact-panel"));

    // Global Tailwind CSS is loaded by main.tsx rather than jsdom. Assert the
    // desktop overlay contract at its source so this regression remains local.
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
    expect(css).toMatch(/--desktop-titlebar-height:\s*38px/);
    expect(css).toMatch(/\.desktop-window-frame \.artifact-panel\s*\{[^}]*top:\s*var\(--desktop-titlebar-height\)/s);
  });
});
