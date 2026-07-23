import { useState, useRef, useEffect, useCallback, useMemo, forwardRef } from "react";
import type * as React from "react";
import type { ChangeEvent, ClipboardEvent, ComponentType, CSSProperties, KeyboardEvent } from "react";
import {
  ArrowUp,
  AtSign,
  ChevronDown,
  ChevronRight,
  Check,
  Circle,
  CornerLeftUp,
  Folder,
  FolderGit2,
  FolderKanban,
  FolderPlus,
  HelpCircle,
  House,
  Loader2,
  Plus,
  Search,
  Settings,
  Shield,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ModelChip } from "@/components/chat/ModelChip";
import { PermissionChip } from "@/components/chat/PermissionChip";
import { BranchPicker } from "@/components/chat/BranchPicker";
import { TypeIcon } from "@/components/chat/artifact-type-icons";
import type { ConnectionStatus, ContextCompressionState, UploadedAttachment } from "@/types";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import {
  runtimeFolderRoots,
  runtimeProjectRoots,
  runtimeRootHint,
  runtimeRootLabel,
} from "@/lib/runtime-display";
import { cn } from "@/lib/utils";
import { useLocale, type MessageKey } from "@/i18n";

interface InputBarProps {
  variant?: "empty" | "active";
  onSend: (content: string, attachments?: UploadedAttachment[]) => void;
  onCancel?: () => void;
  connectionStatus: ConnectionStatus;
  queueCount: number;
  isWorking?: boolean;
  roots?: RuntimeWorkspaceRoot[];
  selectedRoot?: RuntimeWorkspaceRoot | null;
  onSelectRoot?: (root: RuntimeWorkspaceRoot | null) => void;
  workspaceContextEnabled?: boolean;
  attachmentControlsEnabled?: boolean;
  mentionControlsEnabled?: boolean;
  sessionId?: string | null;
  pendingAttachment?: PendingComposerAttachment | null;
  onPendingAttachmentConsumed?: (id: number) => void;
  onRootsChanged?: () => void | Promise<void>;
  contextCompression?: ContextCompressionState | null;
  draftRequest?: ComposerDraftRequest | null;
  onDraftRequestConsumed?: (id: number) => void;
  canConfigureModels?: boolean;
  onOpenModelSettings?: () => void;
}

export interface PendingComposerAttachment {
  id: number;
  attachment: UploadedAttachment;
}

export interface ComposerDraftRequest {
  id: number;
  text: string;
}

interface CommandMeta {
  cmd: string;
  description: string;
  descriptionKey?: MessageKey;
  category: string;
  args: string | null;
}

const CATEGORY_META: Record<string, { labelKey: MessageKey; icon: typeof Search }> = {
  query: { labelKey: "composer.category.query", icon: Search },
  action: { labelKey: "composer.category.action", icon: Terminal },
  config: { labelKey: "composer.category.config", icon: Settings },
  admin: { labelKey: "composer.category.admin", icon: Shield },
};

const FALLBACK_COMMANDS: CommandMeta[] = [
  { cmd: "/help", description: "", descriptionKey: "composer.command.help", category: "query", args: null },
  { cmd: "/status", description: "", descriptionKey: "composer.command.status", category: "query", args: null },
  { cmd: "/tasks", description: "", descriptionKey: "composer.command.tasks", category: "query", args: null },
  { cmd: "/skills", description: "", descriptionKey: "composer.command.skills", category: "query", args: null },
  { cmd: "/cancel", description: "", descriptionKey: "composer.command.cancel", category: "action", args: "<task_id>" },
  { cmd: "/config", description: "", descriptionKey: "composer.command.config", category: "config", args: "[key] [value]" },
];
const COMMANDS_ENABLED = false;

const COMMAND_DESCRIPTION_KEYS: Record<string, MessageKey> = {
  ...Object.fromEntries(FALLBACK_COMMANDS.map((command) => [command.cmd, command.descriptionKey])),
  "/capabilities": "composer.command.capabilities",
  "/agents": "composer.command.agents",
  "/budget": "composer.command.budget",
  "/users": "composer.command.users",
  "/approve": "composer.command.approve",
  "/reject": "composer.command.reject",
  "/pair": "composer.command.pair",
  "/onboard": "composer.command.onboard",
  "/start": "composer.command.start",
} as Record<string, MessageKey>;

// Mirrors the server whitelist (application-routes.ts): documents, datasets,
// archives, web pages, source code, configs — everything the Brain can READ.
// Native executables stay out; the server enforces, this only guides the picker.
const FILE_UPLOAD_ACCEPT = [
  "image/*",
  "text/*",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/gzip",
  // Documents
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".rtf", ".odt", ".odp", ".ods", ".epub", ".md", ".txt",
  // Data
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xls", ".xlsx", ".parquet", ".feather", ".sqlite", ".db",
  // Archives
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  // Web & code
  ".html", ".htm", ".css", ".xml", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".py", ".ipynb",
  ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".lua", ".r", ".jl", ".sql", ".sh", ".bash", ".zsh", ".ps1", ".proto", ".graphql", ".vue", ".svelte",
  // Config & logs
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".log", ".lock",
].join(",");

