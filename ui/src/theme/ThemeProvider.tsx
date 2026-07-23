import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "mozi.ui.theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_QUERY = "(prefers-color-scheme: dark)";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(THEME_QUERY).matches ? "dark" : "light";
}

function resolveTheme(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme());
  const resolvedTheme = resolveTheme(preference, systemTheme);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(THEME_QUERY);
    const handleChange = () => setSystemTheme(media.matches ? "dark" : "light");
    handleChange();
    if (media.addEventListener) {
      media.addEventListener("change", handleChange);
    } else {
      media.addListener?.(handleChange);
    }
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener("change", handleChange);
      } else {
        media.removeListener?.(handleChange);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // Theme still updates in memory if storage is unavailable.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
