import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderGit2,
  HardDrive,
  Loader2,
  Power,
  RefreshCw,
  Server,
  ShieldAlert,
} from "lucide-react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { runtimeRootLabel } from "@/lib/runtime-display";
import type {
  RuntimeHealth,
  RuntimeLogSnapshot,
  RuntimeServiceStatus,
  RuntimeWorkspaceRoot,
  RuntimeWorkspaceSnapshot,
} from "@/types/runtime";
import { translateMessage, useLocale, type Locale, type MessageKey } from "@/i18n";

interface RuntimeInspectViewProps {
  embedded?: boolean;
  snapshot: RuntimeWorkspaceSnapshot | null;
  logs: RuntimeLogSnapshot | null;
  health: RuntimeHealth | null;
  service: RuntimeServiceStatus | null;
  loading: boolean;
  serviceBusy: boolean;
  error: string | null;
  onRefresh: () => void;
  onSetServiceEnabled: (enabled: boolean) => void;
}

const statusLabelKeys: Record<string, MessageKey> = {
  pending: "inspect.status.pending",
  ready: "inspect.status.ready",
  assigned: "inspect.status.assigned",
  running: "inspect.status.running",
  queued: "inspect.status.queued",
  launching: "inspect.status.launching",
  completed_pending_verify: "inspect.status.completedPendingVerify",
  succeeded: "inspect.status.succeeded",
  completed: "inspect.status.completed",
  failed: "inspect.status.failed",
  timed_out: "inspect.status.timedOut",
  cancelled: "inspect.status.cancelled",
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join("/")}`;
}

function rootMeta(root: RuntimeWorkspaceRoot, locale: Locale): string {
  if (root.git?.branch) return root.git.branch;
  if (root.git?.is_repo) return translateMessage(locale, "inspect.root.git");
  return root.exists ? translateMessage(locale, "inspect.root.folder") : translateMessage(locale, "inspect.root.missing");
}

function statusEntries(statuses: Record<string, number>): Array<[string, number]> {
  return Object.entries(statuses).filter(([, count]) => count > 0);
}

function failureEntries(statuses: Record<string, number>): Array<[string, number]> {
  return Object.entries(statuses).filter(([status, count]) => count > 0 && ["failed", "timed_out", "cancelled"].includes(status));
}

export default function RuntimeInspectView({
  embedded = false,
  snapshot,
  logs,
  health,
  service,
  loading,
  serviceBusy,
  error,
  onRefresh,
  onSetServiceEnabled,
}: RuntimeInspectViewProps) {
  const { locale, t } = useLocale();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const taskStatuses = statusEntries(snapshot?.runtime.tasks_by_status ?? {});
  const workerStatuses = statusEntries(snapshot?.runtime.worker_jobs_by_status ?? {});
  const backgroundStatuses = statusEntries(snapshot?.runtime.background_tasks_by_status ?? {});
  const recentFailures = [
    ...failureEntries(snapshot?.runtime.tasks_by_status ?? {}),
    ...failureEntries(snapshot?.runtime.worker_jobs_by_status ?? {}),
    ...failureEntries(snapshot?.runtime.background_tasks_by_status ?? {}),
  ];
  const serviceUnsupported = service?.platform === "unsupported";
  const serviceEnabled = !!service?.installed && service.enabled;
  const serviceActive = !!service?.installed && service.active;

  const content = (
    <>
        {!embedded && (
          <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
              <Server className="h-3.5 w-3.5" />
              <span>{t("inspect.kicker")}</span>
            </div>
            <h1 className="mt-1 text-[22px] font-semibold tracking-normal">{t("inspect.title")}</h1>
          </div>
          <button
            onClick={onRefresh}
            className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors disabled:opacity-60"
            disabled={loading}
            style={{
              background: "var(--surface-input)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {t("inspect.refresh")}
          </button>
          </header>
        )}

        {error && (
          <div
            className="flex items-center gap-2 rounded-md px-3 py-2 text-[12.5px]"
            style={{
              background: "color-mix(in srgb, var(--danger) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger) 38%, transparent)",
              color: "var(--text-primary)",
            }}
          >
            <ShieldAlert className="h-4 w-4" style={{ color: "var(--danger)" }} />
            {error}
          </div>
        )}

        <Panel title={t("inspect.health.title")}>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <HealthRow
              icon={Server}
              label={t("inspect.health.currentDaemon")}
              value={health?.ok ? t("inspect.health.daemonRunning") : t("inspect.health.daemonUnavailable")}
              detail={health?.pid ? t("inspect.health.pid", { pid: health.pid }) : t("common.unknown")}
              ok={!!health?.ok}
            />
            <HealthRow
              icon={Power}
              label={t("inspect.health.backgroundService")}
              value={serviceStatusLabel(service, t)}
              detail={serviceUnsupported ? t("inspect.unsupported") : service?.installed ? service.unitPath : t("inspect.health.backgroundNotInstalled")}
              ok={serviceActive || serviceEnabled}
            />
            <HealthRow
              icon={AlertTriangle}
              label={t("inspect.health.recordedFailures")}
              value={recentFailures.length === 0 ? t("inspect.health.noFailures") : String(recentFailures.reduce((sum, [, count]) => sum + count, 0))}
              detail={recentFailures.length === 0 ? t("common.ready") : recentFailures.map(([status, count]) => `${statusLabelKeys[status] ? translateMessage(locale, statusLabelKeys[status]) : status} ${count}`).join(" · ")}
              ok={recentFailures.length === 0}
            />
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={HardDrive} label={t("inspect.metric.storage")} value={snapshot?.storage.db_exists ? t("common.ready") : t("common.missing")} detail={snapshot ? formatBytes(snapshot.storage.db_size_bytes) : t("common.loading")} ok={!!snapshot?.storage.db_exists} />
          <Metric icon={Activity} label={t("inspect.metric.activeWork")} value={String(snapshot?.counts.active_tasks ?? 0)} detail={t("inspect.metric.runningTasks")} ok={(snapshot?.counts.active_tasks ?? 0) === 0} />
          <Metric icon={Database} label={t("inspect.metric.memory")} value={String(snapshot?.counts.memory_facts ?? 0)} detail={t("inspect.metric.digests", { count: snapshot?.counts.session_digests ?? 0 })} ok />
          <Metric icon={Server} label={t("inspect.metric.workers")} value={String(snapshot?.counts.worker_jobs ?? 0)} detail={workerStatuses.length ? workerStatuses.map(([status, count]) => `${statusLabelKeys[status] ? translateMessage(locale, statusLabelKeys[status]) : status}: ${count}`).join(" · ") : t("inspect.noAgentJobs")} ok={!workerStatuses.some(([status]) => ["failed", "timed_out"].includes(status))} />
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="min-w-0 space-y-4 xl:col-span-2">
            <Panel title={t("inspect.workspaceRoots")}>
              <div className="flex flex-col gap-1">
                {(snapshot?.roots ?? []).map((root) => (
                  <div
                    key={root.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md px-2.5 py-2"
                    style={{ background: "var(--surface-input)" }}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderGit2 className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} />
                        <span className="truncate text-[13px] font-medium">{runtimeRootLabel(root, locale)}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                        {rootMeta(root, locale)}
                      </div>
                    </div>
                  </div>
                ))}
                {snapshot && snapshot.roots.length === 0 && <EmptyLine text={t("inspect.noRoots")} />}
                {!snapshot && <EmptyLine text={t("inspect.loadingRoots")} />}
              </div>
            </Panel>
          </div>

          <div className="min-w-0 space-y-4">
            <Panel title={t("inspect.taskState")}>
              <StatusList entries={taskStatuses} empty={t("inspect.noActiveTaskState")} locale={locale} />
            </Panel>

            <Panel title={t("inspect.agentRuntime")}>
              <StatusList entries={workerStatuses} empty={t("inspect.noAgentJobs")} locale={locale} />
            </Panel>

            <Panel title={t("inspect.backgroundWork")}>
              <StatusList entries={backgroundStatuses} empty={t("inspect.noBackgroundWork")} locale={locale} />
            </Panel>
          </div>
        </div>

        <Panel title={t("inspect.diagnostics.title")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-[680px] text-[12px] leading-5" style={{ color: "var(--text-muted)" }}>
              {t("inspect.diagnostics.description")}
            </p>
            <button
              onClick={() => setDiagnosticsOpen((value) => !value)}
              className="rounded-md px-3 py-1.5 text-[12px]"
              style={{
                background: "var(--surface-input)",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
              }}
            >
              {diagnosticsOpen ? t("inspect.diagnostics.hide") : t("inspect.diagnostics.show")}
            </button>
          </div>

          {diagnosticsOpen && (
            <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
              <div className="min-w-0 space-y-4 xl:col-span-2">
                <DiagnosticBlock title={t("inspect.storagePaths")}>
              <PathRow label={t("inspect.path.moziHome")} value={snapshot?.mozi_home.path} ok={snapshot?.mozi_home.exists} />
              <PathRow label={t("inspect.path.config")} value={snapshot?.config.path} ok={snapshot?.config.exists} />
              <PathRow label={t("inspect.path.sqlite")} value={snapshot?.storage.db_path} ok={snapshot?.storage.db_exists} />
              <PathRow label={t("inspect.path.log")} value={snapshot?.storage.log_path} ok={snapshot?.storage.log_exists} />
              <PathRow label={t("inspect.path.heartbeat")} value={snapshot?.storage.heartbeat_path} ok={snapshot?.storage.heartbeat_exists} />
              <PathRow label={t("inspect.path.pid")} value={snapshot?.storage.pid_path} ok={snapshot?.storage.pid_exists} />
              <PathRow label={t("inspect.path.legacy")} value={snapshot?.migration?.legacy_home_path} ok={snapshot?.migration ? !snapshot.migration.conflict : undefined} />
              <PathRow label={t("inspect.path.manifest")} value={snapshot?.migration?.manifest_path} ok={snapshot?.migration ? snapshot.migration.manifest_exists || !snapshot.migration.conflict : undefined} />
                </DiagnosticBlock>

                <DiagnosticBlock title={t("inspect.logTail")}>
              <div className="max-h-[300px] min-w-0 overflow-auto rounded-md p-3 font-mono text-[11px] leading-5" style={{ background: "var(--surface-input)", color: "var(--text-secondary)" }}>
                {logs?.lines.length ? (
                  logs.lines.map((line, index) => <div key={`${index}-${line.slice(0, 24)}`} className="whitespace-pre-wrap break-words">{line}</div>)
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>{logs?.exists ? t("inspect.noLogLines") : t("inspect.logFileNotFound")}</span>
                )}
              </div>
                </DiagnosticBlock>
              </div>

              <div className="min-w-0 space-y-4">
                <DiagnosticBlock title={t("inspect.runtimeService")}>
              <div className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2" style={{ background: "var(--surface-input)" }}>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{t("inspect.runInBackground")}</div>
                  <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {serviceUnsupported ? t("inspect.unsupported") : serviceEnabled ? t("common.enabled") : t("common.disabled")}
                  </div>
                </div>
                <button
                  onClick={() => onSetServiceEnabled(!serviceEnabled)}
                  disabled={!service || serviceUnsupported || serviceBusy}
                  className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors disabled:opacity-60"
                  style={{
                    background: serviceEnabled ? "var(--surface-hover)" : "var(--surface-input)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {serviceBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                  {serviceBusy ? t("common.working") : serviceEnabled ? t("inspect.disable") : t("inspect.enable")}
                </button>
              </div>
              <PathRow label={t("inspect.path.enabled")} value={service ? (serviceEnabled ? t("common.enabled") : t("common.disabled")) : undefined} ok={service ? serviceEnabled : undefined} />
              <PathRow label={t("inspect.path.active")} value={service ? (serviceActive ? t("common.enabled") : t("common.disabled")) : undefined} ok={service ? serviceActive : undefined} />
              <PathRow label={t("inspect.path.unit")} value={service?.installed ? service.unitPath : undefined} ok={service?.installed ? true : undefined} />
                </DiagnosticBlock>

                <DiagnosticBlock title={t("inspect.workData")}>
              <CountRow label={t("inspect.count.chats")} value={snapshot?.counts.sessions} />
              <CountRow label={t("inspect.count.messages")} value={snapshot?.counts.conversations} />
              <CountRow label={t("inspect.count.skills")} value={snapshot?.counts.skills} />
              <CountRow label={t("inspect.count.agentJobs")} value={snapshot?.counts.worker_jobs} />
              <CountRow label={t("inspect.count.scheduledWork")} value={snapshot?.counts.background_tasks} />
                </DiagnosticBlock>
              </div>
            </div>
          )}
        </Panel>
    </>
  );

  if (embedded) {
    return <div data-testid="settings-diagnostics-panel" className="min-w-0 space-y-4">{content}</div>;
  }

  return (
    <WorkspacePage testId="inspect-scroll-region">
      {content}
    </WorkspacePage>
  );
}

function serviceStatusLabel(service: RuntimeServiceStatus | null, t: (key: MessageKey, values?: Record<string, string | number>) => string): string {
  if (!service?.installed) return t("inspect.health.backgroundNotInstalled");
  if (service.active) return t("inspect.health.backgroundActive");
  if (service.enabled) return t("inspect.health.backgroundEnabled");
  return t("inspect.health.backgroundDisabled");
}

function HealthRow({
  icon: Icon,
  label,
  value,
  detail,
  ok,
}: {
  icon: typeof Server;
  label: string;
  value: string;
  detail: string;
  ok: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md px-3 py-3" style={{ background: "var(--surface-input)" }}>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {ok ? <CheckCircle2 className="ml-auto h-3.5 w-3.5" style={{ color: "var(--success)" }} /> : <ShieldAlert className="ml-auto h-3.5 w-3.5" style={{ color: "var(--warning)" }} />}
      </div>
      <div className="mt-2 truncate text-[14px] font-medium">{value}</div>
      <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{shortPath(detail)}</div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  ok,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
  detail: string;
  ok: boolean;
}) {
  return (
    // Background shift only — a bordered card inside the bordered Panel
    // would be card-in-card (DESIGN.md red line).
    <div className="rounded-md px-3 py-3" style={{ background: "var(--surface-input)" }}>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {ok ? <CheckCircle2 className="ml-auto h-3.5 w-3.5" style={{ color: "var(--success)" }} /> : <ShieldAlert className="ml-auto h-3.5 w-3.5" style={{ color: "var(--warning)" }} />}
      </div>
      <div className="mt-2 text-[20px] font-semibold">{value}</div>
      <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{detail}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card-surface min-w-0 p-4">
      <h2 className="section-header mb-3">{title}</h2>
      {children}
    </section>
  );
}

function DiagnosticBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md bg-ink/[0.03] p-3">
      <h3 className="mb-2 text-[12px] font-semibold text-ink/50">{title}</h3>
      {children}
    </section>
  );
}

function PathRow({ label, value, ok }: { label: string; value?: string; ok?: boolean }) {
  const { t } = useLocale();
  return (
    <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)_16px] items-center gap-3 border-t border-ink/[0.04] py-2 first:border-t-0">
      <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="min-w-0 truncate font-mono text-[11px]">{value ? shortPath(value) : t("common.loading")}</span>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--success)" }} /> : <ShieldAlert className="h-3.5 w-3.5" style={{ color: "var(--warning)" }} />}
    </div>
  );
}

function CountRow({ label, value }: { label: string; value?: number }) {
  return (
    <div className="flex items-center justify-between border-t border-ink/[0.04] py-2 first:border-t-0">
      <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="font-mono text-[12px]">{value ?? 0}</span>
    </div>
  );
}

function StatusList({ entries, empty, locale }: { entries: Array<[string, number]>; empty: string; locale: Locale }) {
  if (entries.length === 0) return <EmptyLine text={empty} />;
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([status, count]) => (
        <div key={status} className="flex items-center justify-between rounded-md px-2 py-1.5" style={{ background: "var(--surface-input)" }}>
          <span className="truncate text-[12px]" style={{ color: "var(--text-secondary)" }}>{statusLabelKeys[status] ? translateMessage(locale, statusLabelKeys[status]) : status}</span>
          <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>{count}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-md px-2 py-2 text-[12px]" style={{ background: "var(--surface-input)", color: "var(--text-muted)" }}>{text}</div>;
}
