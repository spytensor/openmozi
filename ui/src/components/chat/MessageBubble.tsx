import { memo, useState } from "react";
import { AlertCircle, Check, Copy, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { TypeIcon } from "./artifact-type-icons";
import { buildFileArtifact } from "@/lib/file-artifact";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, ChatMessage } from "@/types";
import MoziAvatar from "@/components/MoziAvatar";
import { useLocale } from "@/i18n";
import { MARKDOWN_COMPONENTS } from "./markdown-link";
import { normalizeMarkdownTables } from "./markdown-normalize";
import MarkdownReadingSurface from "./MarkdownReadingSurface";
import { CHAT_PROSE_CLASS, CHAT_PROSE_COMPACT_CLASS } from "./prose";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Re-run an existing prompt as a fresh turn without creating a new user bubble. */
  onRegenerate?: (content: string) => void;
  /**
   * The prompt to re-run when regenerating an assistant answer — the user
   * message that produced it. Ignored for user messages (they regenerate
   * themselves). Absent when there is no preceding prompt to re-run.
   */
  regenerateText?: string;
  showAvatar?: boolean;
  showAssistantActions?: boolean;
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
  regenerateText,
  showAvatar = true,
  showAssistantActions = true,
  onDelete,
  onOpenArtifact,
  onOpenModelSettings,
}: MessageBubbleProps) {
  const { t } = useLocale();
  const { role, streaming } = message;
  const content = role === "user" ? stripInjectedContext(message.content) : normalizeAssistantMarkdown(message.content);
  const chatError = role === "assistant" ? normalizeChatError(content) : null;
  const showStreamingPlaceholder = role === "assistant" && Boolean(streaming && message.requestId);

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
    return (
      <div data-testid="message-user" className="group flex flex-col items-end min-w-0">
        {content && (
        <div data-testid="message-user-bubble" className="bg-surface-card border border-white/[0.07] rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[75%] overflow-hidden shadow-sm" style={{ boxShadow: "inset 0 1px 0 0 rgba(255, 255, 255, 0.06), 0 2px 8px rgba(0,0,0,0.3)" }}>
          <p className="text-[13.5px] text-ink/[0.92] tracking-[-0.01em] whitespace-pre-wrap break-words leading-[1.55] overflow-wrap-anywhere">{content}</p>
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
                  className={`flex max-w-[75%] items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-all duration-200 ${canOpen ? "cursor-pointer hover:bg-hover hover:border-white/10 active:scale-[0.98]" : ""}`}
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
          {onRegenerate && (
            <MessageAction label={t("chat.regenerate")} onClick={() => onRegenerate(content)}>
              <RefreshCw size={13} />
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

  if (!content && !showStreamingPlaceholder) return null;

  // Assistant — MOZI avatar beside the content, aligned to the first text line
  return (
    <div
      data-testid="message-assistant"
      className="group flex w-full max-w-full items-start gap-3 py-1.5"
    >
      {showAvatar ? (
        <MoziAvatar className="mt-0.5" />
      ) : (
        <div aria-hidden="true" className="mt-0.5 h-[26px] w-[26px] shrink-0" />
      )}
      <div className="min-w-0 flex-1">
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
                  onClick={() => onRegenerate(regenerateText)}
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
      ) : streaming ? (
        <div className="flex items-center gap-1 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-activity typing-dot" />
          <span className="w-1.5 h-1.5 rounded-full bg-activity typing-dot" />
          <span className="w-1.5 h-1.5 rounded-full bg-activity typing-dot" />
        </div>
      ) : null}
      {content && !chatError && !streaming && showAssistantActions && (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyAction text={content} rich />
          {onRegenerate && regenerateText && (
            <MessageAction label={t("chat.regenerate")} onClick={() => onRegenerate(regenerateText)}>
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
