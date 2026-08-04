import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The design doc drifted away from the stylesheet for long enough that it
 * described a palette the product had not used in months — while still
 * red-lining what the product actually shipped. Reviewers then hunt for
 * "violations" that are the house style, and real drift hides in the noise.
 *
 * These assertions are deliberately narrow: they pin the tokens the doc quotes
 * by value, so changing one without updating `docs/DESIGN.md` fails here.
 */
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
const doc = readFileSync(resolve(process.cwd(), "../docs/DESIGN.md"), "utf8");
const tailwind = readFileSync(resolve(process.cwd(), "tailwind.config.ts"), "utf8");

function darkToken(name: string): string {
  // The dark theme is the first :root block; the light theme overrides later.
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`token --${name} not found in index.css`);
  return match[1].trim();
}

function lightToken(name: string): string {
  const lightTheme = css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (!lightTheme) throw new Error("light theme block not found in index.css");
  const match = lightTheme.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`light token --${name} not found in index.css`);
  return match[1].trim();
}

describe("design tokens match the design doc", () => {
  it("pins the grounds and surface ladder the doc quotes", () => {
    const expected: Record<string, string> = {
      "app-bg": "#000000",
      "main-bg": "#000000",
      "sidebar-bg": "#0a0a0a",
      "surface-base": "#000000",
      "surface-elevated": "#111111",
      "surface-card": "#161616",
      "surface-overlay": "#1a1a1a",
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(darkToken(name), `--${name}`).toBe(value);
      expect(doc, `docs/DESIGN.md must quote --${name}`).toContain(value);
    }
  });

  it("defines the complete light surface ladder used by shared components", () => {
    const expected: Record<string, string> = {
      "surface-base": "#fafafa",
      "surface-elevated": "#ffffff",
      "surface-card": "#ffffff",
      "surface-overlay": "#ffffff",
      "surface-input": "#f4f4f5",
      "surface-hover": "#e4e4e7",
      "surface-active": "#d4d4d8",
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(lightToken(name), `light --${name}`).toBe(value);
    }
    expect(doc).toContain("`--surface-card #ffffff`");
  });

  it("registers the surface-card utility consumed by product components", () => {
    expect(tailwind).toContain('"surface-card": "var(--surface-card)"');
  });

  it("pins the radii the doc quotes", () => {
    expect(darkToken("radius-card")).toBe("12px");
    expect(darkToken("radius-button")).toBe("8px");
    expect(darkToken("radius-badge")).toBe("6px");
    expect(doc).toContain("`--radius-card 12px`");
  });

  it("keeps identity hues distinct from status hues", () => {
    const status = ["success", "warning", "danger"].map(darkToken);
    const identity = ["agent-ochre", "agent-jade", "agent-slate", "agent-bronze", "agent-violet"].map(darkToken);
    // An identity avatar that reuses a status colour reads as a warning/error.
    for (const hue of identity) {
      expect(status, `identity hue ${hue} must not be a status colour`).not.toContain(hue);
      expect(doc, `docs/DESIGN.md must quote identity hue ${hue}`).toContain(hue);
    }
  });

  it("keeps the interaction roles monochrome, as the doc now states", () => {
    for (const role of ["action", "activity", "focus"]) {
      expect(darkToken(role), `--${role}`).toBe("#ffffff");
    }
  });
});
