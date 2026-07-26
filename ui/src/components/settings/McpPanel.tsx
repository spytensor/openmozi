import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";

type PermissionLevel = "L0_READ_ONLY" | "L1_READ_WRITE" | "L2_SHELL_EXEC" | "L3_FULL_ACCESS";

interface McpServer {
  id: string;
  command: string;
  args: string[];
  /** Names only — the API never returns the values. */
  env_keys: string[];
  permission_level: PermissionLevel;
  enabled: boolean;
  restart_on_failure: boolean;
  max_restarts: number;
  connected: boolean;
  tool_count: number;
  restarts: number;
  last_error: string | null;
  running: boolean;
}

interface McpTool {
  name: string;
  server_id: string;
  remote_name: string;
  description: string;
  permission_level: PermissionLevel;
}

interface TestResult {
  connected: boolean;
  error: string | null;
  tools: Array<{ name: string; remote_name: string; description: string }>;
}

const PERMISSION_LEVELS: PermissionLevel[] = ["L0_READ_ONLY", "L1_READ_WRITE", "L2_SHELL_EXEC", "L3_FULL_ACCESS"];

interface DraftState {
  id: string;
  command: string;
  args: string;
  env: string;
  permission_level: PermissionLevel;
  enabled: boolean;
  /** Explicit request to wipe the stored credentials, distinct from "untouched". */
  clearEnv: boolean;
}

const EMPTY_DRAFT: DraftState = {
  id: "",
  command: "",
  args: "",
  env: "",
  permission_level: "L0_READ_ONLY",
  enabled: true,
  clearEnv: false,
};

