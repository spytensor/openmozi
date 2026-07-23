import { lazy, Suspense, type ComponentType } from "react";

type LobeIconComponent = ComponentType<{ size?: number }>;
type ProviderBadgeSize = "xs" | "sm" | "md";

const PROVIDER_BRAND: Record<string, { bg: string; fg: string }> = {
  openai: { bg: "#10a37f", fg: "#fff" },
  "openai-codex": { bg: "#0b8f78", fg: "#fff" },
  anthropic: { bg: "#d97757", fg: "#fff" },
  google: { bg: "#4285f4", fg: "#fff" },
  deepseek: { bg: "#4d6bfe", fg: "#fff" },
  moonshot: { bg: "#16162c", fg: "#fff" },
  minimax: { bg: "#ff5f5f", fg: "#fff" },
  groq: { bg: "#f55036", fg: "#fff" },
  together: { bg: "#0f6fff", fg: "#fff" },
  openrouter: { bg: "#6467f2", fg: "#fff" },
  xai: { bg: "#111114", fg: "#fff" },
  mistral: { bg: "#ff7000", fg: "#fff" },
  huggingface: { bg: "#ffb000", fg: "#111" },
  qianfan: { bg: "#2932e1", fg: "#fff" },
  zai: { bg: "#3b5bfd", fg: "#fff" },
};

const PROVIDER_LOGO: Record<string, LobeIconComponent> = {
  deepseek: lazy(() => import("@lobehub/icons/es/DeepSeek/components/Color")),
  openai: lazy(() => import("@lobehub/icons/es/OpenAI/components/Mono")),
  "codex-cli": lazy(() => import("@lobehub/icons/es/OpenAI/components/Mono")),
  anthropic: lazy(() => import("@lobehub/icons/es/Anthropic/components/Mono")),
  "claude-cli": lazy(() => import("@lobehub/icons/es/Claude/components/Color")),
  google: lazy(() => import("@lobehub/icons/es/Gemini/components/Color")),
  gemini: lazy(() => import("@lobehub/icons/es/Gemini/components/Color")),
  "gemini-cli": lazy(() => import("@lobehub/icons/es/Gemini/components/Color")),
  groq: lazy(() => import("@lobehub/icons/es/Groq/components/Mono")),
  minimax: lazy(() => import("@lobehub/icons/es/Minimax/components/Color")),
  moonshot: lazy(() => import("@lobehub/icons/es/Moonshot/components/Mono")),
  kimi: lazy(() => import("@lobehub/icons/es/Kimi/components/Color")),
  together: lazy(() => import("@lobehub/icons/es/Together/components/Color")),
  openrouter: lazy(() => import("@lobehub/icons/es/OpenRouter/components/Mono")),
  xai: lazy(() => import("@lobehub/icons/es/Grok/components/Mono")),
  mistral: lazy(() => import("@lobehub/icons/es/Mistral/components/Color")),
  huggingface: lazy(() => import("@lobehub/icons/es/HuggingFace/components/Color")),
  zai: lazy(() => import("@lobehub/icons/es/Zhipu/components/Color")),
  qwen: lazy(() => import("@lobehub/icons/es/Qwen/components/Color")),
  ollama: lazy(() => import("@lobehub/icons/es/Ollama/components/Mono")),
};

function providerInitials(id: string, name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts[0]) return parts[0].slice(0, 2).toUpperCase();
  return id.slice(0, 2).toUpperCase();
}

const SIZE_CLASS: Record<ProviderBadgeSize, string> = {
  xs: "h-6 w-6",
  sm: "h-8 w-8",
  md: "h-9 w-9",
};

const LOGO_SIZE: Record<ProviderBadgeSize, number> = { xs: 17, sm: 20, md: 22 };

export function ProviderBadge({ id, name, size = "sm" }: { id: string; name: string; size?: ProviderBadgeSize }) {
  const Logo = PROVIDER_LOGO[id];
  if (Logo) {
    return (
      <span
        data-provider-icon={id}
        className={`flex shrink-0 items-center justify-center rounded-md ${SIZE_CLASS[size]}`}
        style={{ background: "rgb(var(--ink-rgb) / 0.055)", color: "var(--text-primary)" }}
        aria-hidden
      >
        <Suspense fallback={<span className="text-[9px] font-bold">{providerInitials(id, name)}</span>}>
          <Logo size={LOGO_SIZE[size]} />
        </Suspense>
      </span>
    );
  }
  const brand = PROVIDER_BRAND[id] ?? { bg: "rgb(var(--ink-rgb) / 0.08)", fg: "var(--text-primary)" };
  return (
    <span
      data-provider-icon={id}
      className={`flex shrink-0 items-center justify-center rounded-md font-bold ${SIZE_CLASS[size]} ${size === "md" ? "text-[12px]" : "text-[10px]"}`}
      style={{ background: brand.bg, color: brand.fg }}
      aria-hidden
    >
      {providerInitials(id, name)}
    </span>
  );
}
