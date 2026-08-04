import { fireEvent, screen, renderWithLocale } from "@/test/render";
import { describe, expect, it } from "vitest";
import RunReasoning from "./RunReasoning";
import type { RunReasoningPass } from "./run-metrics";

const passes: RunReasoningPass[] = [
  {
    provider: "deepseek",
    summary: "First I gather the UN population data, then build the pyramid frames.",
    streaming: false,
    startedAt: 1_000,
    completedAt: 196_000,
    durationMs: 195_000,
  },
  {
    provider: "openai",
    hasPrivateReasoning: true,
    streaming: false,
    startedAt: 200_000,
    completedAt: 202_000,
    durationMs: 2_000,
  },
];

describe("RunReasoning", () => {
  it("collapses displayable passes by default and expands on click", () => {
    renderWithLocale(<RunReasoning passes={passes} />);

    // Pass with content: header visible, content hidden until clicked.
    expect(screen.queryByTestId("run-reasoning-content-0")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("run-reasoning-toggle-0"));
    expect(screen.getByTestId("run-reasoning-content-0")).toHaveTextContent("UN population data");
    fireEvent.click(screen.getByTestId("run-reasoning-toggle-0"));
    expect(screen.queryByTestId("run-reasoning-content-0")).not.toBeInTheDocument();
  });

  it("shows the private notice for passes without displayable reasoning", () => {
    renderWithLocale(<RunReasoning passes={passes} />);

    expect(screen.getByText("This provider's reasoning is not marked display-safe, so MOZI keeps it private.")).toBeInTheDocument();
    // The private pass toggle is inert — no expanded content ever appears.
    fireEvent.click(screen.getByTestId("run-reasoning-toggle-1"));
    expect(screen.queryByTestId("run-reasoning-content-1")).not.toBeInTheDocument();
  });
});
