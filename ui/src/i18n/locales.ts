import type { Locale } from "./messages";

export const LOCALE_REGISTRY: readonly { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
];
