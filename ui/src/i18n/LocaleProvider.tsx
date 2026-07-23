import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocale,
  translateMessage,
  type Locale,
  type MessageKey,
} from "./messages";
import { formatRelativeTimeForLocale } from "./format";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  formatRelativeTime: (ts: string | number) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function detectBrowserLocale(): Locale {
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return DEFAULT_LOCALE;
}

function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectBrowserLocale();
}

export function LocaleProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? resolveInitialLocale());

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Locale should still update in-memory if persistent storage is unavailable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translateMessage(locale, key, values),
    formatRelativeTime: (ts) => formatRelativeTimeForLocale(ts, locale),
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }
  return context;
}
