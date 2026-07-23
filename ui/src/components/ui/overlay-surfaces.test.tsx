import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Popover, PopoverContent } from "./popover";

afterEach(cleanup);

describe("overlay surface tokens", () => {
  it("keeps the approved dark palette separate from the unchanged light palette", () => {
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

    expect(css).toMatch(/:root\s*\{[^}]*--app-bg:\s*#181818;[^}]*--main-bg:\s*#181818;[^}]*--surface-base:\s*#181818;[^}]*--surface-elevated:\s*#202020;[^}]*--surface-overlay:\s*#262626;/s);
    expect(css).toMatch(/\[data-theme="light"\]\s*\{[^}]*--surface-elevated:\s*#ffffff;[^}]*--surface-overlay:\s*#ffffff;/s);
  });

  it("keeps action, activity, link, code, focus, and selection on independent tokens", () => {
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

    for (const token of ["action", "activity", "link", "code-inline-fg", "focus", "selection"]) {
      expect(css).toMatch(new RegExp(`--${token}:`));
    }
    expect(css).not.toContain("--accent: #3a8dff");
    expect(css).not.toContain("--accent: #5457d6");
  });

  it("uses the overlay token for popovers and both dialog primitives", () => {
    render(
      <>
        <Popover open><PopoverContent>Project menu</PopoverContent></Popover>
        <Dialog open><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>Preferences</DialogDescription></DialogContent></Dialog>
        <AlertDialog open><AlertDialogContent><AlertDialogTitle>Confirm</AlertDialogTitle><AlertDialogDescription>Confirmation required</AlertDialogDescription></AlertDialogContent></AlertDialog>
      </>,
    );

    for (const text of ["Project menu", "Settings", "Confirm"]) {
      expect(screen.getByText(text).closest('[role="dialog"]') ?? screen.getByText(text))
        .toHaveStyle({ background: "var(--surface-overlay)" });
    }
  });
});
