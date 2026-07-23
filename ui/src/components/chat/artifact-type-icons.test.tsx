import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/types";
import { TypeIcon, resolveArtifactType, type ArtifactType } from "./artifact-type-icons";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    plugin_id: "sandpack_v1",
    title: "Preview",
    status: "completed",
    data: {},
    timestamp: 1,
    ...overrides,
  };
}

function fileArtifact(data: Partial<Artifact["data"]>): Artifact {
  return artifact({
    plugin_id: "file_v1",
    title: String(data.filename ?? "generated.file"),
    data,
  });
}

function filledColors(svg: SVGSVGElement): Set<string> {
  return new Set(
    Array.from(svg.querySelectorAll("[fill]"))
      .map((node) => node.getAttribute("fill"))
      .filter((fill): fill is string => Boolean(fill && fill !== "none")),
  );
}

describe("TypeIcon", () => {
  it.each<ArtifactType>(["pdf", "document", "sheet", "deck", "image"])(
    "renders a filled colorful %s icon",
    (type) => {
      const { container } = render(<TypeIcon type={type} size={28} />);
      const wrapper = container.querySelector('[data-testid="artifact-type-icon"]');
      const svg = container.querySelector("svg");

      expect(wrapper).toHaveAttribute("data-type", type);
      expect(svg).toHaveAttribute("data-icon-type", type);
      expect(filledColors(svg as SVGSVGElement).size).toBeGreaterThan(2);
    },
  );

  it.each([
    [{ ext: "docx", kind: "document", filename: "brief.docx" }, "document"],
    [{ ext: "pdf", mime: "application/pdf", filename: "brief.pdf" }, "pdf"],
    [{ ext: "xlsx", kind: "sheet", filename: "model.xlsx" }, "sheet"],
    [{ ext: "pptx", kind: "presentation", filename: "deck.pptx" }, "deck"],
    [{ ext: "svg", kind: "image", filename: "diagram.svg" }, "image"],
    [{ ext: "tsx", filename: "App.tsx" }, "react"],
    [{ ext: "js", filename: "script.js" }, "js"],
    [{ ext: "json", filename: "data.json" }, "code"],
    [{ ext: "zip", kind: "archive", filename: "bundle.zip" }, "archive"],
    [{ ext: "unknown", filename: "download.unknown" }, "file"],
  ] as const)("maps file_v1 metadata %o to %s", (data, expected) => {
    expect(resolveArtifactType(fileArtifact(data))).toBe(expected);
  });

  it("maps non-file deck and JSON artifacts to colorful icon types", () => {
    expect(resolveArtifactType(artifact({ data: { content_type: "presentation" } }))).toBe("deck");
    expect(resolveArtifactType(artifact({ data: { content_type: "json" } }))).toBe("code");
  });

  it("identifies historical standalone HTML even when its stored metadata says document", () => {
    expect(resolveArtifactType(artifact({
      plugin_id: "document_v1",
      data: {
        content_type: "markdown",
        markdown: "<!DOCTYPE html><html><body>Dashboard</body></html>",
      },
    }))).toBe("html");
  });
});