/** `KEY=value` per line → object. Blank lines and comment lines are skipped. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export default function McpPanel() {
  const { get, post, patch, del } = useApi();
  const { t } = useLocale();

  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [serverRes, toolRes] = await Promise.all([
      get<{ servers: McpServer[] }>("/api/mcp/servers"),
      get<{ tools: McpTool[] }>("/api/mcp/tools"),
    ]);
    setLoading(false);
    if (!serverRes.data) {
      setError(serverRes.error ?? t("common.unavailable"));
      return;
    }
    setError(null);
    setServers(serverRes.data.servers);
    setTools(toolRes.data?.tools ?? []);
  }, [get, t]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const env = parseEnv(draft.env);
    const body = {
      command: draft.command.trim(),
      args: draft.args.split("\n").map((a) => a.trim()).filter(Boolean),
      permission_level: draft.permission_level,
      enabled: draft.enabled,
      // A blank field means "leave the stored credentials alone" — the UI never
      // received the values, so it cannot echo them back. Clearing them is a
      // separate, explicit action, otherwise revoking a credential would look
      // like it worked while the old value stayed on disk.
      ...(draft.clearEnv ? { env: {} } : Object.keys(env).length > 0 ? { env } : {}),
    };
    const existing = servers.some((s) => s.id === draft.id);
    const res = existing
      ? await patch(`/api/mcp/servers/${encodeURIComponent(draft.id)}`, body)
      : await post("/api/mcp/servers", { id: draft.id.trim(), ...body });
    setSaving(false);
    if (!res.data) {
      setError(res.error ?? t("common.unavailable"));
      return;
    }
    setDraft(null);
    await load();
  };

  const remove = async (id: string) => {
    const res = await del(`/api/mcp/servers/${encodeURIComponent(id)}`);
    if (!res.data) {
      setError(res.error ?? t("common.unavailable"));
      return;
    }
    await load();
  };

  const test = async (id: string) => {
    setTestingId(id);
    const res = await post<TestResult>(`/api/mcp/servers/${encodeURIComponent(id)}/test`);
    setTestingId(null);
    if (res.data) setTestResults((prev) => ({ ...prev, [id]: res.data as TestResult }));
    else setError(res.error ?? t("common.unavailable"));
  };

  const startEdit = (server: McpServer) => setDraft({
    id: server.id,
    command: server.command,
    args: server.args.join("\n"),
    env: "",
    permission_level: server.permission_level,
    enabled: server.enabled,
    clearEnv: false,
  });

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink/40">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
            style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("common.refresh")}
          </button>
          <button
            type="button"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
            className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
            style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.mcp.addServer")}
          </button>
        </div>
      </div>

      {error && <p className="text-[12.5px] text-danger">{error}</p>}

      {servers.length === 0 && !draft && (
        <p className="text-[12.5px] text-ink/38">{t("settings.mcp.noServers")}</p>
      )}

      {servers.map((server) => {
        const result = testResults[server.id];
        return (
          <div
            key={server.id}
            className="flex flex-col gap-2 rounded-md p-3"
            style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)" }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Plug className="h-3.5 w-3.5 shrink-0 text-ink/40" />
                  <span className="truncate text-[13px] font-medium text-ink/80">{server.id}</span>
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-ink/50"
                    style={{ background: "var(--surface-elevated)" }}
                  >
                    {server.permission_level}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[11.5px] text-ink/38">
                  {server.command} {server.args.join(" ")}
                </p>
                {server.env_keys.length > 0 && (
                  <p className="mt-0.5 text-[11px] text-ink/34">
                    {t("settings.mcp.envKeys")}: {server.env_keys.join(", ")}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void test(server.id)}
                  disabled={testingId === server.id}
                  className="flex h-7 items-center gap-1.5 rounded px-2 text-[11.5px] text-ink/55 transition-colors hover:bg-ink/[0.05] disabled:opacity-60"
                >
                  {testingId === server.id && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("settings.mcp.test")}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(server)}
                  className="flex h-7 items-center rounded px-2 text-[11.5px] text-ink/55 transition-colors hover:bg-ink/[0.05]"
                >
                  {t("settings.mcp.edit")}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(server.id)}
                  aria-label={t("settings.mcp.delete")}
                  className="flex h-7 w-7 items-center justify-center rounded text-ink/40 transition-colors hover:bg-ink/[0.05] hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink/45">
              <span>
                {!server.enabled
                  ? t("settings.mcp.statusDisabled")
                  : !server.running
                    ? t("settings.mcp.statusPendingRestart")
                    : server.connected
                      ? t("settings.mcp.statusConnected", { count: String(server.tool_count) })
                      : t("settings.mcp.statusDisconnected")}
              </span>
              {server.restarts > 0 && <span>{t("settings.mcp.restarts", { count: String(server.restarts) })}</span>}
            </div>

            {server.last_error && <p className="text-[11.5px] text-danger">{server.last_error}</p>}

            {result && (
              <p className="text-[11.5px] text-ink/45">
                {result.connected
                  ? t("settings.mcp.testOk", { count: String(result.tools.length) })
                  : `${t("settings.mcp.testFailed")}${result.error ? `: ${result.error}` : ""}`}
              </p>
            )}
          </div>
        );
      })}

      {draft && (
        <div
          className="flex flex-col gap-3 rounded-md p-3"
          style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink/80">
              {servers.some((s) => s.id === draft.id) ? t("settings.mcp.editServer") : t("settings.mcp.addServer")}
            </span>
            <button
              type="button"
              onClick={() => setDraft(null)}
              aria-label={t("common.cancel")}
              className="flex h-7 w-7 items-center justify-center rounded text-ink/40 transition-colors hover:bg-ink/[0.05]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <label className="flex flex-col gap-1 text-[11.5px] text-ink/45">
            {t("settings.mcp.fieldId")}
            <input
              value={draft.id}
              disabled={servers.some((s) => s.id === draft.id)}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              className="h-8 rounded px-2 text-[12.5px] text-ink/80 outline-none disabled:opacity-60"
              style={{ background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11.5px] text-ink/45">
            {t("settings.mcp.fieldCommand")}
            <input
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="npx"
              className="h-8 rounded px-2 font-mono text-[12.5px] text-ink/80 outline-none"
              style={{ background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11.5px] text-ink/45">
            {t("settings.mcp.fieldArgs")}
            <textarea
              value={draft.args}
              onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              rows={3}
              className="rounded px-2 py-1.5 font-mono text-[12.5px] text-ink/80 outline-none"
              style={{ background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11.5px] text-ink/45">
            {t("settings.mcp.fieldEnv")}
            <textarea
              value={draft.env}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })}
              rows={3}
              placeholder="API_KEY=..."
              className="rounded px-2 py-1.5 font-mono text-[12.5px] text-ink/80 outline-none"
              style={{ background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}
            />
            <span className="text-[11px] text-ink/34">{t("settings.mcp.envHint")}</span>
          </label>

          {servers.find((s) => s.id === draft.id)?.env_keys.length ? (
            <label className="flex items-center gap-2 text-[11.5px] text-ink/45">
              <input
                type="checkbox"
                checked={draft.clearEnv}
                onChange={(e) => setDraft({ ...draft, clearEnv: e.target.checked })}
              />
              {t("settings.mcp.clearEnv")}
            </label>
          ) : null}

          <label className="flex flex-col gap-1 text-[11.5px] text-ink/45">
            {t("settings.mcp.fieldPermission")}
            <select
              value={draft.permission_level}
              onChange={(e) => setDraft({ ...draft, permission_level: e.target.value as PermissionLevel })}
              className="h-8 rounded px-2 text-[12.5px] text-ink/80 outline-none"
              style={{ background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}
            >
              {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
            <span className="text-[11px] text-ink/34">{t("settings.mcp.permissionHint")}</span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !draft.id.trim() || !draft.command.trim()}
              className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors disabled:opacity-60"
              style={{ background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("settings.mcp.save")}
            </button>
            <span className="text-[11px] text-ink/34">{t("settings.mcp.restartHint")}</span>
          </div>
        </div>
      )}

      {tools.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink/60">
            {t("settings.mcp.exposedTools", { count: String(tools.length) })}
          </span>
          {tools.map((tool) => (
            <div key={tool.name} className="flex items-baseline gap-2 text-[11.5px]">
              <span className="font-mono text-ink/60">{tool.name}</span>
              <span className="truncate text-ink/34">{tool.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
