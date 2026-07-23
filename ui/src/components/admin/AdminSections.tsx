import { useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  Ban,
  BarChart3,
  Bot,
  Check,
  ChartNoAxesCombined,
  CircleDollarSign,
  Cloud,
  Copy,
  Download,
  FileText,
  Filter,
  KeyRound,
  Loader2,
  RotateCcw,
  RefreshCw,
  Trash2,
  Unlock,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/i18n";
import type { CatalogProvider } from "@/lib/model-catalog";
import { cn } from "@/lib/utils";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type {
  AdminUser,
  AuditEntry,
  AuditFilters,
  ModelOption,
  Role,
  TenantQuota,
  TenantUsage,
  UsageAggregate,
  UsageAnalytics,
  UsageFilters,
  UserStatus,
} from "./types";

export const AUDIT_LIMIT = 25;
export const ROLE_OPTIONS: Role[] = ["admin", "operator", "viewer"];
const AUDIT_ACTIONS = [
  "auth.register", "auth.login", "auth.logout", "auth.pair", "auth.fail", "auth.password",
  "audit.export", "usage.export", "usage.pricing_refresh", "config.update", "user.create", "user.update", "user.disable",
  "entitlement.update", "role.assign", "role.remove", "token.revoke", "session.create", "session.delete",
  "session.message.delete", "session.permission", "git.branch_switch", "fs_root.grant", "fs_root.revoke",
] as const;

export function UsersPanel({
  users,
  loading,
  error,
  locale,
  modelOptions,
  onCreate,
  onRoleChange,
  onEnable,
  onDisable,
  onResetPassword,
  onEditModels,
  onDelete,
}: {
  users: AdminUser[];
  loading: boolean;
  error: string | null;
  locale: string;
  modelOptions: ModelOption[];
  onCreate: () => void;
  onRoleChange: (user: AdminUser, role: Role) => void;
  onEnable: (user: AdminUser) => void;
  onDisable: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onEditModels: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
}) {
  const { t } = useLocale();
  return (
    <SettingsGroup icon={Users} title={t("admin.users.title")} description={t("admin.users.description")}>
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button onClick={onCreate} icon={UserPlus}>{t("admin.users.create")}</Button>
        </div>
        {error && <InlineError error={error} />}
        <div className="overflow-x-auto rounded-lg border border-ink/[0.06]">
          <table className="w-full min-w-[880px] border-collapse text-left text-[12.5px]">
            <thead className="bg-ink/[0.025] text-[11px] uppercase text-ink/38">
              <tr>
                <Th>{t("admin.users.name")}</Th>
                <Th>{t("admin.users.email")}</Th>
                <Th>{t("admin.users.role")}</Th>
                <Th>{t("admin.users.status")}</Th>
                <Th>{t("admin.users.lastLogin")}</Th>
                <Th>{t("admin.users.models")}</Th>
                <Th>{t("admin.common.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><Td colSpan={7}><LoadingRow label={t("admin.loading")} /></Td></tr>
              ) : users.length === 0 ? (
                <tr><Td colSpan={7}><EmptyState label={t("admin.users.empty")} /></Td></tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} data-testid={`admin-user-row-${user.email}`} className="border-t border-ink/[0.045]">
                    <Td>
                      <div className="max-w-[180px] truncate font-medium text-ink/78">{user.name || user.email}</div>
                    </Td>
                    <Td><span className="block max-w-[220px] truncate text-ink/52">{user.email}</span></Td>
                    <Td>
                      <select
                        aria-label={`${t("admin.users.role")} ${user.email}`}
                        value={user.role}
                        onChange={(event) => onRoleChange(user, event.target.value as Role)}
                        className="h-8 rounded-md border px-2 text-[12px] outline-none"
                        style={inputStyle}
                      >
                        {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{roleLabel(role, t)}</option>)}
                      </select>
                    </Td>
                    <Td><StatusChip label={statusLabel(user.status, t)} tone={user.status === "active" ? "success" : "muted"} /></Td>
                    <Td><span className="text-ink/52">{formatDate(user.last_login_at, locale, t("admin.common.never"))}</span></Td>
                    <Td><span className="text-ink/52">{modelGrantSummary(user.allowed_models, modelOptions, t)}</span></Td>
                    <Td>
                      <div className="flex flex-wrap gap-1.5">
                        {user.status === "active" ? (
                          <SmallButton onClick={() => onDisable(user)} icon={Ban}>{t("admin.users.disable")}</SmallButton>
                        ) : (
                          <SmallButton onClick={() => onEnable(user)} icon={Unlock}>{t("admin.users.enable")}</SmallButton>
                        )}
                        <SmallButton onClick={() => onResetPassword(user)} icon={RotateCcw}>{t("admin.users.resetPassword")}</SmallButton>
                        <SmallButton onClick={() => onEditModels(user)} icon={KeyRound}>{t("admin.users.editEntitlements")}</SmallButton>
                        <SmallButton onClick={() => onDelete(user)} icon={Trash2} danger>{t("admin.users.delete")}</SmallButton>
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </SettingsGroup>
  );
}

export function AuditPanel({
  users,
  filters,
  entries,
  total,
  offset,
  loading,
  error,
  locale,
  onFiltersChange,
  onApply,
  onOffsetChange,
}: {
  users: AdminUser[];
  filters: AuditFilters;
  entries: AuditEntry[];
  total: number;
  offset: number;
  loading: boolean;
  error: string | null;
  locale: string;
  onFiltersChange: (filters: AuditFilters) => void;
  onApply: () => void;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useLocale();
  return (
    <SettingsGroup icon={FileText} title={t("admin.audit.title")} description={t("admin.audit.description")}>
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-5">
          <Field label={t("admin.audit.eventType")}>
            <select value={filters.action} onChange={(event) => onFiltersChange({ ...filters, action: event.target.value })} className={inputClassName} style={inputStyle}>
              <option value="">{t("admin.audit.allEvents")}</option>
              {AUDIT_ACTIONS.map((action) => <option key={action} value={action}>{auditActionLabel(action, t)}</option>)}
            </select>
          </Field>
          <UserFilterSelect label={t("admin.audit.user")} users={users} value={filters.user_id} onChange={(value) => onFiltersChange({ ...filters, user_id: value })} />
          <Field label={t("admin.audit.outcome")}>
            <select
              value={filters.outcome}
              onChange={(event) => onFiltersChange({ ...filters, outcome: event.target.value as AuditFilters["outcome"] })}
              className={inputClassName}
              style={inputStyle}
            >
              <option value="">{t("admin.audit.allOutcomes")}</option>
              <option value="success">{t("admin.audit.success")}</option>
              <option value="failure">{t("admin.audit.failure")}</option>
            </select>
          </Field>
          <FilterInput label={t("admin.audit.from")} type="date" value={filters.from} onChange={(value) => onFiltersChange({ ...filters, from: value })} />
          <FilterInput label={t("admin.audit.to")} type="date" value={filters.to} onChange={(value) => onFiltersChange({ ...filters, to: value })} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12px] text-ink/40">{t("admin.audit.total", { count: total })}</div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onApply}>{t("admin.common.apply")}</Button>
            <a
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors"
              style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
              href={buildAuditExportPath(filters)}
            >
              <Download className="h-3.5 w-3.5" />
              {t("admin.audit.exportCsv")}
            </a>
          </div>
        </div>
        {error && <InlineError error={error} />}
        <div className="overflow-x-auto rounded-lg border border-ink/[0.06]">
          <table className="w-full min-w-[980px] border-collapse text-left text-[12.5px]">
            <thead className="bg-ink/[0.025] text-[11px] uppercase text-ink/38">
              <tr>
                <Th>{t("admin.audit.event")}</Th>
                <Th>{t("admin.audit.user")}</Th>
                <Th>{t("admin.audit.outcome")}</Th>
                <Th>{t("admin.audit.resource")}</Th>
                <Th>{t("admin.audit.details")}</Th>
                <Th>{t("admin.audit.date")}</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><Td colSpan={6}><LoadingRow label={t("admin.loading")} /></Td></tr>
              ) : entries.length === 0 ? (
                <tr><Td colSpan={6}><EmptyState label={t("admin.audit.empty")} /></Td></tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-ink/[0.045]">
                    <Td><div className="font-medium text-ink/76">{auditActionLabel(entry.action, t)}</div><div className="mt-0.5 font-mono text-[10.5px] text-ink/32">{entry.action}</div></Td>
                    <Td><div className="max-w-[210px] truncate text-ink/58" title={entry.user_email || entry.user_id || undefined}>{entry.user_email || entry.user_id || t("admin.audit.system")}</div></Td>
                    <Td><StatusChip label={entry.outcome === "failure" ? t("admin.audit.failure") : t("admin.audit.success")} tone={entry.outcome === "failure" ? "danger" : "success"} /></Td>
                    <Td><div className="text-ink/58">{auditResourceLabel(entry.resource_type, t)}</div>{entry.resource_id && <div className="mt-0.5 max-w-[220px] truncate font-mono text-[10.5px] text-ink/32" title={entry.resource_id}>{entry.resource_id}</div>}</Td>
                    <Td>{entry.details && Object.keys(entry.details).length > 0 ? <details className="max-w-[300px]"><summary className="cursor-pointer text-[11.5px] text-link/80">{t("admin.audit.viewDetails")}</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ink/[0.035] p-2 text-[10.5px] text-ink/52">{JSON.stringify(entry.details, null, 2)}</pre></details> : <span className="text-ink/28">—</span>}</Td>
                    <Td><span className="text-ink/52">{formatDate(entry.timestamp, locale, "-")}</span></Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - AUDIT_LIMIT))}>{t("admin.common.previous")}</Button>
          <Button variant="secondary" disabled={offset + AUDIT_LIMIT >= total} onClick={() => onOffsetChange(offset + AUDIT_LIMIT)}>{t("admin.common.next")}</Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

function auditActionLabel(action: string, t: ReturnType<typeof useLocale>["t"]): string {
  const key = `admin.audit.actionLabel.${action}`;
  const translated = t(key);
  return translated === key ? action.replaceAll(".", " · ") : translated;
}

function auditResourceLabel(resource: string, t: ReturnType<typeof useLocale>["t"]): string {
  const key = `admin.audit.resourceLabel.${resource}`;
  const translated = t(key);
  return translated === key ? resource.replaceAll("_", " ") : translated;
}

export function UsagePanel({
  users,
  providers,
  dailyUsage,
  monthlyUsage,
  analytics,
  filters,
  appliedFilters,
  offset,
  quota,
  quotaForm,
  modelOptions,
  loading,
  reconciling,
  error,
  notice,
  locale,
  onFiltersChange,
  onApplyFilters,
  onOffsetChange,
  onQuotaFormChange,
  onSaveQuota,
  onReconcile,
}: {
  users: AdminUser[];
  providers: CatalogProvider[];
  dailyUsage: TenantUsage | null;
  monthlyUsage: TenantUsage | null;
  analytics: UsageAnalytics | null;
  filters: UsageFilters;
  appliedFilters: UsageFilters;
  offset: number;
  quota: TenantQuota | null;
  quotaForm: { daily: string; monthly: string; models: Set<string> };
  modelOptions: ModelOption[];
  loading: boolean;
  reconciling: boolean;
  error: string | null;
  notice: string | null;
  locale: string;
  onFiltersChange: (filters: UsageFilters) => void;
  onApplyFilters: () => void;
  onOffsetChange: (offset: number) => void;
  onQuotaFormChange: (form: { daily: string; monthly: string; models: Set<string> }) => void;
  onSaveQuota: () => void;
  onReconcile: () => void;
}) {
  const { t } = useLocale();
  const summary = analytics?.summary;

  return (
    <div className="space-y-4">
      <SettingsGroup icon={BarChart3} title={t("admin.usage.title")} description={t("admin.usage.description")}>
        <div className="space-y-3">
          {loading && <LoadingRow label={t("admin.loading")} />}
          {error && <InlineError error={error} />}
          {notice && <InlineNotice message={notice} />}
          <div className="flex justify-end"><Button variant="secondary" icon={RefreshCw} disabled={reconciling} onClick={onReconcile}>{reconciling ? t("admin.usage.reconciling") : t("admin.usage.reconcile")}</Button></div>
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
            <SummaryTile icon={Bot} label={t("admin.usage.observedCalls")} value={formatNumber(summary?.calls ?? 0)} />
            <SummaryTile icon={BarChart3} label={t("admin.usage.totalTokens")} value={formatNumber((summary?.input_tokens ?? 0) + (summary?.output_tokens ?? 0))} />
            <SummaryTile icon={Cloud} label={t("admin.usage.cacheTokens")} value={`${formatNumber(summary?.cache_read_tokens ?? 0)} / ${(summary?.cache_write_reported_calls ?? 0) > 0 ? formatNumber(summary?.cache_write_tokens ?? 0) : "—"}`} />
            <SummaryTile icon={ChartNoAxesCombined} label={t("admin.usage.cacheHitRate")} value={formatPercent(summary?.cache_hit_rate)} />
            <SummaryTile icon={CircleDollarSign} label={t("admin.usage.estimatedCost")} value={(summary?.priced_calls ?? 0) > 0 ? formatUsd(summary?.cost_usd ?? 0) : "—"} />
            <SummaryTile icon={AlertCircle} label={t("admin.usage.failedCalls")} value={formatNumber(summary?.failed_calls ?? 0)} />
          </div>
          {summary && <details className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] px-3 py-2 text-[11.5px] text-ink/52">
            <summary className="cursor-pointer list-none font-medium text-ink/58">{t("admin.usage.calculationDetails")}</summary>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink/38">{t("admin.usage.estimatedCostHelp")}</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              <CoverageItem label={t("admin.usage.pricingCoverage")} value={`${formatNumber(summary.priced_calls)} / ${formatNumber(summary.calls)}`} />
              <CoverageItem label={t("admin.usage.exactEstimate")} value={t("admin.usage.costAndCalls", { cost: formatUsd(summary.exact_cost_usd), count: formatNumber(summary.exact_priced_calls) })} />
              <CoverageItem label={t("admin.usage.upperBoundEstimate")} value={t("admin.usage.costAndCalls", { cost: formatUsd(summary.upper_bound_cost_usd), count: formatNumber(summary.upper_bound_calls) })} warning={summary.upper_bound_calls > 0} />
              <CoverageItem label={t("admin.usage.cacheCoverage")} value={`${formatNumber(summary.cache_reported_calls)} / ${formatNumber(summary.calls)}`} />
              <CoverageItem label={t("admin.usage.unattributedCalls")} value={formatNumber(summary.unattributed_calls)} warning={summary.unattributed_calls > 0} />
            </div>
          </details>}
          <QuotaBar label={t("admin.usage.dailyLimit")} used={dailyUsage?.total_tokens ?? 0} limit={quota?.daily_token_limit ?? 0} />
          <QuotaBar label={t("admin.usage.monthlyLimit")} used={monthlyUsage?.total_tokens ?? 0} limit={quota?.monthly_token_limit ?? 0} />
          <details className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 select-none text-[12px] font-medium text-ink/65"><Filter className="h-3.5 w-3.5 text-selection/75" />{t("admin.usage.filters")}</summary>
            <div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
              <UserFilterSelect label={t("admin.usage.user")} users={users} includeUnattributed value={filters.user_id} onChange={(value) => onFiltersChange({ ...filters, user_id: value })} />
              <UsageProviderSelect label={t("admin.usage.provider")} providers={providers} observed={analytics?.by_model ?? []} value={filters.provider} onChange={(value) => onFiltersChange({ ...filters, provider: value, model: "" })} />
              <UsageModelSelect label={t("admin.usage.model")} providers={providers} observed={analytics?.by_model ?? []} provider={filters.provider} value={filters.model} onChange={(value) => onFiltersChange({ ...filters, model: value })} />
              <Field label={t("admin.usage.outcome")}>
                <select value={filters.outcome} onChange={(event) => onFiltersChange({ ...filters, outcome: event.target.value as UsageFilters["outcome"] })} className={inputClassName} style={inputStyle}>
                  <option value="">{t("admin.usage.allOutcomes")}</option><option value="success">{t("admin.audit.success")}</option><option value="failure">{t("admin.audit.failure")}</option><option value="partial">{t("admin.usage.partial")}</option>
                </select>
              </Field>
              <FilterInput label={t("admin.audit.from")} type="date" value={filters.from} onChange={(value) => onFiltersChange({ ...filters, from: value })} />
              <FilterInput label={t("admin.audit.to")} type="date" value={filters.to} onChange={(value) => onFiltersChange({ ...filters, to: value })} />
            </div>
            <div className="mt-3 flex justify-end gap-2"><a href={buildUsageExportPath(appliedFilters)} className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}><Download className="h-3.5 w-3.5" />{t("admin.audit.exportCsv")}</a><Button variant="secondary" onClick={onApplyFilters}>{t("admin.common.apply")}</Button></div>
          </details>
          <UsageDashboardCharts analytics={analytics} />
          <UsageBreakdownTable title={t("admin.usage.byUser")} rows={(analytics?.by_user ?? []).map((row) => ({ key: row.user_id ?? "unknown", label: row.user_email || row.user_id || t("admin.usage.unknown"), metrics: row }))} t={t} />
          <UsageBreakdownTable title={t("admin.usage.byModel")} rows={(analytics?.by_model ?? []).map((row) => ({ key: `${row.provider}:${row.model}`, label: [row.provider, row.model].filter(Boolean).join(" / ") || t("admin.usage.unknown"), metrics: row }))} t={t} />
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-ink/65">{t("admin.usage.dailyTrend")}</h3>
            <div className="overflow-x-auto rounded-lg border border-ink/[0.06]">
              <table className="w-full min-w-[680px] text-left text-[12px]"><thead className="bg-ink/[0.025] text-[10.5px] uppercase text-ink/38"><tr><Th>{t("admin.audit.date")}</Th><UsageMetricHeaders t={t} /></tr></thead><tbody>
                {(analytics?.by_day ?? []).map((row) => <tr key={row.day} className="border-t border-ink/[0.045]"><Td>{row.day}</Td><UsageMetricCells metrics={row} /></tr>)}
              </tbody></table>
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-ink/65">{t("admin.usage.calls")}</h3>
            <div className="overflow-x-auto rounded-lg border border-ink/[0.06]">
              <table className="w-full min-w-[1080px] text-left text-[12px]"><thead className="bg-ink/[0.025] text-[10.5px] uppercase text-ink/38"><tr>
                <Th>{t("admin.audit.date")}</Th><Th>{t("admin.usage.user")}</Th><Th>{t("admin.usage.model")}</Th><Th>{t("admin.usage.inputOutput")}</Th><Th>{t("admin.usage.cacheTokens")}</Th><Th>{t("admin.usage.calculatedCost")}</Th><Th>{t("admin.usage.outcome")}</Th><Th>{t("admin.usage.latency")}</Th>
              </tr></thead><tbody>
                {(analytics?.rows ?? []).map((row) => <tr key={row.id} className="border-t border-ink/[0.045]">
                  <Td>{formatDate(row.created_at, locale, "-")}</Td><Td>{row.user_email || row.user_id || t("admin.usage.unknown")}</Td><Td>{[row.provider, row.model].filter(Boolean).join(" / ") || t("admin.usage.unknown")}</Td><Td>{formatNumber(row.input_tokens)} / {formatNumber(row.output_tokens)}</Td><Td>{row.cache_read_tokens == null && row.cache_write_tokens == null ? t("admin.usage.notCaptured") : `${formatNumber(row.cache_read_tokens ?? 0)} / ${formatNumber(row.cache_write_tokens ?? 0)}`}</Td><Td><UsageCostCell row={row} /></Td><Td>{row.usage_status === "legacy_provider_reported" ? <StatusChip label={t("admin.usage.observedUsage")} tone="muted" /> : row.usage_status === "unavailable" ? <StatusChip label={t("admin.usage.usageUnavailable")} tone="muted" /> : <StatusChip label={row.outcome} tone={row.outcome === "success" ? "success" : "danger"} />}</Td><Td>{row.usage_status !== "provider_reported" || row.duration_ms <= 0 ? "—" : formatDuration(row.duration_ms)}</Td>
                </tr>)}
              </tbody></table>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11.5px] text-ink/40"><span>{t("admin.usage.callCount", { count: analytics?.total ?? 0 })}</span><div className="flex gap-2"><Button variant="secondary" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - 50))}>{t("admin.common.previous")}</Button><Button variant="secondary" disabled={offset + 50 >= (analytics?.total ?? 0)} onClick={() => onOffsetChange(offset + 50)}>{t("admin.common.next")}</Button></div></div>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup icon={KeyRound} title={t("admin.usage.quotaTitle")} description={t("admin.usage.quotaDescription")}>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("admin.usage.dailyLimit")}>
              <input
                type="number"
                min={0}
                value={quotaForm.daily}
                onChange={(event) => onQuotaFormChange({ ...quotaForm, daily: event.target.value })}
                className={inputClassName}
                style={inputStyle}
              />
            </Field>
            <Field label={t("admin.usage.monthlyLimit")}>
              <input
                type="number"
                min={0}
                value={quotaForm.monthly}
                onChange={(event) => onQuotaFormChange({ ...quotaForm, monthly: event.target.value })}
                className={inputClassName}
                style={inputStyle}
              />
            </Field>
          </div>
          <div>
            <span className="mb-1 block text-[11px] text-ink/38">{t("admin.usage.allowedModels")}</span>
            <ModelCheckboxList
              options={modelOptions}
              selected={quotaForm.models}
              emptyLabel={t("admin.usage.allModelsAllowed")}
              onChange={(models) => onQuotaFormChange({ ...quotaForm, models })}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={onSaveQuota} icon={Check}>{t("admin.usage.saveQuota")}</Button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}

