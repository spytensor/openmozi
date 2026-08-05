import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ActivityOrb } from "./ActivityOrb";
import { toolOrbActivity } from "./chat/execution";

describe("ActivityOrb", () => {
  it("renders a decorative canvas tagged with the driving activity", () => {
    const { container } = render(<ActivityOrb activity="thinking" />);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("data-orb-activity", "thinking");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });

  it("downscales non-preset footprints via CSS instead of retuning the design", () => {
    const { container } = render(<ActivityOrb activity="working" size="micro" />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.style.width).toBe("14px");
    expect(canvas.style.height).toBe("14px");
  });

  it("passes through data-testid so call sites keep their contract", () => {
    const { getByTestId } = render(<ActivityOrb activity="working" data-testid="orb-under-test" />);
    expect(getByTestId("orb-under-test").tagName).toBe("CANVAS");
  });
});

describe("toolOrbActivity", () => {
  it("maps running tool kinds to their orb activity", () => {
    expect(toolOrbActivity("web_search")).toBe("searching");
    expect(toolOrbActivity("browser_screenshot")).toBe("searching");
    expect(toolOrbActivity("write_file")).toBe("writing");
    expect(toolOrbActivity("shell_exec")).toBe("working");
    expect(toolOrbActivity(null)).toBe("working");
  });
});
