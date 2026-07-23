import type { BundledLanguage } from "shiki";

export const SHIKI_LANG_BY_EXT = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  json: "json",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  html: "html",
  css: "css",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  toml: "toml",
} as const satisfies Record<string, BundledLanguage>;

export const SHIKI_PRELOAD_LANGS = Array.from(new Set(Object.values(SHIKI_LANG_BY_EXT)));

const SHIKI_LANG_BY_NAME = {
  js: SHIKI_LANG_BY_EXT.js,
  javascript: SHIKI_LANG_BY_EXT.js,
  ts: SHIKI_LANG_BY_EXT.ts,
  typescript: SHIKI_LANG_BY_EXT.ts,
  py: SHIKI_LANG_BY_EXT.py,
  python: SHIKI_LANG_BY_EXT.py,
  json: SHIKI_LANG_BY_EXT.json,
  bash: SHIKI_LANG_BY_EXT.bash,
  sh: SHIKI_LANG_BY_EXT.sh,
  shell: SHIKI_LANG_BY_EXT.sh,
  yaml: SHIKI_LANG_BY_EXT.yaml,
  yml: SHIKI_LANG_BY_EXT.yml,
  xml: SHIKI_LANG_BY_EXT.xml,
  html: SHIKI_LANG_BY_EXT.html,
  css: SHIKI_LANG_BY_EXT.css,
  go: SHIKI_LANG_BY_EXT.go,
  rust: SHIKI_LANG_BY_EXT.rs,
  rs: SHIKI_LANG_BY_EXT.rs,
  java: SHIKI_LANG_BY_EXT.java,
  c: SHIKI_LANG_BY_EXT.c,
  h: SHIKI_LANG_BY_EXT.h,
  cpp: SHIKI_LANG_BY_EXT.cpp,
  "c++": SHIKI_LANG_BY_EXT.cpp,
  rb: SHIKI_LANG_BY_EXT.rb,
  ruby: SHIKI_LANG_BY_EXT.rb,
  php: SHIKI_LANG_BY_EXT.php,
  sql: SHIKI_LANG_BY_EXT.sql,
  toml: SHIKI_LANG_BY_EXT.toml,
  tsx: SHIKI_LANG_BY_EXT.tsx,
  jsx: SHIKI_LANG_BY_EXT.jsx,
  diff: "diff",
  dockerfile: "dockerfile",
  makefile: "make",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
} as const satisfies Record<string, BundledLanguage>;

export function shikiLangForExt(ext: string): BundledLanguage | "text" {
  return SHIKI_LANG_BY_EXT[ext.toLowerCase() as keyof typeof SHIKI_LANG_BY_EXT] ?? "text";
}

export function shikiLangForName(name: string): BundledLanguage | "text" {
  return SHIKI_LANG_BY_NAME[name.trim().toLowerCase() as keyof typeof SHIKI_LANG_BY_NAME] ?? "text";
}

export async function highlightCode(
  code: string,
  lang: BundledLanguage | "text",
  isDark: boolean,
): Promise<string | null> {
  try {
    const { codeToHtml } = await import("shiki");
    return await codeToHtml(code, {
      lang,
      theme: isDark ? "github-dark" : "github-light",
    });
  } catch {
    return null;
  }
}
