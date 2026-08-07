import { memo, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Copy, Lightbulb, Pencil, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { ActivityOrb } from "@/components/ActivityOrb";
import { TypeIcon } from "./artifact-type-icons";
import { buildFileArtifact } from "@/lib/file-artifact";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, ChatMessage, ChatReasoning } from "@/types";
import MoziAvatar from "@/components/MoziAvatar";
import { useLocale } from "@/i18n";
import { MARKDOWN_COMPONENTS } from "./markdown-link";
import { normalizeMarkdownTables } from "./markdown-normalize";
import MarkdownReadingSurface from "./MarkdownReadingSurface";
import { CHAT_PROSE_CLASS, CHAT_PROSE_COMPACT_CLASS } from "./prose";
import { formatDurationForLocale } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { agentAvatarColor } from "@/lib/agent-colors";
import { agentIcon } from "@/lib/agent-icons";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Re-run an existing prompt as a fresh turn without creating a new user bubble. */
  onRegenerate?: (content: string, mentions?: string[]) => void;
  /**
   * Load a user prompt back into the composer for edit-then-resend (append model,
   * not in-place edit). Only rendered on user messages; carries mentions/attachments
   * so the restored draft matches the original.
   */
  onEditInComposer?: (content: string, mentions?: ChatMessage["mentions"], attachments?: ChatMessage["attachments"]) => void;
  /**
   * The prompt to re-run when regenerating an assistant answer — the user
   * message that produced it. Ignored for user messages (they regenerate
   * themselves). Absent when there is no preceding prompt to re-run.
   */
  regenerateText?: string;
  /** Structured Agent identities carried by the source user message. */
  regenerateMentions?: string[];
  showAvatar?: boolean;
  showAssistantActions?: boolean;
  /** Reasoning can be owned by the turn-level Thinking Card instead. */
  showReasoning?: boolean;
  onDelete?: (message: ChatMessage) => void;
  /** Open an attachment in the shared artifact panel (same renderers as agent artifacts). */
  onOpenArtifact?: (artifact: Artifact) => void;
  /** Open the model settings recovery path for deterministic provider failures. */
  onOpenModelSettings?: () => void;
}

export type ChatErrorKind = "authentication" | "quota" | "request";

export function normalizeChatError(content: string): { kind: ChatErrorKind; detail: string } | null {
  const text = content.trim();
  const lower = text.toLowerCase();
  if (!lower.startsWith("request failed") && !lower.startsWith("error:")) return null;
  if (lower.includes("invalid api key") || lower.includes("authentication_error") || lower.includes("provider api key is invalid")) {
    return { kind: "authentication", detail: "" };
  }
  if (lower.includes("quota") || lower.includes("rate_limit_error") || lower.includes("token plan") || lower.includes("用量上限") || lower.includes("2056")) {
    return { kind: "quota", detail: "" };
  }
  const detail = text
    .replace(/^request failed:\s*/i, "")
    .replace(/\s*\{\s*"type"[\s\S]*$/i, "")
    .trim();
  return { kind: "request", detail };
}

function MessageAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-ink/35 transition-colors hover:bg-ink/[0.06] hover:text-ink/70"
    >
      {children}
    </button>
  );
}

/**
 * Render markdown to a standalone HTML string for the clipboard's text/html
 * flavor. react-dom/server is imported dynamically so it stays out of the entry
 * chunk (it only loads when someone actually copies a rich message).
 */
async function markdownToHtml(text: string): Promise<string> {
  try {
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>);
  } catch {
    return "";
  }
}

/**
 * Copy `text` to the clipboard, resilient across contexts (the previous
 * `navigator.clipboard?.writeText` silently no-op'd whenever the async Clipboard
 * API was unavailable — the button looked dead). When `html` is provided it is
 * written as the text/html flavor alongside the plain text, so a rich paste
 * target (docs, email) renders the formatting while a plain target still gets
 * the raw markdown. Returns whether the copy succeeded.
 */