interface FsListResponse {
  root?: string;
}

interface FsMkdirResponse {
  success?: boolean;
  path?: string;
  error?: string;
}

interface FsRootRecord {
  tier?: string;
  path?: string;
  label?: string;
}

interface FsRootsGrantResponse {
  success?: boolean;
  root?: FsRootRecord;
  error?: string;
}

interface JsonResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

async function readJsonResponse<T>(response: Response): Promise<JsonResponse<T>> {
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data: data as T };
}

function responseError(data: { error?: string }, status: number, fallback: string): Error {
  return new Error(typeof data.error === "string" && data.error ? data.error : `${fallback} (${status})`);
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const result = await readJsonResponse<T & { error?: string }>(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  if (!result.ok) throw responseError(result.data, result.status, fallback);
  return result.data;
}

function joinFsPath(dir: string, segment: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${segment.replace(/^[\\/]+/, "")}`;
}

function rootLabelFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Clipboard screenshots all arrive named "image.png"; give each paste a
 * distinct name so attachment chips (and the Brain's file references) stay
 * distinguishable across multiple pastes.
 */
function withDistinctPasteName(file: File, index: number): File {
  if (file.name && file.name !== "image.png") return file;
  const ext = (file.type.split("/")[1] || "png").split("+")[0];
  return new File([file], `pasted-${Date.now()}${index > 0 ? `-${index}` : ""}.${ext}`, { type: file.type });
}

function makeProjectRoot(path: string, label?: string): RuntimeWorkspaceRoot {
  return {
    id: `project_root:${path}`,
    kind: "project_root",
    label: label || rootLabelFromPath(path),
    path,
    exists: true,
    git: { is_repo: false },
  };
}

export default function InputBar({
  variant = "active",
  onSend,
  onCancel,
  connectionStatus,
  queueCount,
  isWorking = false,
  roots = [],
  selectedRoot = null,
  onSelectRoot,
  workspaceContextEnabled = true,
  attachmentControlsEnabled = true,
  mentionControlsEnabled = true,
  sessionId = null,
  pendingAttachment = null,
  onPendingAttachmentConsumed,
  onRootsChanged,
  contextCompression,
  draftRequest = null,
  onDraftRequestConsumed,
  canConfigureModels = false,
  onOpenModelSettings,
}: InputBarProps) {
  const { locale, t } = useLocale();
  const [text, setText] = useState("");
  /**
   * True between the user clicking stop and the runtime confirming the turn is
   * over (isWorking flipping false). Cancellation is asynchronous — the abort
   * has to reach the LLM stream — so the button must acknowledge the click
   * immediately instead of keeping the same visual and feeling dead.
   */
  const [cancelling, setCancelling] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [commands, setCommands] = useState<CommandMeta[]>(FALLBACK_COMMANDS);
  const [cmdSearch, setCmdSearch] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const appliedPendingAttachmentIdRef = useRef<number | null>(null);

  const disabled = connectionStatus === "disconnected";
  const isEmptyVariant = variant === "empty";
  const textMinHeight = isEmptyVariant ? 52 : 34;
  const textMaxHeight = isEmptyVariant ? 140 : 112;
  const showWorkspaceContext = workspaceContextEnabled && !!onSelectRoot;

  useEffect(() => {
    if (!COMMANDS_ENABLED) return;
    fetch("/api/commands")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.commands) && data.commands.length > 0) {
          setCommands(data.commands.map((command: CommandMeta) => ({
            ...command,
            descriptionKey: COMMAND_DESCRIPTION_KEYS[command.cmd],
          })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!COMMANDS_ENABLED) return;
    if (text === "/") {
      setShowCommands(true);
      setCmdSearch("");
    } else if (text.startsWith("/") && text.length > 1 && !text.includes(" ")) {
      setShowCommands(true);
      setCmdSearch(text);
    } else {
      setShowCommands(false);
    }
  }, [text]);

  useEffect(() => {
    if (!showCommands) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowCommands(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showCommands]);

  useEffect(() => {
    if (!draftRequest) return;
    setText(draftRequest.text);
    onDraftRequestConsumed?.(draftRequest.id);
    inputRef.current?.focus();
  }, [draftRequest, onDraftRequestConsumed]);

  useEffect(() => {
    if (!pendingAttachment || appliedPendingAttachmentIdRef.current === pendingAttachment.id) return;
    appliedPendingAttachmentIdRef.current = pendingAttachment.id;
    setAttachments((current) => {
      if (current.some((attachment) => attachment.path === pendingAttachment.attachment.path)) return current;
      return [...current, pendingAttachment.attachment];
    });
    setUploadError(null);
    onPendingAttachmentConsumed?.(pendingAttachment.id);
    inputRef.current?.focus();
  }, [onPendingAttachmentConsumed, pendingAttachment]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, textMinHeight), textMaxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > textMaxHeight ? "auto" : "hidden";
  }, [text, textMaxHeight, textMinHeight]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || isWorking || uploading) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText("");
    setAttachments([]);
    setUploadError(null);
    setShowCommands(false);
    inputRef.current?.focus();
  };

  const handleAttachClick = () => {
    if (disabled || uploading) return;
    fileInputRef.current?.click();
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const form = new FormData();
    for (const file of files) {
      form.append("files", file, file.name);
    }

    setUploading(true);
    setUploadError(null);
    try {
      const response = await fetch("/upload", {
        method: "POST",
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : `Upload failed (${response.status})`;
        throw new Error(message);
      }
      const returned = Array.isArray(data)
        ? data
        : Array.isArray(data.files)
          ? data.files
          : [];
      const uploaded = returned.length > 0
        ? returned.filter((file: Partial<UploadedAttachment>) => (
            typeof file.filename === "string"
            && typeof file.path === "string"
            && file.filename.length > 0
            && file.path.length > 0
          )) as UploadedAttachment[]
        : [];
      if (uploaded.length === 0) throw new Error("Upload returned no files");
      setAttachments((current) => [...current, ...uploaded]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      inputRef.current?.focus();
    }
  };

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadFiles(files);
  };

  // Latest-value refs for the window drop listeners: the effect binds once per
  // mount, so it must not close over stale disabled/uploading/uploadFiles.
  const uploadFilesRef = useRef(uploadFiles);
  uploadFilesRef.current = uploadFiles;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;

  // Window-level drag-and-drop (operator decision 2026-07-18: dropping a file
  // anywhere on the chat window attaches it — the composer is the only surface
  // that owns attachments, so it owns the window listeners while mounted).
  // Surfaces with their own drop zones (FilesView) call preventDefault in
  // their handlers first; the defaultPrevented check keeps this from
  // double-handling their drops.
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  useEffect(() => {
    if (!attachmentControlsEnabled) return;
    const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Required — without preventDefault the browser refuses the drop.
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      dragDepthRef.current = 0;
      setDragActive(false);
      if (event.defaultPrevented) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      if (disabledRef.current || uploadingRef.current) return;
      void uploadFilesRef.current(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [attachmentControlsEnabled]);

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || uploading) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0 && attachmentControlsEnabled) {
      // Files on the clipboard (screenshots, copied files) go through the same
      // upload path as the picker; suppress the default so a copied file's
      // textual fallback (e.g. its path) doesn't also land in the textarea.
      e.preventDefault();
      void uploadFiles(files.map(withDistinctPasteName));
      return;
    }
    // Text pasted from other apps often carries a block of trailing blank lines.
    // Strip trailing whitespace/newlines (and collapse 3+ blank lines) before it
    // lands in the composer, so the box isn't blown open by empty space.
    const pasted = e.clipboardData?.getData?.("text") ?? "";
    const cleaned = pasted.replace(/\n{3,}/g, "\n\n").replace(/[\s\uFEFF\xA0]+$/, "");
    if (!pasted || cleaned === pasted) return;
    e.preventDefault();
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + cleaned + text.slice(end);
    setText(next);
    const caret = start + cleaned.length;
    requestAnimationFrame(() => el?.setSelectionRange(caret, caret));
  };

  const removeAttachment = (path: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path));
  };

  const handleCancel = () => {
    if (disabled || !isWorking || cancelling) return;
    setCancelling(true);
    onCancel?.();
    inputRef.current?.focus();
  };

  // Runtime confirmed the turn ended (cancelled or finished) — reset the button.
  useEffect(() => {
    if (!isWorking) setCancelling(false);
  }, [isWorking]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isWorking) handleSend();
    }
    if (e.key === "Escape" && showCommands) {
      setShowCommands(false);
    }
  };

  const selectCommand = useCallback(
    (cmd: string, args: string | null) => {
      if (args) {
        setText(cmd + " ");
        setShowCommands(false);
        inputRef.current?.focus();
      } else {
        onSend(cmd);
        setText("");
        setShowCommands(false);
        inputRef.current?.focus();
      }
    },
    [onSend],
  );

  const grouped = commands.reduce<Record<string, CommandMeta[]>>((acc, cmd) => {
    const cat = cmd.category || "other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(cmd);
    return acc;
  }, {});

  return (
    <div data-testid="composer" data-composer-variant={variant} className="relative w-full">
      {COMMANDS_ENABLED && showCommands && (
        <div
          ref={panelRef}
          className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-50 overflow-hidden rounded-lg backdrop-blur-xl"
          style={{
            background: "color-mix(in srgb, var(--surface-elevated) 92%, transparent)",
            border: "1px solid var(--border-medium)",
            boxShadow: "0 20px 60px -20px rgba(0,0,0,0.55)",
          }}
        >
          <Command className="bg-transparent" shouldFilter={true}>
            <CommandInput
              placeholder={t("composer.searchCommands")}
              value={cmdSearch.startsWith("/") ? cmdSearch.slice(1) : cmdSearch}
              onValueChange={(v) => {
                setCmdSearch("/" + v);
                setText("/" + v);
              }}
              className="h-10 border-ink/[0.06] text-sm"
              style={{ color: "var(--text-primary)" }}
            />
            <CommandList className="max-h-[280px] overflow-y-auto">
              <CommandEmpty className="py-4 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("composer.noCommandsFound")}
              </CommandEmpty>
              {Object.entries(grouped).map(([category, cmds]) => {
                const meta = CATEGORY_META[category];
                const label = meta ? t(meta.labelKey) : category;
                const Icon = meta?.icon ?? HelpCircle;
                return (
                  <CommandGroup
                    key={category}
                    heading={
                      <span
                        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <Icon size={10} />
                        {label}
                      </span>
                    }
                  >
                    {cmds.map((c) => (
                      <CommandItem
                        key={c.cmd}
                        value={c.cmd}
                        onSelect={() => selectCommand(c.cmd, c.args)}
                        className="mx-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 data-[selected=true]:bg-selection/15 data-[selected=true]:text-ink"
                      >
                        <span className="shrink-0 font-mono text-sm font-medium text-code">{c.cmd}</span>
                        <span className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
                          {c.descriptionKey ? t(c.descriptionKey) : c.description}
                        </span>
                        {c.args && (
                          <span className="ml-auto shrink-0 font-mono text-[10px]" style={{ color: "var(--text-disabled)" }}>
                            {c.args}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </div>
      )}

      <div
        data-drag-active={dragActive || undefined}
        className="rounded-[20px] transition-colors"
        style={{
          background: "var(--surface-elevated)",
          // Dropping a file anywhere on the window attaches it here — the
          // accent border is the "this is where it lands" signal.
          border: dragActive ? "1px solid var(--focus)" : "1px solid var(--border-medium)",
          boxShadow: isEmptyVariant ? "var(--composer-shadow-empty)" : "var(--composer-shadow-active)",
        }}
      >
        <div className={cn("relative", isEmptyVariant ? "px-4 pb-3 pt-3" : "px-3.5 pb-2.5 pt-2.5")}>
          {contextCompression && contextCompression.stage !== "completed" && (
            <div data-testid="context-compression-status" className={cn("mb-2 flex items-center gap-2 px-1 text-[11px]", contextCompression.stage === "failed" ? "text-red-500" : "text-ink/50")}>
              {contextCompression.stage !== "failed" && <span className="h-2 w-2 animate-pulse rounded-full bg-activity" />}
              <span>{t(`composer.contextCompression.${contextCompression.stage}` as MessageKey)}</span>
              {contextCompression.contextWindow > 0 && (
                <span className="ml-auto tabular-nums text-ink/35">
                  {t("composer.contextCompression.capacity", { percentage: Math.min(100, Math.round((contextCompression.sourceTokens / contextCompression.contextWindow) * 100)) })}
                </span>
              )}
            </div>
          )}
          {queueCount > 0 && (
            <div className={cn("flex items-center gap-2 text-xs", isEmptyVariant ? "mb-3" : "mb-2")}>
              <span
                className="rounded-md px-2 py-0.5 font-medium"
                style={{ background: "var(--surface-input)", color: "var(--warning)" }}
              >
                {t("composer.queued", { count: queueCount })}
              </span>
            </div>
          )}

          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={disabled ? t("composer.disconnected") : t("composer.placeholder")}
            disabled={disabled}
            rows={isEmptyVariant ? 3 : 1}
            className={cn(
              "block w-full resize-none bg-transparent text-[15px] leading-relaxed focus:outline-none disabled:cursor-not-allowed",
              isEmptyVariant ? "min-h-[84px] max-h-[200px]" : "min-h-[34px] max-h-[112px]",
            )}
            style={{ color: "var(--text-primary)" }}
          />

          {(attachments.length > 0 || uploadError) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.path}
                  className="flex max-w-[240px] items-center gap-2 rounded-lg border px-2 py-1.5 text-[12px]"
                  style={{
                    borderColor: "var(--border-medium)",
                    background: "var(--surface-input)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <TypeIcon type={(attachment.filename || "").split(".").pop() || "file"} size={28} />
                  <span className="truncate">{attachment.filename}</span>
                  <button
                    type="button"
                    title={`Remove ${attachment.filename}`}
                    onClick={() => removeAttachment(attachment.path)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {uploadError && (
                <span className="text-[11.5px]" style={{ color: "var(--danger)" }}>
                  {uploadError}
                </span>
              )}
            </div>
          )}

        </div>

        {/* Tray inherits the composer surface — no separate fill (operator
            decision 2026-07-18: a two-tone composer reads as fragmented). */}
        <div
          data-testid="composer-controls-tray"
          className="flex min-h-11 items-center justify-between gap-2 rounded-b-[19px] px-3 py-2"
        >
          <div className="relative flex min-w-0 items-center gap-1">
            {showWorkspaceContext && (
              <ContextPicker
                roots={roots}
                selectedRoot={selectedRoot}
                onSelectRoot={onSelectRoot}
                onRootsChanged={onRootsChanged}
                open={pickerOpen}
                onOpenChange={(next) => {
                  setPickerOpen(next);
                  // Opening the project popover closes the sibling popovers.
                  if (next) {
                    setBranchPickerOpen(false);
                  }
                }}
              />
            )}
            {showWorkspaceContext && selectedRoot?.git?.is_repo && (
              <BranchPicker
                root={selectedRoot}
                open={branchPickerOpen}
                onOpenChange={(next) => {
                  setBranchPickerOpen(next);
                  // Opening the branch popover closes the sibling popovers.
                  if (next) {
                    setPickerOpen(false);
                  }
                }}
                onRootsChanged={onRootsChanged}
              />
            )}
            {attachmentControlsEnabled && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={FILE_UPLOAD_ACCEPT}
                  className="hidden"
                  onChange={handleFileSelect}
                />
                {/* One live action — the button IS the action. A menu whose
                    only real row is "Files and folders" (plus a COMING SOON
                    graveyard of unwired features) is an extra click and an
                    unhonest capability list (operator decision 2026-07-18). */}
                <button
                  type="button"
                  title={t("composer.add.files")}
                  aria-label={t("composer.add.files")}
                  disabled={disabled || uploading}
                  onClick={handleAttachClick}
                  className={cn(
                    "flex h-7 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    isEmptyVariant ? "gap-1.5 rounded-md px-2.5 text-[12px]" : "w-7 rounded-full",
                  )}
                  style={{ background: "transparent", color: "var(--text-muted)" }}
                  onMouseEnter={(e) => {
                    if (disabled || uploading) return;
                    e.currentTarget.style.background = "var(--surface-hover)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {isEmptyVariant && <span>{t("composer.add")}</span>}
                </button>
              </>
            )}
            {mentionControlsEnabled && (
              <IconButton title={t("composer.mention")}>
                <AtSign className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
            <PermissionChip sessionId={sessionId} />
            <ModelChip
              canConfigureModels={canConfigureModels}
              onOpenModelSettings={onOpenModelSettings}
            />
            {/* Send/stop lives at the composer's bottom-right corner — the
                standard chat placement (operator decision 2026-07-18: it used
                to float mid-right beside the empty textarea). */}
            <SubmitButton
              enabled={isWorking ? !disabled && !!onCancel && !cancelling : !!text.trim() && !disabled && !uploading}
              working={isWorking}
              cancelling={cancelling}
              onClick={isWorking ? handleCancel : handleSend}
            />
          </div>
        </div>
      </div>

    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--surface-hover)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Send / stop / stopping button. Three explicit states so each click has visible
 * feedback: idle → arrow; working → stop square (reads as an action, not a
 * spinner); cancelling → disabled spinner until the runtime confirms the turn is
 * over. The button sits flush on the composer surface (no accent block — operator
 * decision 2026-07-18: a solid color chip reads as detached from the input); state
 * is carried by the icon + ink level, with the shared hover wash for affordance.
 * The stop state tints the icon red on hover to telegraph "this interrupts".
 */
function SubmitButton({
  enabled,
  working,
  cancelling,
  onClick,
}: {
  enabled: boolean;
  working: boolean;
  cancelling: boolean;
  onClick: () => void;
}) {
  const { t } = useLocale();
  const [hovered, setHovered] = useState(false);
  const title = cancelling ? t("composer.stopping") : working ? t("composer.stop") : t("composer.send");
  const background = hovered && enabled && !cancelling ? "var(--surface-hover)" : "transparent";
  const color = cancelling
    ? "var(--text-muted)"
    : working
      ? hovered
        ? "var(--danger)"
        : "var(--text-primary)"
      : enabled
        ? "var(--text-primary)"
        : "var(--text-muted)";
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      data-testid="composer-submit"
      data-state={cancelling ? "cancelling" : working ? "working" : "idle"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-all disabled:cursor-not-allowed"
      style={{
        background,
        color,
        opacity: enabled || working ? 1 : 0.7,
      }}
      title={title}
      aria-label={title}
    >
      {cancelling ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
      ) : working ? (
        <Square className="h-3 w-3" strokeWidth={0} fill="currentColor" />
      ) : (
        <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
      )}
    </button>
  );
}

// forwardRef so it can be a Radix Popover `asChild` trigger (Radix forwards the
// ref + open/aria/onClick props onto this button).
const ContextChip = forwardRef<
  HTMLButtonElement,
  { selectedRoot: RuntimeWorkspaceRoot | null } & React.ComponentPropsWithoutRef<"button">
>(({ selectedRoot, ...props }, ref) => {
  const { locale, t } = useLocale();
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className="flex h-7 max-w-[230px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] transition-colors"
      style={{
        background: "transparent",
        color: selectedRoot ? "var(--text-secondary)" : "var(--text-muted)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--surface-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {selectedRoot?.git?.is_repo ? <FolderGit2 className="h-3 w-3 opacity-70" /> : <FolderKanban className="h-3 w-3 opacity-70" />}
      <span className="min-w-0 truncate">{selectedRoot ? runtimeRootLabel(selectedRoot, locale) : t("project.choose")}</span>
      <ChevronDown className="h-3 w-3 opacity-60" />
    </button>
  );
});
ContextChip.displayName = "ContextChip";

type ProjectDialogKind = "scratch" | "existing";

function ContextPicker({
  roots,
  selectedRoot,
  onSelectRoot,
  onRootsChanged,
  open,
  onOpenChange,
}: {
  roots: RuntimeWorkspaceRoot[];
  selectedRoot: RuntimeWorkspaceRoot | null;
  onSelectRoot?: (root: RuntimeWorkspaceRoot | null) => void;
  onRootsChanged?: () => void | Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { locale, t } = useLocale();
  const [query, setQuery] = useState("");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialogKind | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootList = useMemo(() => {
    const seen = new Set<string>();
    const ordered = [...runtimeProjectRoots(roots), ...runtimeFolderRoots(roots)];
    return ordered.filter((root) => {
      const key = root.id || root.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [roots]);

  const filteredRoots = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rootList;
    return rootList.filter((root) => {
      const label = runtimeRootLabel(root, locale).toLowerCase();
      const hint = runtimeRootHint(root, locale).toLowerCase();
      return label.includes(normalized) || hint.includes(normalized) || root.path.toLowerCase().includes(normalized);
    });
  }, [locale, query, rootList]);

  // Reset the search box and any open submenu when the popover closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setNewMenuOpen(false);
    }
  }, [open]);

  const chooseRoot = (root: RuntimeWorkspaceRoot | null) => {
    onSelectRoot?.(root);
    onOpenChange(false);
  };

  const openDialog = (kind: ProjectDialogKind) => {
    setDialog(kind);
    setDialogValue("");
    setError(null);
    setNewMenuOpen(false);
  };

  const grantExistingProject = async (value: string) => {
    const granted = await postJson<FsRootsGrantResponse>("/api/fs/roots", { path: value }, t("project.new.error"));
    const path = typeof granted.root?.path === "string" && granted.root.path ? granted.root.path : value;
    await refreshRoots();
    chooseRoot(makeProjectRoot(path, granted.root?.label));
  };

  const chooseExistingProject = async () => {
    setNewMenuOpen(false);
    const nativePicker = window.moziDesktop?.selectDirectory;
    if (!nativePicker) {
      openDialog("existing");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selection = await nativePicker();
      if (selection.canceled) {
        setBusy(false);
        return;
      }
      if (!selection.path?.trim()) throw new Error(t("project.new.error"));
      await grantExistingProject(selection.path.trim());
    } catch (err) {
      setDialog("existing");
      setDialogValue("");
      setError(err instanceof Error ? err.message : t("project.new.error"));
      setBusy(false);
    }
  };

  const resolveWorkspaceRoot = async (): Promise<string> => {
    const workspaceRoot = roots.find((root) => root.kind === "workspace" && root.exists)?.path;
    if (workspaceRoot) return workspaceRoot;

    const result = await readJsonResponse<FsListResponse & { error?: string }>(await fetch("/api/fs/list"));
    if (!result.ok) throw responseError(result.data, result.status, t("project.new.workspaceRootMissing"));
    if (typeof result.data.root !== "string" || !result.data.root.trim()) {
      throw new Error(t("project.new.workspaceRootMissing"));
    }
    return result.data.root;
  };

  const refreshRoots = async () => {
    try {
      await onRootsChanged?.();
    } catch {
      // Selection still succeeds because the caller receives the new root object.
    }
  };

  const submitDialog = async () => {
    const value = dialogValue.trim();
    if (!dialog || !value || busy) return;
    setBusy(true);
    setError(null);

    try {
      if (dialog === "scratch") {
        const workspaceRoot = await resolveWorkspaceRoot();
        const projectsDir = joinFsPath(workspaceRoot, "projects");
        const ensureProjects = await readJsonResponse<FsMkdirResponse>(await fetch("/api/fs/mkdir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: workspaceRoot, name: "projects" }),
        }));
        if (!ensureProjects.ok && ensureProjects.status !== 409) {
          throw responseError(ensureProjects.data, ensureProjects.status, t("project.new.error"));
        }
        const created = await postJson<FsMkdirResponse>("/api/fs/mkdir", { dir: projectsDir, name: value }, t("project.new.error"));
        const path = typeof created.path === "string" && created.path ? created.path : joinFsPath(projectsDir, value);
        await refreshRoots();
        chooseRoot(makeProjectRoot(path, value));
        return;
      }

      await grantExistingProject(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("project.new.error"));
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <ContextChip selectedRoot={selectedRoot} />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[360px] max-w-[calc(100vw-32px)]">
        {dialog ? (
          <ProjectPromptDialog
            kind={dialog}
            value={dialogValue}
            busy={busy}
            error={error}
            onValueChange={setDialogValue}
            onCancel={() => {
              setDialog(null);
              setError(null);
              setBusy(false);
            }}
            onSubmit={submitDialog}
          />
        ) : (
          <>
            {/* Flush command-palette search: the menu itself is the surface, a
                boxed input inside a popover reads as a card-in-card (design
                pass 2026-07-18). The hairline below separates it from rows. */}
            <label
              className="-mx-2 -mt-2 mb-1 flex h-10 items-center gap-2.5 border-b px-4"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <Search className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("project.search")}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink/30"
                style={{ color: "var(--text-primary)" }}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} title={t("files.clearSearch")}>
                  <X className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                </button>
              )}
            </label>

            <PickerItem
              icon={Circle}
              label={t("composer.context.generalTask")}
              hint={t("composer.context.noRoot")}
              active={!selectedRoot}
              onClick={() => chooseRoot(null)}
            />
            <div className="max-h-[260px] overflow-y-auto py-1">
              {filteredRoots.length === 0 ? (
                <EmptyPickerItem icon={FolderKanban} label={query ? t("project.noMatches") : t("composer.context.noProjectRoots")} />
              ) : (
                filteredRoots.map((root) => {
                  const Icon = root.kind === "project_root" || root.git?.is_repo ? FolderKanban : FolderGit2;
                  return (
                    <PickerItem
                      key={root.id}
                      icon={Icon}
                      label={runtimeRootLabel(root, locale)}
                      hint={runtimeRootHint(root, locale)}
                      active={selectedRoot?.id === root.id || selectedRoot?.path === root.path}
                      onClick={() => chooseRoot(root)}
                    />
                  );
                })
              )}
            </div>

            <div className="my-1 border-t" style={{ borderColor: "var(--border-subtle)" }} />
            <Popover open={newMenuOpen} onOpenChange={setNewMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors"
                  style={{ color: "var(--text-primary)" }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                  onMouseMove={(event) => {
                    event.currentTarget.style.background = "var(--surface-hover)";
                  }}
                >
                  <FolderPlus className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                  <span className="min-w-0 flex-1 truncate">{t("project.new")}</span>
                  <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                data-testid="project-new-menu"
                side="right"
                align="end"
                sideOffset={-4}
                className="w-[220px] p-1"
                onOpenAutoFocus={(event) => event.preventDefault()}
              >
                <SubmenuItem icon={FolderPlus} label={t("project.new.scratch")} onClick={() => openDialog("scratch")} />
                <SubmenuItem icon={FolderGit2} label={t("project.new.existing")} onClick={() => void chooseExistingProject()} />
              </PopoverContent>
            </Popover>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function PickerItem({
  icon: Icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
      <span className="flex-1 truncate text-[12.5px]" style={{ color: "var(--text-primary)" }}>
        {label}
      </span>
      {hint && (
        <span className="max-w-[92px] truncate text-[10.5px]" style={{ color: "var(--text-disabled)" }}>
          {hint}
        </span>
      )}
      {active && <Check className="h-3.5 w-3.5" style={{ color: "var(--selection)" }} />}
    </button>
  );
}

function SubmenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors"
      style={{ color: "var(--text-primary)" }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "var(--surface-hover)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
    >
      <Icon className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

interface FsBrowseResponse {
  dir: string;
  base: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  error?: string;
}

/** Server-side folder picker: browses the user's home subtree (a browser can't
 *  hand the agent an absolute server path, so we list dirs over the API). */
function FolderBrowser({ onChange }: { onChange: (path: string) => void }) {
  const { t } = useLocale();
  const [dir, setDir] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const navigate = useCallback(async (target?: string) => {
    setLoading(true);
    setBrowseError(null);
    try {
      const url = target ? `/api/fs/browse?dir=${encodeURIComponent(target)}` : "/api/fs/browse";
      const res = await fetch(url);
      const data = (await res.json()) as FsBrowseResponse;
      if (!res.ok) throw new Error(data.error || t("project.new.browseError"));
      setDir(data.dir);
      setBase(data.base);
      setParent(data.parent);
      setDirs(data.dirs ?? []);
      onChange(data.dir);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : t("project.new.browseError"));
    } finally {
      setLoading(false);
    }
  }, [onChange, t]);

  useEffect(() => {
    void navigate();
    // Load home on mount only; navigate is stable enough for this one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // base is the workspace dir; show paths under it relative for readability.
  const baseParent = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : base;
  const prettyPath = dir && baseParent && dir.startsWith(`${baseParent}/`)
    ? dir.slice(baseParent.length + 1)
    : dir ?? "";

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => parent && void navigate(parent)}
          disabled={!parent || loading}
          title={t("project.new.parentFolder")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.06] disabled:opacity-30"
          style={{ color: "var(--text-secondary)" }}
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
        </button>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-input)", color: "var(--text-secondary)" }}>
          <House className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <span className="truncate" dir="rtl">{prettyPath}</span>
        </span>
      </div>
      <div className="max-h-[220px] overflow-y-auto rounded-md border" style={{ borderColor: "var(--border-subtle)" }}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[12px]" style={{ color: "var(--text-muted)" }}>
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : dirs.length === 0 ? (
          <div className="py-8 text-center text-[12px]" style={{ color: "var(--text-muted)" }}>{t("project.new.browseEmpty")}</div>
        ) : (
          dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onDoubleClick={() => void navigate(entry.path)}
              onClick={() => void navigate(entry.path)}
              className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left text-[12.5px] transition-colors last:border-b-0 hover:bg-ink/[0.04]"
              style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 opacity-55" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-30" />
            </button>
          ))
        )}
      </div>
      {browseError && <p className="mt-2 text-[11.5px]" style={{ color: "var(--danger)" }}>{browseError}</p>}
    </div>
  );
}

function ProjectPromptDialog({
  kind,
  value,
  busy,
  error,
  onValueChange,
  onCancel,
  onSubmit,
}: {
  kind: ProjectDialogKind;
  value: string;
  busy: boolean;
  error: string | null;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useLocale();
  // Existing-folder defaults to the browser; a link falls back to pasting a raw
  // path (e.g. a folder outside the home directory the browser is sandboxed to).
  const [pasteMode, setPasteMode] = useState(false);
  const isBrowse = kind === "existing" && !pasteMode;
  const title = kind === "scratch"
    ? t("project.new.scratch")
    : t("project.new.chooseFolder");
  const label = kind === "scratch" ? t("project.new.nameLabel") : t("project.new.pathLabel");
  const submitLabel = kind === "scratch" ? t("common.create") : t("project.new.useThisFolder");

  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}>
      <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
        <h2 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
        <button type="button" onClick={onCancel} className="transition-colors" style={{ color: "var(--text-muted)" }}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-3 py-3">
        {isBrowse ? (
          <>
            <FolderBrowser onChange={onValueChange} />
            <button
              type="button"
              onClick={() => { setPasteMode(true); onValueChange(""); }}
              className="mt-2 text-[11px] underline-offset-2 hover:underline"
              style={{ color: "var(--text-muted)" }}
            >
              {t("project.new.pastePath")}
            </button>
          </>
        ) : (
          <>
            <label className="mb-1.5 block text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</label>
            <input
              autoFocus
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
              }}
              className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
              style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            />
            {kind === "existing" && (
              <button
                type="button"
                onClick={() => { setPasteMode(false); onValueChange(""); }}
                className="mt-2 text-[11px] underline-offset-2 hover:underline"
                style={{ color: "var(--text-muted)" }}
              >
                {t("project.new.browseInstead")}
              </button>
            )}
          </>
        )}
        {error && <p className="mt-2 text-[11.5px]" style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-[12.5px] transition-colors hover:bg-ink/[0.05]" style={{ color: "var(--text-secondary)" }}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!value.trim() || busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--action)", color: "var(--action-fg)" }}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function EmptyPickerItem({
  icon: Icon,
  label,
}: {
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
      <Icon className="h-3.5 w-3.5 opacity-60" />
      {label}
    </div>
  );
}