function UsageBreakdownTable({ title, rows, t }: { title: string; rows: Array<{ key: string; label: string; metrics: UsageAggregate }>; t: ReturnType<typeof useLocale>["t"] }) {
  // The first column header carries the grouping label — no separate <h3>
  // repeating the identical string above the table (DESIGN.md: no redundant labeling).
  return <div><div className="overflow-x-auto rounded-lg border border-ink/[0.06]"><table className="w-full min-w-[760px] text-left text-[12px]"><thead className="bg-ink/[0.025] text-[10.5px] uppercase text-ink/38"><tr><Th>{title}</Th><UsageMetricHeaders t={t} /></tr></thead><tbody>{rows.map((row) => <tr key={row.key} className="border-t border-ink/[0.045]"><Td>{row.label}</Td><UsageMetricCells metrics={row.metrics} /></tr>)}</tbody></table></div></div>;
}

function UsageMetricHeaders({ t }: { t: ReturnType<typeof useLocale>["t"] }) {
  return <><Th>{t("admin.usage.llmCalls")}</Th><Th>{t("admin.usage.totalTokens")}</Th><Th>{t("admin.usage.cacheHitRate")}</Th><Th>{t("admin.usage.calculatedCost")}</Th><Th>{t("admin.usage.failedCalls")}</Th><Th>{t("admin.usage.latency")}</Th></>;
}

