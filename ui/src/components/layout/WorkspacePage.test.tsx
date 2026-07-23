import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WorkspacePage from "./WorkspacePage";

describe("WorkspacePage", () => {
  it("owns vertical scrolling and prevents page-level horizontal overflow", () => {
    render(
      <WorkspacePage testId="workspace-page">
        <div>Content</div>
      </WorkspacePage>,
    );

    const page = screen.getByTestId("workspace-page");
    expect(page).toHaveClass("flex-1", "overflow-y-auto", "overflow-x-hidden", "p-4");
    expect(page.firstElementChild).toHaveClass("w-full", "min-w-0", "space-y-4");
  });
});
