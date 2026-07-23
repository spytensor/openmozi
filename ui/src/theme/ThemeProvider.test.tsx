import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./ThemeProvider";

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_event: string, listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: () => void) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn((listener: () => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: () => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => media),
  });
  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      listeners.forEach((listener) => listener());
    },
  };
}

function ThemeProbe() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setPreference("system")}>System</button>
      <button onClick={() => setPreference("light")}>Light</button>
      <button onClick={() => setPreference("dark")}>Dark</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.classList.remove("dark");
  });

  it("resolves system theme from matchMedia and follows live changes", async () => {
    const system = installMatchMedia(true);

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("preference")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement).toHaveClass("dark");

    act(() => system.setMatches(false));

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("persists explicit choices and applies the resolved document theme", async () => {
    installMatchMedia(false);

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement).toHaveClass("dark");

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
