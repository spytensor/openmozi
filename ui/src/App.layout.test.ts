import { describe, expect, it } from "vitest";
import { clampArtifactPanelWidth, isArtifactDocked } from "./App";

// Layout constants mirrored from App.tsx (not exported to keep the module
// surface small): sidebar 248, panel min 380, chat min 460.
const SIDEBAR = 248;
const CHAT_MIN = 460;
const PANEL_MIN = 380;

describe("artifact panel drag clamp (operator decision 2026-07-18)", () => {
  it("caps a drag so the chat column keeps its minimum — dragging never undocks", () => {
    const viewport = 1600;
    const clamped = clampArtifactPanelWidth(5000, false, viewport);
    expect(clamped).toBe(viewport - SIDEBAR - CHAT_MIN);
    // The clamped width still counts as docked: no mid-drag full-width takeover.
    expect(isArtifactDocked(clamped, false, viewport)).toBe(true);
  });

  it("keeps the collapsed-sidebar clamp docked too", () => {
    const viewport = 1280;
    const clamped = clampArtifactPanelWidth(5000, true, viewport);
    expect(clamped).toBe(viewport - CHAT_MIN);
    expect(isArtifactDocked(clamped, true, viewport)).toBe(true);
  });

  it("never clamps below the panel minimum", () => {
    expect(clampArtifactPanelWidth(100, false, 1600)).toBe(PANEL_MIN);
  });

  it("still takes over full-width on windows too narrow for both columns (responsive case)", () => {
    // main area 700 < panel-min 380 + chat-min 460: the lower bound wins and
    // the panel undocks — window sizing, not dragging, drives the takeover.
    const viewport = 700;
    const clamped = clampArtifactPanelWidth(5000, true, viewport);
    expect(clamped).toBe(PANEL_MIN);
    expect(isArtifactDocked(clamped, true, viewport)).toBe(false);
  });
});
