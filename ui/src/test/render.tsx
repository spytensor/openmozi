import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { LocaleProvider, type Locale } from "@/i18n";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { resetModelStateForTests } from "@/hooks/useModelState";

export * from "@testing-library/react";

interface LocaleRenderOptions extends RenderOptions {
  locale?: Locale;
}

export function renderWithLocale(ui: ReactElement, options: LocaleRenderOptions = {}) {
  const { locale, ...renderOptions } = options;
  resetModelStateForTests();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider>
      <LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
    </ThemeProvider>
  );
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
