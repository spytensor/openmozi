import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Check,
  FileText,
  Loader2,
  RotateCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { useApi } from "@/hooks/useApi";
import type { AuthUser } from "@/hooks/useAuth";
import { useLocale } from "@/i18n";
import { mergeRuntimeProviders, type CatalogProvider } from "@/lib/model-catalog";
import {
  AuditPanel,
  Button,
  Field,
  InlineError,
  Modal,
  ModelCheckboxList,
  ROLE_OPTIONS,
  SecretField,
  UsagePanel,
  UsersPanel,
  buildAuditPath,
  buildModelOptions,
  generateOneTimePassword,
  inputClassName,
  inputStyle,
  numericLimit,
  roleLabel,
} from "./AdminSections";
import type {
  AdminSection,
  AdminUser,
  AuditEntry,
  AuditFilters,
  AuditResponse,
  CreateUserResponse,
  PatchUserResponse,
  ProvidersResponse,
  QuotaResponse,
  Role,
  TenantQuota,
  TenantUsage,
  UsageAnalytics,
  UsageFilters,
  UsersResponse,
} from "./types";

interface AdminViewProps {
  currentUser: AuthUser | null;
  section?: AdminSection;
}

export default function AdminView({ currentUser, section }: AdminViewProps) {
  const { locale, t } = useLocale();
  const { get, post, put, patch, del } = useApi();
  const [internalCategory, setInternalCategory] = useState<AdminSection>("users");
  const category = section ?? internalCategory;

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", name: "", role: "viewer" as Role, password: "" });
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [entitlementUser, setEntitlementUser] = useState<AdminUser | null>(null);
  const [modelDraft, setModelDraft] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<null | {
    title: string;
    body: string;
    actionLabel: string;
    onConfirm: () => Promise<void>;
  }>(null);

  const [auditFilters, setAuditFilters] = useState<AuditFilters>({ action: "", user_id: "", outcome: "", from: "", to: "" });
  const [appliedAuditFilters, setAppliedAuditFilters] = useState<AuditFilters>(auditFilters);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [dailyUsage, setDailyUsage] = useState<TenantUsage | null>(null);
  const [monthlyUsage, setMonthlyUsage] = useState<TenantUsage | null>(null);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const thirtyDaysAgo = useMemo(() => new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10), []);
  const [usageFilters, setUsageFilters] = useState<UsageFilters>({ user_id: "", provider: "", model: "", outcome: "", from: thirtyDaysAgo, to: today });
  const [appliedUsageFilters, setAppliedUsageFilters] = useState<UsageFilters>(usageFilters);
  const [usageOffset, setUsageOffset] = useState(0);
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null);
  const [quota, setQuota] = useState<TenantQuota | null>(null);
  const [quotaForm, setQuotaForm] = useState({ daily: "0", monthly: "0", models: new Set<string>() });
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageReconciling, setUsageReconciling] = useState(false);
  const [usageNotice, setUsageNotice] = useState<string | null>(null);

  const isAdmin = currentUser?.role === "admin";
  const tenantId = currentUser?.tenant_id || "default";

  const modelOptions = useMemo(() => buildModelOptions(providers), [providers]);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    const { data, error } = await get<ProvidersResponse>("/api/providers");
    setProvidersLoading(false);
    if (error) {
      setProviders([]);
      setProvidersError(t("models.loadError"));
      return;
    }
    setProviders(mergeRuntimeProviders(data?.providers));
  }, [get, t]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    const { data, error } = await get<UsersResponse>("/api/users?limit=100&offset=0");
    setUsersLoading(false);
    if (error) {
      setUsersError(error);
      return;
    }
    setUsers(data?.users ?? []);
  }, [get]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    const { data, error } = await get<AuditResponse>(buildAuditPath(appliedAuditFilters, auditOffset));
    setAuditLoading(false);
    if (error) {
      setAuditError(error);
      return;
    }
    setAuditEntries(data?.entries ?? []);
    setAuditTotal(data?.total ?? 0);
  }, [appliedAuditFilters, auditOffset, get]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    const params = new URLSearchParams();
    if (appliedUsageFilters.user_id.trim()) params.set("user_id", appliedUsageFilters.user_id.trim());
    if (appliedUsageFilters.provider.trim()) params.set("provider", appliedUsageFilters.provider.trim());
    if (appliedUsageFilters.model.trim()) params.set("model", appliedUsageFilters.model.trim());
    if (appliedUsageFilters.outcome) params.set("outcome", appliedUsageFilters.outcome);
    if (appliedUsageFilters.from) params.set("from", appliedUsageFilters.from);
    if (appliedUsageFilters.to) params.set("to", appliedUsageFilters.to);
    params.set("limit", "50");
    params.set("offset", String(usageOffset));
    const [daily, monthly, analyticsRes, quotaRes] = await Promise.all([
      get<TenantUsage>("/api/tenant/usage?period=daily"),
      get<TenantUsage>("/api/tenant/usage?period=monthly"),
      get<UsageAnalytics>(`/api/admin/usage?${params.toString()}`),
      get<TenantQuota>("/api/tenant/quotas"),
    ]);
    setUsageLoading(false);
    const error = daily.error || monthly.error || analyticsRes.error || quotaRes.error;
    if (error) {
      setUsageError(error);
      return;
    }
    setDailyUsage(daily.data);
    setMonthlyUsage(monthly.data);
    setAnalytics(analyticsRes.data);
    if (quotaRes.data) {
      setQuota(quotaRes.data);
      setQuotaForm({
        daily: String(quotaRes.data.daily_token_limit ?? 0),
        monthly: String(quotaRes.data.monthly_token_limit ?? 0),
        models: new Set(quotaRes.data.allowed_models ?? []),
      });
    }
  }, [appliedUsageFilters, get, usageOffset]);

  const applyUsageFilters = () => {
    setUsageOffset(0);
    setAppliedUsageFilters(usageFilters);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadProviders();
    void loadUsers();
  }, [isAdmin, loadProviders, loadUsers]);

  useEffect(() => {
    if (!isAdmin || category !== "audit") return;
    void loadAudit();
  }, [category, isAdmin, loadAudit]);

  useEffect(() => {
    if (!isAdmin || category !== "usage") return;
    void loadUsage();
  }, [category, isAdmin, loadUsage]);

  const updateUserInList = (user: AdminUser) => {
    setUsers((current) => current.map((entry) => (entry.id === user.id ? user : entry)));
  };

  const patchUser = async (id: string, payload: Record<string, unknown>): Promise<AdminUser | null> => {
    setUsersError(null);
    const { data, error } = await patch<PatchUserResponse>(`/api/users/${id}`, payload);
    if (error || !data?.user) {
      setUsersError(error ?? t("common.unavailable"));
      return null;
    }
    updateUserInList(data.user);
    return data.user;
  };

  const submitCreate = async () => {
    const email = createForm.email.trim();
    const name = createForm.name.trim();
    if (!email.includes("@")) {
      setCreateError(t("admin.users.validation.email"));
      return;
    }
    if (!name) {
      setCreateError(t("admin.users.validation.name"));
      return;
    }
    setCreateError(null);
    const payload = {
      email,
      name,
      role: createForm.role,
      ...(createForm.password.trim() ? { password: createForm.password.trim() } : {}),
    };
    const { data, error } = await post<CreateUserResponse>("/api/users", payload);
    if (error || !data?.user) {
      setCreateError(error ?? t("common.unavailable"));
      return;
    }
    setUsers((current) => [data.user, ...current.filter((user) => user.id !== data.user.id)]);
    setCreateForm({ email: "", name: "", role: "viewer", password: "" });
    setCreateOpen(false);
    if (data.generated_password) {
      setSecret({ label: t("admin.users.generatedPassword"), value: data.generated_password });
    }
  };

  const resetPassword = async (user: AdminUser) => {
    const newPassword = generateOneTimePassword();
    const updated = await patchUser(user.id, { new_password: newPassword });
    if (updated) setSecret({ label: t("admin.users.resetPasswordValue"), value: newPassword });
  };

  const disableUser = (user: AdminUser) => {
    setConfirmAction({
      title: t("admin.users.confirmDisableTitle"),
      body: t("admin.users.confirmDisableBody"),
      actionLabel: t("admin.users.confirmDisableAction"),
      onConfirm: async () => {
        await patchUser(user.id, { status: "disabled" });
      },
    });
  };

  const deleteUser = (user: AdminUser) => {
    setConfirmAction({
      title: t("admin.users.confirmDeleteTitle"),
      body: t("admin.users.confirmDeleteBody"),
      actionLabel: t("admin.users.confirmDeleteAction"),
      onConfirm: async () => {
        const { error } = await del(`/api/users/${user.id}`);
        if (error) {
          setUsersError(error);
          return;
        }
        setUsers((current) => current.filter((entry) => entry.id !== user.id));
      },
    });
  };

  const openEntitlements = (user: AdminUser) => {
    setEntitlementUser(user);
    setModelDraft(new Set(user.allowed_models ?? []));
  };

  const saveEntitlements = async () => {
    if (!entitlementUser) return;
    const allowedModels = Array.from(modelDraft);
    const updated = await patchUser(entitlementUser.id, { allowed_models: allowedModels.length > 0 ? allowedModels : null });
    if (updated) setEntitlementUser(null);
  };

  const applyAuditFilters = () => {
    setAuditOffset(0);
    setAppliedAuditFilters(auditFilters);
  };

  const saveQuota = async () => {
    setUsageError(null);
    const body = {
      daily_token_limit: numericLimit(quotaForm.daily),
      monthly_token_limit: numericLimit(quotaForm.monthly),
      allowed_models: quotaForm.models.size > 0 ? Array.from(quotaForm.models) : null,
    };
    const { data, error } = await put<QuotaResponse>(`/api/quotas/${tenantId}`, body);
    if (error || !data?.quota) {
      setUsageError(error ?? t("common.unavailable"));
      return;
    }
    setQuota(data.quota);
    setQuotaForm({
      daily: String(data.quota.daily_token_limit ?? 0),
      monthly: String(data.quota.monthly_token_limit ?? 0),
      models: new Set(data.quota.allowed_models ?? []),
    });
  };

  const reconcileUsage = async () => {
    setUsageReconciling(true);
    setUsageError(null);
    setUsageNotice(null);
    const { data, error } = await post<{
      success: boolean;
      pricing: { registry_available: boolean; repriced: number; attributed: number };
    }>('/api/admin/usage/refresh-pricing', {});
    setUsageReconciling(false);
    if (error) {
      setUsageError(error);
      return;
    }
    if (!data?.pricing.registry_available) {
      setUsageNotice(t("admin.usage.syncPriceUnavailable"));
    } else {
      setUsageNotice(t("admin.usage.syncComplete", {
        repriced: data.pricing.repriced,
        attributed: data.pricing.attributed,
      }));
    }
    await loadUsage();
  };

  if (!isAdmin) {
    return (
      <WorkspacePage testId="admin-permission-state" contentClassName="max-w-[760px]">
        <section className="rounded-lg border border-ink/[0.06] bg-ink/[0.015] p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-ink/45" />
            <div>
              <h1 className="text-[18px] font-semibold text-ink/82">{t("admin.permission.title")}</h1>
              <p className="mt-1 text-[12.5px] leading-5 text-ink/45">{t("admin.permission.description")}</p>
            </div>
          </div>
        </section>
      </WorkspacePage>
    );
  }

  const navItems: { key: AdminSection; label: string; icon: LucideIcon }[] = [
    { key: "users", label: t("admin.nav.users"), icon: Users },
    { key: "audit", label: t("admin.nav.audit"), icon: FileText },
    { key: "usage", label: t("admin.nav.usage"), icon: BarChart3 },
  ];

  return (
    <WorkspacePage testId="admin-scroll-region" contentClassName="max-w-[1180px]">
      {!section && (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-normal text-ink/85">{t("admin.title")}</h1>
            <p className="mt-1 max-w-[620px] text-[12.5px] leading-5 text-ink/40">{t("admin.description")}</p>
          </div>
        </header>
      )}

      <div className={section ? "min-w-0 space-y-4" : "flex flex-col gap-5 md:flex-row md:gap-7"}>
        {!section && (
          <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-[168px] md:flex-col md:overflow-visible">
            {navItems.map((item) => {
              const active = category === item.key;
              return (
                <button
                  key={item.key}
                  data-admin-category={item.key}
                  onClick={() => setInternalCategory(item.key)}
                  className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors"
                  style={{
                    background: active ? "var(--surface-active)" : "transparent",
                    color: active ? "var(--text-primary)" : "rgb(var(--ink-rgb) / 0.58)",
                  }}
                >
                  <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        )}

        <div className={section ? "min-w-0 space-y-4" : "min-w-0 flex-1 space-y-4"}>
          <ProviderLoadStatus
            loading={providersLoading}
            error={providersError}
            onRetry={() => void loadProviders()}
          />
          {category === "users" && (
            <UsersPanel
              users={users}
              loading={usersLoading}
              error={usersError}
              locale={locale}
              modelOptions={modelOptions}
              onCreate={() => setCreateOpen(true)}
              onRoleChange={(user, role) => void patchUser(user.id, { role })}
              onEnable={(user) => void patchUser(user.id, { status: "active" })}
              onDisable={disableUser}
              onResetPassword={(user) => void resetPassword(user)}
              onEditModels={openEntitlements}
              onDelete={deleteUser}
            />
          )}

          {category === "audit" && (
            <AuditPanel
              users={users}
              filters={auditFilters}
              entries={auditEntries}
              total={auditTotal}
              offset={auditOffset}
              loading={auditLoading}
              error={auditError}
              locale={locale}
              onFiltersChange={setAuditFilters}
              onApply={applyAuditFilters}
              onOffsetChange={setAuditOffset}
            />
          )}

          {category === "usage" && (
            <UsagePanel
              users={users}
              providers={providers}
              dailyUsage={dailyUsage}
              monthlyUsage={monthlyUsage}
              analytics={analytics}
              filters={usageFilters}
              appliedFilters={appliedUsageFilters}
              offset={usageOffset}
              quota={quota}
              quotaForm={quotaForm}
              modelOptions={modelOptions}
              loading={usageLoading}
              reconciling={usageReconciling}
              error={usageError}
              notice={usageNotice}
              locale={locale}
              onFiltersChange={setUsageFilters}
              onApplyFilters={applyUsageFilters}
              onOffsetChange={setUsageOffset}
              onQuotaFormChange={setQuotaForm}
              onSaveQuota={() => void saveQuota()}
              onReconcile={() => void reconcileUsage()}
            />
          )}
        </div>
      </div>

      {createOpen && (
        <Modal title={t("admin.users.createTitle")} description={t("admin.users.createDescription")} onClose={() => setCreateOpen(false)}>
          <div className="space-y-3">
            <Field label={t("admin.users.email")}>
              <input
                value={createForm.email}
                onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                className={inputClassName}
                style={inputStyle}
              />
            </Field>
            <Field label={t("admin.users.name")}>
              <input
                value={createForm.name}
                onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                className={inputClassName}
                style={inputStyle}
              />
            </Field>
            <Field label={t("admin.users.role")}>
              <select
                value={createForm.role}
                onChange={(event) => setCreateForm((current) => ({ ...current, role: event.target.value as Role }))}
                className={inputClassName}
                style={inputStyle}
              >
                {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{roleLabel(role, t)}</option>)}
              </select>
            </Field>
            <Field label={t("admin.users.passwordOptional")}>
              <input
                type="password"
                value={createForm.password}
                onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={t("admin.users.passwordPlaceholder")}
                className={inputClassName}
                style={inputStyle}
              />
            </Field>
            {createError && <InlineError error={createError} />}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
              <Button onClick={() => void submitCreate()} icon={UserPlus}>{t("admin.users.createSubmit")}</Button>
            </div>
          </div>
        </Modal>
      )}

      {secret && (
        <Modal title={secret.label} onClose={() => setSecret(null)}>
          <SecretField label={secret.label} value={secret.value} />
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setSecret(null)}>{t("admin.common.close")}</Button>
          </div>
        </Modal>
      )}

      {entitlementUser && (
        <Modal
          title={t("admin.users.entitlementsTitle")}
          description={t("admin.users.entitlementsDescription")}
          onClose={() => setEntitlementUser(null)}
        >
          <ProviderLoadStatus
            loading={providersLoading}
            error={providersError}
            onRetry={() => void loadProviders()}
          />
          <ModelCheckboxList
            options={modelOptions}
            selected={modelDraft}
            emptyLabel={t("admin.users.inheritTenant")}
            onChange={setModelDraft}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEntitlementUser(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => void saveEntitlements()} icon={Check}>{t("admin.users.saveEntitlements")}</Button>
          </div>
        </Modal>
      )}

      {confirmAction && (
        <Modal title={confirmAction.title} description={confirmAction.body} onClose={() => setConfirmAction(null)}>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmAction(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                void confirmAction.onConfirm().finally(() => setConfirmAction(null));
              }}
              icon={Trash2}
            >
              {confirmAction.actionLabel}
            </Button>
          </div>
        </Modal>
      )}
    </WorkspacePage>
  );
}

function ProviderLoadStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-[12px] leading-5 text-warning">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{error}</span>
        <button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-1 underline underline-offset-4">
          <RotateCw className="h-3 w-3" />
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (loading) {
    // Quiet inline status — not a bordered strip pinned above the panel.
    return (
      <div className="flex items-center gap-2 py-1 text-[12.5px] text-ink/44">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  return null;
}