async function copyToClipboard(text: string, html: string): Promise<boolean> {
  try {
    if (html && navigator.clipboard && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy execCommand path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copy button with a transient checkmark so the click has visible feedback. */
function CopyAction({ text, rich = false }: { text: string; rich?: boolean }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void (async () => {
      const html = rich ? await markdownToHtml(text) : "";
      if (!(await copyToClipboard(text, html))) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    })();
  };
  return (
    <MessageAction label={copied ? t("chat.copied") : t("chat.copy")} onClick={copy}>
      {copied ? <Check size={13} className="text-success/80" /> : <Copy size={13} />}
    </MessageAction>
  );
}

/**
 * Legacy turns baked the Web-UI workspace scope into the persisted user message.
 * It is turn context, not user content — strip it so it never shows in the bubble.
 * (New turns inject it into the system prompt instead.)
 */
export function stripInjectedContext(text: string): string {
  return text
    .replace(/(^|\n)Workspace Context \(selected in Web UI\):(?:\n-[^\n]*)*\n?/g, "$1")
    .replace(/^\n+/, "")
    .trim();
}

/**
 * Mentions are structured message metadata. Older local rows also embedded
 * the same token in prose; remove only those redundant, metadata-confirmed
 * markers before rendering or regenerating them.
 */
export function stripStructuredMentionTokens(text: string, mentions: string[] | undefined): string {
  let result = text;
  for (const name of mentions ?? []) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`, "gi"), "$1");
  }
  return result.trim();
}

// User input is rendered independently from the assistant reading surface: it
// preserves the visible submitted Markdown, stays compact inside the bubble, and
// never activates HTML, remote images, syntax highlighters, or Mermaid.
const USER_MARKDOWN_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-md border border-ink/[0.10]">
      <table className="w-full border-collapse text-left text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-r border-ink/[0.10] bg-ink/[0.04] px-2 py-1 font-medium last:border-r-0">{children}</th>,
  td: ({ children }) => <td className="border-b border-r border-ink/[0.08] px-2 py-1 align-top last:border-r-0">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md bg-black/20 p-2 font-mono text-[12px] leading-[1.5]">{children}</pre>
  ),
  code: ({ className, children }) => {
    const block = Boolean(className) || String(children).includes("\n");
    return block
      ? <code className="font-mono text-[12px] text-ink/88">{children}</code>
      : <code className="rounded bg-black/20 px-1 py-0.5 font-mono text-[0.86em] text-ink/90">{children}</code>;
  },
  img: ({ alt }) => (
    <span data-testid="message-user-blocked-image" className="font-mono text-[0.9em] text-ink/55">
      {alt ? `[image: ${alt}]` : "[image]"}
    </span>
  ),
};

const USER_MARKDOWN_CLASS = cn(
  "min-w-0 break-words text-[13.5px] leading-[1.55] tracking-[-0.01em] text-ink/[0.92] overflow-wrap-anywhere",
  "[&_p]:my-1 first:[&_p]:mt-0 last:[&_p]:mb-0",
  "[&_h1]:my-1.5 [&_h1]:text-[15px] [&_h1]:font-semibold",
  "[&_h2]:my-1.5 [&_h2]:text-[14.5px] [&_h2]:font-semibold",
  "[&_h3]:my-1 [&_h3]:text-[14px] [&_h3]:font-semibold",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_li>p]:my-0",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-ink/15 [&_blockquote]:pl-2.5 [&_blockquote]:text-ink/68",
  "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-2",
  "[&_input]:mr-1.5 [&_input]:align-middle",
);

type MarkdownSegment = {
  text: string;
  fenced: boolean;
};

function getFenceMarker(line: string): string | null {
  return line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

/**
 * DeepSeek can emit prose with long blank-line runs. Collapse those for markdown
 * rendering without touching fenced code, where blank lines are meaningful.
 */
export function normalizeAssistantMarkdown(text: string): string {
  const source = text.replace(/\r\n?/g, "\n").trim();
  if (!source) return "";

  const segments: MarkdownSegment[] = [];
  let buffer = "";
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const lineWithBreak = match[0];
    if (!lineWithBreak) continue;
    const hasBreak = lineWithBreak.endsWith("\n");
    const line = hasBreak ? lineWithBreak.slice(0, -1) : lineWithBreak;
    const marker = getFenceMarker(line);

    if (!inFence && marker) {
      if (buffer) segments.push({ text: buffer, fenced: false });
      buffer = lineWithBreak;
      inFence = true;
      fenceChar = marker[0];
      fenceLength = marker.length;
      continue;
    }

    if (inFence) {
      const closesFence = Boolean(marker && marker[0] === fenceChar && marker.length >= fenceLength);
      if (closesFence && hasBreak) {
        buffer += line;
        segments.push({ text: buffer, fenced: true });
        buffer = "\n";
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
        continue;
      }

      buffer += lineWithBreak;
      if (closesFence) {
        segments.push({ text: buffer, fenced: true });
        buffer = "";
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }

    buffer += lineWithBreak;
  }

  if (buffer) segments.push({ text: buffer, fenced: inFence });

  return segments
    .map((segment) => (segment.fenced ? segment.text : segment.text.replace(/\n{3,}/g, "\n\n")))
    .join("")
    .trim();
}

export function hasRenderableAssistantContent(message: ChatMessage): boolean {
  return normalizeAssistantMarkdown(message.content).length > 0;
}

export function hasRenderableReasoning(message: ChatMessage): boolean {
  return Boolean(
    message.reasoning && (
      normalizeAssistantMarkdown(message.reasoning.summary ?? "").length > 0 ||
      message.reasoning.streaming
    ),
  );
}

function ReasoningDisclosure({ reasoning, showProvider = true }: { reasoning: ChatReasoning; showProvider?: boolean }) {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(reasoning.streaming);
  const wasStreaming = useRef(reasoning.streaming);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (reasoning.streaming && !wasStreaming.current) setOpen(true);
    if (!reasoning.streaming && wasStreaming.current) setOpen(false);
    wasStreaming.current = reasoning.streaming;
  }, [reasoning.streaming]);

  useEffect(() => {
    if (!reasoning.streaming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reasoning.streaming]);

  const summary = normalizeAssistantMarkdown(reasoning.summary ?? "");
  const durationMs = reasoning.durationMs ?? Math.max(0, (reasoning.completedAt ?? now) - reasoning.startedAt);
  const title = reasoning.streaming
    ? t("chat.reasoning.thinking")
    : t("chat.reasoning.thoughtFor", { duration: formatDurationForLocale(durationMs, locale) });

  return (
    <div data-testid="message-reasoning" className="w-full max-w-[640px] text-ink/58">
      <button
        type="button"
        data-testid="message-reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-2 py-1.5 text-left focus-visible:outline-none"
      >
        {reasoning.streaming ? (
          <ActivityOrb activity="thinking" size="micro" className="shrink-0" />
        ) : (
          <Lightbulb className="h-3.5 w-3.5 shrink-0 text-ink/38" strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink/58">{title}</span>
        {showProvider && <span className="shrink-0 text-[10.5px] text-ink/28">{reasoning.provider}</span>}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink/30 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="ml-[7px] border-l border-ink/[0.10] pb-2 pl-4 pt-1">
          {summary && (
            <section data-testid="message-reasoning-summary">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink/30">
                {t("chat.reasoning.summary")}
              </div>
              <div className={`${CHAT_PROSE_COMPACT_CLASS} text-ink/58`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                  {normalizeMarkdownTables(summary)}
                </ReactMarkdown>
              </div>
            </section>
          )}
          {!summary && reasoning.streaming && <p className="text-[12px] text-ink/38">{t("chat.reasoning.inProgress")}</p>}
        </div>
      )}
    </div>
  );
}

/** One per-turn container for every provider-authored reasoning segment. */
export function ReasoningGroup({ messages }: { messages: ChatMessage[] }) {
  const { locale, t } = useLocale();
  const segments = messages.flatMap((message) => message.reasoning
    ? [{ id: message.id, reasoning: message.reasoning }]
    : []);
  const streaming = segments.some(({ reasoning }) => reasoning.streaming);
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (streaming) setOpen(true);
    else if (wasStreaming.current) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  const durationMs = segments.reduce((total, { reasoning }) => {
    const duration = reasoning.durationMs
      ?? Math.max(0, (reasoning.completedAt ?? now) - reasoning.startedAt);
    return total + duration;
  }, 0);
  const title = streaming
    ? t("chat.reasoning.thinking")
    : t("chat.reasoning.thoughtFor", { duration: formatDurationForLocale(durationMs, locale) });
  const providers = [...new Set(segments.map(({ reasoning }) => reasoning.provider).filter(Boolean))].join(" · ");
  const summaries = segments
    .map(({ id, reasoning }) => ({ id, summary: normalizeAssistantMarkdown(reasoning.summary ?? "") }))
    .filter(({ summary }) => Boolean(summary));

  return (
    <div
      data-testid="reasoning-group"
      className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-ink/[0.08] bg-ink/[0.025]"
    >
      <button
        type="button"
        data-testid="reasoning-group-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-2.5 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/35"
      >
        {streaming ? (
          <ActivityOrb activity="thinking" size="inline" className="shrink-0" />
        ) : (
          <Lightbulb className="h-4 w-4 shrink-0 text-ink/42" strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/72">{title}</span>
        {providers && <span className="max-w-[32%] truncate text-[10.5px] text-ink/30">{providers}</span>}
        {segments.length > 1 && <span className="shrink-0 rounded-full bg-ink/[0.05] px-2 py-0.5 text-[10.5px] text-ink/42">
          {t("chat.reasoning.segments", { count: String(segments.length) })}
        </span>}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink/30 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div data-testid="reasoning-group-content" className="border-t border-ink/[0.07] px-4 py-2">
          {summaries.length > 0 ? summaries.map(({ id, summary }, index) => (
            <div key={id} className={cn(CHAT_PROSE_COMPACT_CLASS, "py-2 text-ink/58", index > 0 && "border-t border-ink/[0.06]")}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {normalizeMarkdownTables(summary)}
              </ReactMarkdown>
            </div>
          )) : <p className="py-2 text-[12px] text-ink/38">{t("chat.reasoning.inProgress")}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized so a streaming turn only re-parses the markdown of the bubble whose
 * content actually changed. useChat rebuilds the timeline array on every chunk but
 * keeps unchanged items by reference, so shallow prop compare skips their re-render.
 */
/** Muted markdown prose for interim narration rendered inside a collapsed turn fold. */
export function AssistantNarration({ message }: { message: ChatMessage }) {
  const content = normalizeAssistantMarkdown(message.content);
  if (!content.trim()) return null;
  return (
    <div data-testid="turn-fold-narration" className={`${CHAT_PROSE_COMPACT_CLASS} text-ink/60`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {normalizeMarkdownTables(content)}
      </ReactMarkdown>
    </div>
  );
}

export default memo(function MessageBubble({
  message,
  onRegenerate,
  onEditInComposer,
  regenerateText,
  regenerateMentions,
  showAvatar = true,
  showAssistantActions = true,
  showReasoning = true,
  onDelete,
  onOpenArtifact,
  onOpenModelSettings,
}: MessageBubbleProps) {
  const { t } = useLocale();
  const { role, streaming } = message;
  const rawContent = role === "user" ? stripInjectedContext(message.content) : normalizeAssistantMarkdown(message.content);
  const content = role === "user" ? stripStructuredMentionTokens(rawContent, message.mentions) : rawContent;
  const chatError = role === "assistant" ? normalizeChatError(content) : null;
  const showStreamingPlaceholder = role === "assistant" && Boolean(streaming && message.requestId);
  const renderReasoning = showReasoning && role === "assistant" && hasRenderableReasoning(message);

  if (role === "system") {
    if (!content) return null;
    return (
      <div data-testid="message-system" className="text-center py-2">
        <div className="inline-block bg-ink/[0.03] border border-ink/[0.05] rounded-full px-4 py-1">
          <span className="text-xs text-ink/35">{content}</span>
        </div>
      </div>
    );
  }

  if (role === "user") {
    const attachments = message.attachments ?? [];
    const mentions = [...new Set((message.mentions ?? []).map((name) => name.trim()).filter(Boolean))];
    return (
      <div data-testid="message-user" className="group flex flex-col items-end min-w-0">
        {(content || mentions.length > 0) && (
        <div data-testid="message-user-bubble" className="bg-surface-card border border-ink/[0.09] rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[75%] overflow-hidden shadow-sm">
          {mentions.length > 0 && (
            <div data-testid="message-user-mentions" className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {mentions.map((name) => {
                const Glyph = agentIcon(undefined, name);
                const hue = agentAvatarColor(undefined, name);
                return (
                  <span
                    key={name}
                    data-testid="agent-mention-token"
                    data-agent-name={name}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium"
                    style={{ color: hue, background: `color-mix(in srgb, ${hue} 14%, transparent)` }}
                  >
                    <Glyph className="h-3 w-3" strokeWidth={1.75} />
                    @{name}
                  </span>
                );
              })}
            </div>
          )}
          {content && (
            <div data-testid="message-user-markdown" className={USER_MARKDOWN_CLASS}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={USER_MARKDOWN_COMPONENTS}>
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
        )}
        {attachments.length > 0 && (
          // Attachment chips sit BELOW the user's text (docs/DESIGN.md). Same chip
          // recipe as the composer pending chip: token neutral surface, 1px
          // hairline, 6px radius, format-specific icon — identical before/after send.
          <div data-testid="message-user-attachments" className={`flex flex-col items-end gap-1 ${content ? "mt-1.5" : ""}`}>
            {attachments.map((att) => {
              const canOpen = Boolean(att.path && onOpenArtifact);
              return (
                <button
                  type="button"
                  key={att.path || att.filename}
                  disabled={!canOpen}
                  onClick={canOpen
                    ? () => onOpenArtifact!(buildFileArtifact({ path: att.path, filename: att.filename, mime: att.mimeType, size: att.size }))
                    : undefined}
                  title={canOpen ? t("chat.attachment.open", { name: att.filename }) : att.filename}
                  className={`flex max-w-[75%] items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-all duration-200 ${canOpen ? "cursor-pointer hover:bg-hover hover:border-ink/10 active:scale-[0.98]" : ""}`}
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--surface-input)",
                    color: "var(--text-secondary)",
                    boxShadow: "inset 0 1px 1px rgba(255, 255, 255, 0.02)",
                  }}
                >
                  <TypeIcon type={(att.filename || "").split(".").pop() || "file"} size={28} />
                  <span className="truncate text-[12px]">{att.filename}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyAction text={content} />
          {onEditInComposer && (
            <MessageAction
              label={t("chat.editInComposer")}
              onClick={() => onEditInComposer(content, message.mentions, message.attachments)}
            >
              <Pencil size={13} />
            </MessageAction>
          )}
          {onDelete && (
            <MessageAction label={t("chat.delete")} onClick={() => onDelete(message)}>
              <Trash2 size={13} />
            </MessageAction>
          )}
        </div>
      </div>
    );
  }

  if (!content && !showStreamingPlaceholder && !renderReasoning) return null;

  // Assistant — MOZI avatar beside the content, aligned to the first text line
  return (
    <div
      data-testid="message-assistant"
      className="group flex w-full max-w-full items-start gap-3 py-1.5"
    >
      {showAvatar ? (
        <MoziAvatar className="mt-0.5" />
      ) : (
        <div aria-hidden="true" className="mt-0.5 h-[34px] w-[34px] shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        {renderReasoning && message.reasoning && <ReasoningDisclosure reasoning={message.reasoning} />}
        <div className={renderReasoning && (content || chatError) ? "mt-3" : undefined}>
          {chatError ? (
            <div data-testid="message-error" className="max-w-full rounded-xl border border-danger/25 bg-danger/[0.05] p-3 text-[13px] text-ink/85 shadow-sm">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink/85">{t(`chat.error.${chatError.kind}.title`)}</p>
                  <p className="mt-0.5 leading-relaxed text-ink/58">
                    {chatError.detail || t(`chat.error.${chatError.kind}.description`)}
                  </p>
                  {chatError.kind === "request" && onRegenerate && regenerateText && (
                    <button
                      type="button"
                      onClick={() => regenerateMentions?.length
                        ? onRegenerate(regenerateText, regenerateMentions)
                        : onRegenerate(regenerateText)}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-link hover:text-link-hover"
                    >
                      <RefreshCw size={12} />
                      {t("common.retry")}
                    </button>
                  )}
                  {chatError.kind !== "request" && onOpenModelSettings && (
                    <button
                      type="button"
                      onClick={onOpenModelSettings}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-link hover:text-link-hover"
                    >
                      <Settings2 size={12} />
                      {t("chat.error.openModelSettings")}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(message)}
                      className="mt-2 block text-xs font-medium text-ink/50 hover:text-danger"
                    >
                      {t("chat.delete")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : content ? (
            showAssistantActions ? (
              <MarkdownReadingSurface
                markdown={content}
                testId="message-assistant-content"
                variant="answer"
              />
            ) : (
              <div data-testid="message-assistant-content" className={`${CHAT_PROSE_CLASS} text-ink/70`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                  {normalizeMarkdownTables(content)}
                </ReactMarkdown>
              </div>
            )
          ) : streaming && !renderReasoning ? (
            <div className="flex items-center gap-1 py-1">
              <ActivityOrb activity="responding" size="inline" />
            </div>
          ) : null}
        </div>
        {content && !chatError && !streaming && showAssistantActions && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyAction text={content} rich />
            {onRegenerate && regenerateText && (
              <MessageAction
                label={t("chat.regenerate")}
                onClick={() => regenerateMentions?.length
                  ? onRegenerate(regenerateText, regenerateMentions)
                  : onRegenerate(regenerateText)}
              >
                <RefreshCw size={13} />
              </MessageAction>
            )}
            {onDelete && (
              <MessageAction label={t("chat.delete")} onClick={() => onDelete(message)}>
                <Trash2 size={13} />
              </MessageAction>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