function UsageMetricCells({ metrics }: { metrics: UsageAggregate }) {
  return <><Td>{formatNumber(metrics.calls)}</Td><Td>{formatNumber(metrics.input_tokens + metrics.output_tokens)}</Td><Td>{formatPercent(metrics.cache_hit_rate)}</Td><Td>{metrics.priced_calls > 0 ? formatUsd(metrics.cost_usd) : "—"}</Td><Td>{formatNumber(metrics.failed_calls)}</Td><Td>{metrics.measured_latency_calls > 0 ? formatDuration(metrics.average_latency_ms) : "—"}</Td></>;
}

function CoverageItem({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div><div className="text-[10.5px] text-ink/34">{label}</div><div className={cn("mt-0.5 font-medium", warning ? "text-amber-400/85" : "text-ink/70")}>{value}</div></div>;
}

function UsageCostCell({ row }: { row: UsageAnalytics["rows"][number] }) {
  const { t } = useLocale();
  if (row.pricing_source === "unknown") {
    return <div><span className="text-ink/32">—</span><div className="text-[10px] text-ink/28">{t("admin.usage.priceUnknown")}</div></div>;
  }
  const label = row.pricing_source === "catalog_upper_bound"
    ? t("admin.usage.catalogUpperBound")
    : row.pricing_source === "provider_reported" || row.pricing_source === "provider_reconciled"
      ? t("admin.usage.providerReported")
      : t("admin.usage.catalogCalculated");
  return <div><span>{formatUsd(row.cost_usd)}</span><div className="text-[10px] text-ink/30">{label}</div></div>;
}

function SettingsGroup({ icon: Icon, title, description, children }: { icon?: LucideIcon; title: string; description?: string; children?: ReactNode }) {
  return (
    <section data-testid="admin-section-group" className="min-w-0">
      <div className="flex items-start gap-2.5 pb-3">
        {Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink/45" />}
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-ink/75">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] leading-5 text-ink/38">{description}</p>}
        </div>
      </div>
      <div>{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] text-ink/38">{label}</span>
      {children}
    </label>
  );
}

function FilterInput({ label, type = "text", value, onChange }: { label: string; type?: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} className={inputClassName} style={inputStyle} />
    </Field>
  );
}

