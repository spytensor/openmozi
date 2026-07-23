import { screen, renderWithLocale } from "@/test/render";
import { describe, expect, it } from "vitest";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import ProjectContextBar from "./ProjectContextBar";

const root: RuntimeWorkspaceRoot = {
  id: "project",
  kind: "project_root",
  label: "Runtime Source",
  path: "/Users/test/Mozi",
  exists: true,
  git: { is_repo: true, branch: "main" },
};

describe("ProjectContextBar", () => {
  it("shows the selected project as the active chat context", () => {
    renderWithLocale(<ProjectContextBar root={root} />);

    expect(screen.getByTestId("project-window-drag-region")).toHaveClass("desktop-window-drag-region");
    expect(screen.getByText("Runtime Source")).toBeInTheDocument();
    // The raw filesystem path is noise on the visible line — it lives in the hover tooltip.
    expect(screen.queryByText("/Users/test/Mozi")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-context-bar")).toHaveAttribute("title", "/Users/test/Mozi");
    expect(screen.getAllByText("main")).toHaveLength(1);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});
