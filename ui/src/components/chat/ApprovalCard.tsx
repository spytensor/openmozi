import { Check, ChevronDown, MoreHorizontal, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { ApprovalRequest } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n";

interface ApprovalCardProps {
  request: ApprovalRequest;
  onApprove: (id: string, scope?: "once" | "session") => void;
  onReject: (id: string) => void;
  /**
   * Identical resolved approvals from the same turn collapse into one line
   * with a count (display policy — each underlying approval stays a durable
   * record). Never applied to pending requests: every pending approval is a
   * distinct standing control the operator must answer individually.
   */
  repeatCount?: number;
}

export default function ApprovalCard({ request, onApprove, onReject, repeatCount = 1 }: ApprovalCardProps) {
  const { t } = useLocale();
  const isPending = request.status === "pending";
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const isAccessDecision = request.action === "permission_elevation" || request.action === "write_confirmation";
  const isScopeGrant = request.action === "path_scope_grant";
  const hasSessionOption = isAccessDecision || isScopeGrant;
  const actionLabel = approvalActionLabel(request, t);
  const currentLevel = shortPermissionLevel(request.current_level);
  const requiredLevel = shortPermissionLevel(request.required_level);
  const showPermissionChange = Boolean(currentLevel && requiredLevel);

  // A resolved approval is transcript history, not a standing control surface.
  if (!isPending) {
    const approved = request.status === "approved";
    return (
      <div
        data-testid="approval-resolved-line"
        className="flex items-center gap-2 py-1 text-[12.5px] text-ink/45"
      >
        {approved ? (
          <Check size={13} className="shrink-0 text-success" />
        ) : (
          <X size={13} className="shrink-0 text-ink/35" />
        )}
        <span className="min-w-0 truncate">
          <span className={approved ? "text-success/90" : "text-ink/55"}>
            {approved ? t("approval.approved") : t("approval.rejected")}
          </span>
          <span className="text-ink/40"> · {actionLabel}</span>
        </span>
        {repeatCount > 1 && (
          <span data-testid="approval-repeat-count" className="shrink-0 tabular-nums text-[11.5px] text-ink/30">
            ×{repeatCount}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="approval-card"
      className="rounded-xl border border-ink/[0.10] bg-elevated/70 px-3 py-2.5 shadow-sm"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-[220px] flex-1 items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
            <ShieldCheck size={15} strokeWidth={1.8} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-ink/90" title={actionLabel}>
              {actionLabel}
            </p>
            {request.description !== actionLabel && (
              <p className="mt-0.5 truncate text-[11.5px] text-ink/45" title={request.description}>
                {request.description}
              </p>
            )}

            {(showPermissionChange || request.tool || request.denied_action) && (
              <details className="group mt-1.5 text-[11px] text-ink/45">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm outline-none hover:text-ink/65 focus-visible:ring-2 focus-visible:ring-focus/40">
                  {t("approval.details")}
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                </summary>
                <div
                  data-testid="approval-technical-details"
                  className="mt-1.5 space-y-1 border-l border-ink/[0.10] pl-2.5 leading-4 text-ink/50"
                >
                  {/* The subtitle already shows the description; repeat it here
                      only when it is long enough to have been truncated above. */}
                  {request.description.length > 96 && (
                    <p className="overflow-wrap-anywhere">{request.description}</p>
                  )}
                  {showPermissionChange && (
                    <p>{t("approval.permissionChange", { current: currentLevel, required: requiredLevel })}</p>
                  )}
                  {request.tool && <p>{t("approval.toolName", { tool: request.tool })}</p>}
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onReject(request.id)}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-ink/55 transition-colors hover:bg-ink/[0.05] hover:text-ink/80"
          >
            <X size={13} /> {t("approval.reject")}
          </button>
          <button
            type="button"
            onClick={() => onApprove(request.id, hasSessionOption ? "once" : undefined)}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
          >
            <Check size={13} /> {hasSessionOption ? t("approval.allowOnce") : t("approval.approve")}
          </button>

          {hasSessionOption && (
            <DropdownMenu open={sessionMenuOpen} onOpenChange={setSessionMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("approval.moreOptions")}
                  title={t("approval.moreOptions")}
                  onClick={() => setSessionMenuOpen(true)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.05] hover:text-ink/75"
                >
                  <MoreHorizontal size={15} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="end"
                sideOffset={6}
                className="w-[260px] rounded-lg border border-ink/[0.10] bg-elevated p-1 text-ink shadow-[0_20px_60px_-28px_rgba(0,0,0,0.72)]"
              >
                <DropdownMenuItem
                  onSelect={() => onApprove(request.id, "session")}
                  className="cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 focus:bg-ink/[0.06] focus:text-ink"
                >
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink/55" />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-ink/85">
                      {t("approval.allowSession")}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-ink/45">
                      {isAccessDecision
                        ? t("approval.allowSessionAccessDescription")
                        : t("approval.allowSessionScopeDescription")}
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
}

function shortPermissionLevel(level: string | undefined): string {
  const match = level?.match(/^L(\d)_/);
  return match ? `L${match[1]}` : level ?? "";
}

function approvalActionLabel(request: ApprovalRequest, t: ReturnType<typeof useLocale>["t"]): string {
  if (request.action === "write_confirmation") return t("approval.action.writeFiles");
  if (request.action === "path_scope_grant") return t("approval.action.outsideProject");

  switch (request.tool) {
    case "web_search":
      return t("approval.action.webSearch");
    case "web_fetch":
      return t("approval.action.webFetch");
    case "browser_open":
    case "browser_click":
    case "browser_type":
    case "browser_extract":
    case "browser_assert":
      return t("approval.action.browser");
    case "git_push":
      return t("approval.action.gitPush");
    default:
      return request.tool_intent || request.denied_action || request.tool || request.description;
  }
}
