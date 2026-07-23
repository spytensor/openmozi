import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import type { Components, ExtraProps } from "react-markdown";
import MermaidBlock from "./MermaidBlock";
import { highlightCode, shikiLangForName } from "@/lib/shiki-highlight";
import { useTheme } from "@/theme/ThemeProvider";

const EXTERNAL_REL = "noopener noreferrer nofollow";
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL_RE = /^https?:\/\//i;
const DEFAULT_ANCHOR_RE = /^(mailto|tel):/i;
const BARE_DOMAIN_RE =
  /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

const LOCAL_FILE_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "gif",
  "heic",
  "html",
  "jpeg",
  "jpg",
  "json",
  "key",
  "md",
  "mov",
  "mp3",
  "mp4",
  "numbers",
  "pages",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "rtf",
  "svg",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "zip",
]);

type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & ExtraProps;
type MarkdownCodeBlockProps = {
  lang: string;
  code: string;
};

type MarkdownLinkResolution =
  | { kind: "external"; href: string }
  | { kind: "default"; href: string }
  | { kind: "plain" };

function isBareFilename(value: string): boolean {
  if (/[\\/]/.test(value)) return false;
  const pathname = value.split(/[?#]/, 1)[0] ?? value;
  const extension = pathname.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLowerCase();
  return Boolean(extension && LOCAL_FILE_EXTENSIONS.has(extension));
}

function looksLikeBareDomain(value: string): boolean {
  if (SCHEME_RE.test(value) || value.startsWith("/") || value.includes("@") || isBareFilename(value)) {
    return false;
  }
  return BARE_DOMAIN_RE.test(value);
}

export function resolveMarkdownLink(href: string | undefined): MarkdownLinkResolution {
  const value = href?.trim();
  if (!value) return { kind: "plain" };

  if (HTTP_URL_RE.test(value)) return { kind: "external", href: value };
  if (DEFAULT_ANCHOR_RE.test(value)) return { kind: "default", href: value };
  if (looksLikeBareDomain(value)) return { kind: "external", href: `https://${value}` };

  return { kind: "plain" };
}

export function MarkdownLink({ href, children, node: _node, ...props }: MarkdownAnchorProps) {
  const resolved = resolveMarkdownLink(href);

  if (resolved.kind === "plain") {
    return <>{children}</>;
  }

  if (resolved.kind === "default") {
    return (
      <a {...props} href={resolved.href}>
        {children}
      </a>
    );
  }

  return (
    <a {...props} href={resolved.href} target="_blank" rel={EXTERNAL_REL}>
      {children}
    </a>
  );
}

/** Fragment links are enabled only by the dedicated reading surface. */
export function MarkdownReadingLink({ href, children, node: _node, ...props }: MarkdownAnchorProps) {
  const fragment = href?.trim();
  if (!fragment || !/^#[^\s]+$/.test(fragment)) {
    return (
      <MarkdownLink {...props} href={href}>
        {children}
      </MarkdownLink>
    );
  }

  return (
    <a
      {...props}
      href={fragment}
      onClick={(event) => {
        // MOZI uses a hash router (`#/session/...`), so allowing the browser's
        // default hash navigation would leave the current conversation. Keep
        // fragment navigation inside the nearest Markdown reading surface.
        event.preventDefault();
        const rawId = fragment.slice(1);
        let id = rawId;
        try {
          id = decodeURIComponent(rawId);
        } catch {
          // A malformed percent sequence is still a valid literal DOM id.
        }
        const surface = event.currentTarget.closest("[data-markdown-reading-surface]");
        const target = Array.from(surface?.querySelectorAll<HTMLElement>("[id]") ?? []).find(
          (element) => element.id === id,
        );
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        target?.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}

function MarkdownCodeBlock({ lang, code }: MarkdownCodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    highlightCode(code, shikiLangForName(lang), resolvedTheme === "dark").then((highlightedHtml) => {
      if (cancelled) return;
      setHtml(highlightedHtml);
    });

    return () => {
      cancelled = true;
    };
  }, [code, lang, resolvedTheme]);

  if (!html) {
    return (
      <pre className="!bg-[var(--code-bg)] overflow-x-auto rounded-lg p-3.5 text-xs font-mono text-ink/80">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="shiki-block overflow-x-auto rounded-lg text-xs [&_pre]:!m-0 [&_pre]:p-3.5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className ?? "");
    const code = String(children);
    const isBlock = Boolean(match) || code.includes("\n");

    if (isBlock) {
      const lang = match?.[1] ?? "text";
      if (lang === "mermaid") {
        return <MermaidBlock code={code.replace(/\n$/, "")} />;
      }
      return <MarkdownCodeBlock lang={lang} code={code.replace(/\n$/, "")} />;
    }

    return (
      <code className="rounded bg-ink/[0.06] px-1 py-0.5 font-mono text-[0.85em] text-ink/80">
        {children}
      </code>
    );
  },
};