function UserFilterSelect({ label, users, value, onChange, includeUnattributed = false }: { label: string; users: AdminUser[]; value: string; onChange: (value: string) => void; includeUnattributed?: boolean }) {
  const { t } = useLocale();
  return <Field label={label}><select value={value} onChange={(event) => onChange(event.target.value)} className={inputClassName} style={inputStyle}>
    <option value="">{t("admin.filters.allUsers")}</option>
    {includeUnattributed && <option value="__unattributed__">{t("admin.filters.unattributed")}</option>}
    {users.map((user) => <option key={user.id} value={user.id}>{user.name ? `${user.name} (${user.email})` : user.email}</option>)}
  </select></Field>;
}

function UsageProviderSelect({ label, providers, observed, value, onChange }: { label: string; providers: CatalogProvider[]; observed: UsageAnalytics["by_model"]; value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const configured = providers.map((provider) => ({ value: provider.id, label: provider.name })).filter((provider) => provider.value);
  const hasUnattributed = value === '__unattributed__' || observed.some((row) => !row.provider);
  const values = [...new Map(configured.map((provider) => [provider.value, provider])).values()];
  return <Field label={label}><select value={value} onChange={(event) => onChange(event.target.value)} className={inputClassName} style={inputStyle}><option value="">{t("admin.filters.allProviders")}</option>{hasUnattributed && <option value="__unattributed__">{t("admin.filters.unattributed")}</option>}{values.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></Field>;
}

function UsageModelSelect({ label, providers, observed, provider, value, onChange }: { label: string; providers: CatalogProvider[]; observed: UsageAnalytics["by_model"]; provider: string; value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const configured = providers.filter((entry) => !provider || entry.id === provider).flatMap((entry) => entry.models ?? []).map((model) => model.id).filter(Boolean);
  const observedModels = observed.filter((row) => !provider || (provider === '__unattributed__' ? !row.provider : row.provider === provider)).map((row) => row.model).filter((model): model is string => Boolean(model));
  const values = [...new Set([...configured, ...observedModels])].sort((a, b) => a.localeCompare(b));
  return <Field label={label}><select value={value} onChange={(event) => onChange(event.target.value)} className={inputClassName} style={inputStyle}><option value="">{t("admin.filters.allModels")}</option>{values.map((model) => <option key={model} value={model}>{model}</option>)}</select></Field>;
}

const DASHBOARD_COLORS = ["var(--action)", "var(--activity)", "var(--warning)", "var(--selection)", "var(--link)", "var(--danger)"];

function UsageDashboardCharts({ analytics }: { analytics: UsageAnalytics | null }) {
  const { t } = useLocale();
  const daily = (analytics?.by_day ?? []).map((row) => ({
    day: row.day,
    tokens: row.input_tokens + row.output_tokens,
    cost: row.cost_usd,
  }));
  const models = (analytics?.by_model ?? []).slice(0, 6).map((row) => ({
    name: [row.provider, row.model].filter(Boolean).join(" / ") || t("admin.filters.unattributed"),
    calls: row.calls,
    failures: row.failed_calls,
    cost: row.cost_usd,
  }));

  if (daily.length === 0 && models.length === 0) {
    return <DashboardEmptyState label={t("admin.usage.noUsage")} />;
  }

  return <div className="grid gap-3 xl:grid-cols-2">
    <DashboardChartCard title={t("admin.usage.tokenTrend")} icon={ChartNoAxesCombined} className="xl:col-span-2">
      {daily.length === 0 ? <DashboardEmptyState label={t("admin.usage.noUsage")} compact /> : <div className="h-56"><ResponsiveContainer width="100%" height="100%"><AreaChart data={daily} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs><linearGradient id="usage-token-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--activity)" stopOpacity={0.34} /><stop offset="95%" stopColor="var(--activity)" stopOpacity={0.02} /></linearGradient></defs>
        <CartesianGrid vertical={false} stroke="rgb(255 255 255 / 0.08)" />
        <XAxis dataKey="day" tickFormatter={(value) => String(value).slice(5)} tick={{ fill: "rgb(255 255 255 / 0.46)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={(value) => formatCompactNumber(Number(value))} tick={{ fill: "rgb(255 255 255 / 0.46)", fontSize: 11 }} axisLine={false} tickLine={false} width={42} />
        <Tooltip formatter={(value: number) => formatNumber(value)} labelFormatter={(label) => String(label)} contentStyle={chartTooltipStyle} />
        <Area type="monotone" dataKey="tokens" name={t("admin.usage.totalTokens")} stroke="var(--activity)" strokeWidth={2} fill="url(#usage-token-fill)" />
      </AreaChart></ResponsiveContainer></div>}
    </DashboardChartCard>
    <DashboardChartCard title={t("admin.usage.costByModelChart")} icon={CircleDollarSign}>
      {models.length === 0 ? <DashboardEmptyState label={t("admin.usage.noUsage")} compact /> : <div className="flex h-56 items-center"><div className="h-full w-[48%] min-w-0"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={models} dataKey="cost" nameKey="name" innerRadius={52} outerRadius={82} paddingAngle={3}>{models.map((model, index) => <Cell key={model.name} fill={DASHBOARD_COLORS[index % DASHBOARD_COLORS.length]} />)}</Pie><Tooltip formatter={(value: number) => formatUsd(value)} contentStyle={chartTooltipStyle} /></PieChart></ResponsiveContainer></div><div className="min-w-0 flex-1 space-y-1.5">{models.map((model, index) => <div key={model.name} className="flex items-center gap-2 text-[11px] text-ink/58"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: DASHBOARD_COLORS[index % DASHBOARD_COLORS.length] }} /><span className="truncate" title={model.name}>{model.name}</span><span className="ml-auto text-ink/76">{formatUsd(model.cost)}</span></div>)}</div></div>}
    </DashboardChartCard>
    <DashboardChartCard title={t("admin.usage.modelReliability")} icon={Bot}>
      {models.length === 0 ? <DashboardEmptyState label={t("admin.usage.noUsage")} compact /> : <div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={models} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="rgb(255 255 255 / 0.08)" />
        <XAxis type="number" tick={{ fill: "rgb(255 255 255 / 0.46)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" width={125} tick={{ fill: "rgb(255 255 255 / 0.58)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={chartTooltipStyle} /><Legend wrapperStyle={{ fontSize: 11, color: "rgb(255 255 255 / 0.62)" }} />
        <Bar dataKey="calls" name={t("admin.usage.llmCalls")} fill="var(--activity)" radius={[0, 3, 3, 0]} />
        <Bar dataKey="failures" name={t("admin.usage.failedCalls")} fill="#fb7185" radius={[0, 3, 3, 0]} />
      </BarChart></ResponsiveContainer></div>}
    </DashboardChartCard>
  </div>;
}

const chartTooltipStyle = { background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)", borderRadius: 6, color: "var(--text-primary)", fontSize: 12 };

function DashboardChartCard({ title, icon: Icon, children, className }: { title: string; icon: LucideIcon; children: ReactNode; className?: string }) {
  return <section className={cn("rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3", className)}><h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-ink/68"><Icon className="h-3.5 w-3.5 text-selection/80" />{title}</h3>{children}</section>;
}

function DashboardEmptyState({ label, compact = false }: { label: string; compact?: boolean }) {
  // Quiet line, not a dashed billboard box (DESIGN.md: no billboard empty states).
  return <p className={cn("text-center text-[12.5px] text-ink/38", compact ? "py-12" : "py-6")}>{label}</p>;
}

export function Modal({ title, description, children, onClose }: { title: string; description?: string; children: ReactNode; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6">
      <section className="max-h-[calc(100vh-48px)] w-full max-w-[560px] overflow-y-auto rounded-lg border border-ink/[0.10] bg-elevated p-4 shadow-[0_24px_70px_-28px_rgba(0,0,0,0.72)]">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold text-ink/82">{title}</h2>
            {description && <p className="mt-1 text-[12.5px] leading-5 text-ink/45">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-[12px] text-ink/45 hover:bg-ink/[0.05] hover:text-ink/72">
            {t("admin.common.close")}
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function Button({ children, icon: Icon, variant = "primary", disabled = false, onClick }: { children: ReactNode; icon?: LucideIcon; variant?: "primary" | "secondary" | "danger"; disabled?: boolean; onClick?: () => void }) {
  const style = variant === "primary"
    ? { background: "var(--action)", color: "var(--action-fg)" }
    : variant === "danger"
      ? { background: "rgb(var(--danger-rgb, 220 38 38) / 0.10)", border: "1px solid rgb(var(--danger-rgb, 220 38 38) / 0.20)", color: "var(--danger)" }
      : { background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
      style={style}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

function SmallButton({ children, icon: Icon, danger = false, onClick }: { children: ReactNode; icon: LucideIcon; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] transition-colors", danger ? "text-danger" : "text-ink/58")}
      style={{ background: "var(--surface-input)", borderColor: "rgb(var(--ink-rgb) / 0.07)" }}
    >
      <Icon className="h-3 w-3" />
      {children}
    </button>
  );
}

export function SecretField({ label, value }: { label: string; value: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mb-4 rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3">
      <div className="mb-1 text-[11px] text-ink/38">{label}</div>
      <div className="flex gap-2">
        <input readOnly value={value} className="h-9 min-w-0 flex-1 rounded-md border px-2.5 font-mono text-[12.5px] outline-none" style={inputStyle} />
        <Button variant="secondary" onClick={() => void copy()} icon={Copy}>{copied ? t("admin.common.copied") : t("admin.common.copy")}</Button>
      </div>
    </div>
  );
}

export function ModelCheckboxList({ options, selected, emptyLabel, onChange }: { options: ModelOption[]; selected: Set<string>; emptyLabel: string; onChange: (selected: Set<string>) => void }) {
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="max-h-[280px] overflow-y-auto rounded-lg border border-ink/[0.06] p-2">
      {selected.size === 0 && <div className="mb-2 rounded-md bg-ink/[0.025] px-2 py-1.5 text-[12px] text-ink/42">{emptyLabel}</div>}
      <div className="grid gap-1 sm:grid-cols-2">
        {options.map((option) => (
          <label key={option.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink/62 hover:bg-ink/[0.035]">
            <input type="checkbox" checked={selected.has(option.id)} onChange={() => toggle(option.id)} className="h-3.5 w-3.5 accent-[var(--action)]" />
            <span className="min-w-0 truncate" title={option.label}>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ label, tone }: { label: string; tone: "success" | "danger" | "muted" }) {
  const color = tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : "rgb(var(--ink-rgb) / 0.34)";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ink/[0.07] px-2 py-0.5 text-[11.5px] text-ink/58">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function SummaryTile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-ink/38"><Icon className="h-3.5 w-3.5 text-selection/75" />{label}</div>
      <div className="mt-1 truncate text-[18px] font-semibold text-ink/82">{value}</div>
    </div>
  );
}

function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const { t } = useLocale();
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
        <span className="text-ink/58">{label}</span>
        <span className="text-ink/38">{limit > 0 ? t("admin.usage.usageOfLimit", { used: formatNumber(used), limit: formatNumber(limit) }) : t("admin.usage.unlimited")}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink/[0.06]">
        <div className="h-full rounded-full bg-activity/70" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Breakdown({ title, values, emptyLabel }: { title: string; values: Record<string, number>; emptyLabel: string }) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(...entries.map(([, value]) => value), 0);
  return (
    <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3">
      <h3 className="text-[12.5px] font-medium text-ink/70">{title}</h3>
      {entries.length === 0 ? (
        <div className="mt-2 text-[12px] text-ink/38">{emptyLabel}</div>
      ) : (
        <div className="mt-2 space-y-2">
          {entries.map(([key, value]) => (
            <div key={key}>
              <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
                <span className="min-w-0 truncate text-ink/52">{key}</span>
                <span className="shrink-0 text-ink/38">{formatUsd(value)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
                <div className="h-full rounded-full bg-activity/65" style={{ width: `${max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InlineError({ error }: { error: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-2 text-[12px] text-warning">
      <AlertCircle className="h-3.5 w-3.5" />
      {error}
    </div>
  );
}

function InlineNotice({ message }: { message: string }) {
  return <div role="status" className="rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-[12px] text-emerald-300">{message}</div>;
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-[12.5px] text-ink/40">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {label}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="py-6 text-center text-[12.5px] text-ink/35">{label}</div>;
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children, colSpan }: { children: ReactNode; colSpan?: number }) {
  return <td colSpan={colSpan} className="px-3 py-2.5 align-middle">{children}</td>;
}

export const inputClassName = "h-9 w-full rounded-md border px-2.5 text-[12.5px] outline-none";
export const inputStyle = { background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" };

export function buildModelOptions(providers: CatalogProvider[]): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      options.push({ id: model.id, label: `${provider.name} / ${model.name || model.id}` });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

export function buildAuditPath(filters: AuditFilters, offset: number): string {
  const params = new URLSearchParams();
  appendAuditFilters(params, filters);
  params.set("limit", String(AUDIT_LIMIT));
  params.set("offset", String(offset));
  return `/api/audit?${params.toString()}`;
}

export function buildUsageExportPath(filters: UsageFilters): string {
  const params = new URLSearchParams();
  if (filters.user_id.trim()) params.set("user_id", filters.user_id.trim());
  if (filters.provider.trim()) params.set("provider", filters.provider.trim());
  if (filters.model.trim()) params.set("model", filters.model.trim());
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return `/api/admin/usage/export?${params.toString()}`;
}

function buildAuditExportPath(filters: AuditFilters): string {
  const params = new URLSearchParams();
  params.set("format", "csv");
  appendAuditFilters(params, filters);
  params.set("limit", "10000");
  return `/api/audit/export?${params.toString()}`;
}

function appendAuditFilters(params: URLSearchParams, filters: AuditFilters): void {
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.user_id.trim()) params.set("user_id", filters.user_id.trim());
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
}

export function roleLabel(role: Role, t: ReturnType<typeof useLocale>["t"]): string {
  switch (role) {
    case "admin": return t("admin.role.admin");
    case "operator": return t("admin.role.operator");
    case "viewer": return t("admin.role.viewer");
  }
}

function statusLabel(status: UserStatus, t: ReturnType<typeof useLocale>["t"]): string {
  return status === "active" ? t("admin.status.active") : t("admin.status.disabled");
}

function modelGrantSummary(models: string[] | null, options: ModelOption[], t: ReturnType<typeof useLocale>["t"]): string {
  if (!models || models.length === 0) return t("admin.users.inheritTenant");
  if (models.length === 1) return options.find((option) => option.id === models[0])?.label ?? models[0];
  return t("admin.users.modelCount", { count: models.length });
}

function formatDate(value: string | null | undefined, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "-";
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function numericLimit(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function generateOneTimePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(14);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const token = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `Mozi-${token}1a`;
}
