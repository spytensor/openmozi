import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, GitBranch, Plus, Search, X } from "lucide-react";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import { useLocale } from "@/i18n";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Composer branch chip + picker (Codex-style) for git project roots.
 *
 * Built on the shared Radix Popover primitive so outside-click, Escape,
 * window-resize/scroll dismissal, collision-aware positioning, portal layering,
 * and focus management all come from the library — not hand-rolled. Switching
 * is plain `git switch` on the real working tree: uncommitted changes carry
 * over per git defaults, conflicts abort server-side with git's stderr surfaced
 * verbatim here. Nothing is stashed or forced.
 */

interface GitBranchEntry {
  name: string;
  last_commit_at: string | null;
  subject: string;
  is_current: boolean;
}

interface GitBranchesResponse {
  success: boolean;
  error?: string;
  current: { branch: string | null; detached: boolean; sha: string | null };
  dirty_count: number;
  is_runtime_source: boolean;
  branches: GitBranchEntry[];
}

// Mirrors backend isValidBranchName (src/tools/git.ts) for instant feedback;
// the backend remains the authority.
export function isLikelyValidBranchName(name: string): boolean {
  if (!name || name.length > 244 || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(name)) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

type PendingSwitch = { branch: string; create: boolean };

export function BranchPicker({
  root,
  open,
  onOpenChange,
  onRootsChanged,
}: {
  root: RuntimeWorkspaceRoot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRootsChanged?: () => void | Promise<void>;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [data, setData] = useState<GitBranchesResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "failed" | "ready">("loading");
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirming, setConfirming] = useState<PendingSwitch | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    setSwitchError(null);
    try {
      const response = await fetch(`/api/git/branches?root=${encodeURIComponent(root.path)}`, {
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => ({}))) as GitBranchesResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
      setLoadState("ready");
    } catch {
      setLoadState("failed");
    }
  }, [root.path]);

  // Fetch on open (Popover mounts content lazily, so this IS fetch-on-open).
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Reset transient panel state whenever the popover closes.
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setNewName("");
      setSwitchError(null);
      setQuery("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const branches = data?.branches ?? [];
    // Current branch pinned first; the rest keep git's -committerdate order.
    const ordered = [...branches.filter((b) => b.is_current), ...branches.filter((b) => !b.is_current)];
    if (!normalized) return ordered;
    return ordered.filter((b) => b.name.toLowerCase().includes(normalized));
  }, [data, query]);

  const performSwitch = useCallback(async (branch: string, create: boolean) => {
    setBusy(true);
    setSwitchError(null);
    try {
      const response = await fetch("/api/git/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ root: root.path, branch, ...(create ? { create: true } : {}) }),
      });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || `HTTP ${response.status}`);
      await onRootsChanged?.();
      onOpenChange(false);
    } catch (err) {
      // git aborted — tree untouched; show git's own reason verbatim.
      setSwitchError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      onOpenChange(true); // keep the panel open to show the error
    }
  }, [onOpenChange, onRootsChanged, root.path]);

  const requestSwitch = useCallback((branch: string, create: boolean) => {
    if (!data) return;
    if (data.dirty_count > 0 || data.is_runtime_source) {
      // Hand off to the confirm dialog; close the popover so the modal stands
      // alone instead of layering the panel behind it.
      setConfirming({ branch, create });
      onOpenChange(false);
      return;
    }
    void performSwitch(branch, create);
  }, [data, onOpenChange, performSwitch]);

  const newNameValid = isLikelyValidBranchName(newName.trim());
  const chipLabel = root.git?.branch ?? root.git?.detached_sha ?? "";

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="branch-chip"
            title={t("branch.chip.title")}
            className="flex h-7 max-w-[180px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] transition-colors"
            style={{ background: "transparent", color: "var(--text-secondary)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <GitBranch className="h-3 w-3 opacity-70" />
            <span className="min-w-0 truncate">{chipLabel}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="branch-picker"
          side="top"
          align="start"
          className="w-[320px] max-w-[calc(100vw-32px)]"
        >
          {creating ? (
            <div className="flex flex-col gap-2 p-1">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && newNameValid && !busy) requestSwitch(newName.trim(), true);
                }}
                placeholder={t("branch.create.placeholder")}
                className="h-9 rounded-lg border px-2.5 text-[12.5px] outline-none"
                style={{
                  background: "var(--surface-input)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--text-primary)",
                }}
              />
              {newName.trim() && !newNameValid && (
                <span className="text-[11px]" style={{ color: "var(--danger)" }}>{t("branch.create.invalid")}</span>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="h-7 rounded-lg px-2.5 text-[12px]"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                >
                  {t("branch.confirm.cancel")}
                </button>
                <button
                  type="button"
                  disabled={!newNameValid || busy}
                  className="h-7 rounded-lg px-2.5 text-[12px] disabled:opacity-40"
                  style={{ background: "var(--action)", color: "var(--action-fg)" }}
                  onClick={() => requestSwitch(newName.trim(), true)}
                >
                  {t("branch.create.confirm")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label
                className="mb-2 flex h-9 items-center gap-2 rounded-lg border px-2.5"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)" }}
              >
                <Search className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("branch.picker.search")}
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink/30"
                  style={{ color: "var(--text-primary)" }}
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")}>
                    <X className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                  </button>
                )}
              </label>

              {loadState === "loading" && (
                <div className="px-2 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>…</div>
              )}
              {loadState === "failed" && (
                <div className="flex items-center justify-between px-2 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                  <span>{t("branch.picker.error")}</span>
                  <button type="button" style={{ color: "var(--link)" }} onClick={() => void load()}>
                    {t("branch.picker.retry")}
                  </button>
                </div>
              )}
              {loadState === "ready" && data && (
                <>
                  {data.current.detached && data.current.sha && (
                    <div className="px-2 pb-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {t("branch.picker.detached", { sha: data.current.sha })}
                    </div>
                  )}
                  <div className="max-h-[260px] overflow-y-auto py-1">
                    {filtered.length === 0 ? (
                      <div className="px-2 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {query ? t("branch.picker.noMatches") : t("branch.picker.empty")}
                      </div>
                    ) : (
                      filtered.map((branch) => (
                        <button
                          key={branch.name}
                          type="button"
                          disabled={busy || branch.is_current}
                          onClick={() => requestSwitch(branch.name, false)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-default"
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: "var(--text-primary)" }}>
                            {branch.name}
                          </span>
                          {branch.is_current && data.dirty_count > 0 && (
                            <span className="shrink-0 text-[10.5px]" style={{ color: "var(--text-disabled)" }}>
                              {t("branch.picker.dirtyHint", { count: data.dirty_count })}
                            </span>
                          )}
                          {branch.is_current && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--selection)" }} />}
                        </button>
                      ))
                    )}
                  </div>
                  {switchError && (
                    <div
                      data-testid="branch-switch-error"
                      className="mx-1 mb-1 max-h-[96px] overflow-y-auto whitespace-pre-wrap rounded-lg px-2 py-1.5 text-[11px]"
                      style={{ background: "var(--surface-input)", color: "var(--danger)" }}
                    >
                      {t("branch.switch.failed", { error: switchError })}
                    </div>
                  )}
                  <div className="my-1 border-t" style={{ borderColor: "var(--border-subtle)" }} />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setCreating(true);
                      setSwitchError(null);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors"
                    style={{ color: "var(--text-primary)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Plus className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
                    <span className="min-w-0 flex-1 truncate">{t("branch.picker.create")}</span>
                  </button>
                </>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog open={confirming !== null} onOpenChange={(next) => { if (!next) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("branch.confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {data && data.dirty_count > 0
                ? t("branch.confirm.body", { count: data.dirty_count, branch: confirming?.branch ?? "" })
                : null}
              {data?.is_runtime_source ? `${data.dirty_count > 0 ? "\n\n" : ""}${t("branch.confirm.runtimeSource")}` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("branch.confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = confirming;
                setConfirming(null);
                if (pending) void performSwitch(pending.branch, pending.create);
              }}
            >
              {t("branch.confirm.switch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
