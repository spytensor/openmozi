import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "rgb(var(--mozi-app-bg) / <alpha-value>)",
        surface: "rgb(var(--mozi-surface-base) / <alpha-value>)",
        elevated: "rgb(var(--mozi-surface-elevated) / <alpha-value>)",
        inputSurface: "rgb(var(--mozi-surface-input) / <alpha-value>)",
        hover: "rgb(var(--mozi-surface-hover) / <alpha-value>)",
        active: "rgb(var(--mozi-surface-active) / <alpha-value>)",
        ink: "rgb(var(--ink-rgb) / <alpha-value>)",
        sheet: "rgb(var(--sheet-rgb) / <alpha-value>)",
        // shadcn uses "accent" for neutral menu/hover surfaces. Product color
        // roles stay separate so content, activity and actions cannot collapse
        // back onto one global hue.
        accent: {
          DEFAULT: "rgb(var(--mozi-surface-hover) / <alpha-value>)",
          foreground: "rgb(var(--ink-rgb) / 0.9)",
        },
        action: {
          DEFAULT: "rgb(var(--mozi-action) / <alpha-value>)",
          hover: "rgb(var(--mozi-action-hover) / <alpha-value>)",
          foreground: "var(--action-fg)",
        },
        activity: "rgb(var(--mozi-activity) / <alpha-value>)",
        link: {
          DEFAULT: "rgb(var(--mozi-link) / <alpha-value>)",
          hover: "rgb(var(--mozi-link-hover) / <alpha-value>)",
        },
        code: "rgb(var(--mozi-code) / <alpha-value>)",
        focus: "rgb(var(--mozi-focus) / <alpha-value>)",
        selection: {
          DEFAULT: "rgb(var(--mozi-selection) / <alpha-value>)",
          foreground: "#ffffff",
        },
        success: "rgb(var(--mozi-success) / <alpha-value>)",
        warning: "rgb(var(--mozi-warning) / <alpha-value>)",
        error: "rgb(var(--mozi-danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"SF Pro Text"', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        card: "8px",
        btn: "6px",
        badge: "4px",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
