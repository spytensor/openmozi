import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS, MarkdownReadingLink } from "./markdown-link";
import { normalizeMarkdownTables } from "./markdown-normalize";
import { CHAT_ANSWER_PROSE_CLASS, DOCUMENT_PROSE_CLASS } from "./prose";

type MarkdownTreeNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownTreeNode[];
};

export type MarkdownReadingVariant = "answer" | "document";

interface MarkdownReadingSurfaceProps {
  className?: string;
  markdown: string;
  testId?: string;
  variant: MarkdownReadingVariant;
}

function nodeText(node: MarkdownTreeNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  return node.children?.map(nodeText).join("") ?? "";
}

/**
 * Stable, Unicode-safe heading ids for Markdown documents. Keeping CJK letters
 * makes generated Chinese tables of contents readable instead of reducing them
 * to opaque numeric ids. Duplicate headings follow GitHub's -1/-2 convention.
 */
export function markdownHeadingSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

/** Rehype plugin: give h1-h6 stable ids so authored Markdown TOCs work. */
export function rehypeMarkdownHeadingIds() {
  return (tree: MarkdownTreeNode) => {
    const seen = new Map<string, number>();

    const visit = (node: MarkdownTreeNode) => {
      if (/^h[1-6]$/.test(node.tagName ?? "")) {
        const base = markdownHeadingSlug(nodeText(node));
        const duplicateIndex = seen.get(base) ?? 0;
        seen.set(base, duplicateIndex + 1);
        node.properties = {
          ...node.properties,
          id: duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`,
          tabIndex: -1,
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function ReadingTable({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) {
  return (
    <div
      className="markdown-table-frame max-w-full overflow-x-auto rounded-lg shadow-[0_0_0_1px_rgba(var(--ink-rgb),0.10)]"
      data-markdown-table-frame
    >
      <table {...props}>{children}</table>
    </div>
  );
}

export const READING_MARKDOWN_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  a: MarkdownReadingLink,
  table: ReadingTable,
};

/**
 * One live renderer for final answers and Markdown documents. Outer consumers
 * own only canvas width/padding; typography, tables, headings and anchors stay
 * identical across generated artifacts and files opened from disk.
 */
const MarkdownReadingSurface = memo(function MarkdownReadingSurface({
  className,
  markdown,
  testId,
  variant,
}: MarkdownReadingSurfaceProps) {
  return (
    <div
      // Do not pass this typography contract through tailwind-merge. Its
      // arbitrary-variant conflict detection treats the six descendant heading
      // line-height utilities as mutually exclusive and silently drops them at
      // runtime (the 40px document h1 then inherits the 1.8 body line-height).
      // Outer canvas classes are additive here; they never need to rewrite the
      // renderer's element-level rules.
      className={[variant === "document" ? DOCUMENT_PROSE_CLASS : CHAT_ANSWER_PROSE_CLASS, className]
        .filter(Boolean)
        .join(" ")}
      data-markdown-reading-surface={variant}
      data-testid={testId}
    >
      <ReactMarkdown
        components={READING_MARKDOWN_COMPONENTS}
        rehypePlugins={[rehypeMarkdownHeadingIds]}
        remarkPlugins={[remarkGfm]}
      >
        {normalizeMarkdownTables(markdown)}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownReadingSurface;
