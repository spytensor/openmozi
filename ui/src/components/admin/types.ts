import type { CatalogProvider } from "@/lib/model-catalog";

export type Role = "admin" | "operator" | "viewer";
export type UserStatus = "active" | "disabled";
export type AdminSection = "users" | "audit" | "usage";

export interface AdminUser {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  allowed_models: string[] | null;
  last_login_at: string | null;
}

export interface UsersResponse {
  users: AdminUser[];
  limit: number;
  offset: number;
}

export interface CreateUserResponse {
  success: boolean;
  user: AdminUser;
  generated_password?: string;
}

export interface PatchUserResponse {
  success: boolean;
  user: AdminUser;
}

export interface ProvidersResponse {
  providers: CatalogProvider[];
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  outcome: "success" | "failure" | string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

export interface AuditFilters {
  action: string;
  user_id: string;
  outcome: "" | "success" | "failure";
  from: string;
  to: string;
}

export interface TenantUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  llm_calls: number;
  tool_calls: number;
  cost_by_model: Record<string, number>;
  cost_by_day: Record<string, number>;
}

export interface CostSummary {
  total_cost: number;
  by_agent: Array<{ agent_id: string; agent_name: string; total_cost: number; task_count: number }>;
}

export interface UsageAggregate {
  calls: number;
  success_calls: number;
  failed_calls: number;
  partial_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_reported_calls: number;
  cache_write_reported_calls: number;
  usage_reported_calls: number;
  legacy_calls: number;
  priced_calls: number;
  exact_priced_calls: number;
  upper_bound_calls: number;
  measured_latency_calls: number;
  unattributed_calls: number;
  cache_hit_rate: number | null;
  cost_usd: number;
  exact_cost_usd: number;
  upper_bound_cost_usd: number;
  average_latency_ms: number;
}

export interface UsageAnalytics {
  summary: UsageAggregate;
  by_user: Array<UsageAggregate & { user_id: string | null; user_email: string | null }>;
  by_model: Array<UsageAggregate & { provider: string | null; model: string | null }>;
  by_day: Array<UsageAggregate & { day: string }>;
  rows: Array<{
    id: number;
    created_at: string;
    user_id: string | null;
    user_email: string | null;
    provider: string | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    cost_usd: number;
    pricing_source: string;
    usage_status: string;
    price_version: string | null;
    currency: string;
    outcome: string;
    failure_category: string | null;
    duration_ms: number;
  }>;
  total: number;
}

export interface UsageFilters {
  user_id: string;
  provider: string;
  model: string;
  outcome: "" | "success" | "failure" | "partial";
  from: string;
  to: string;
}

export interface TenantQuota {
  tenant_id: string;
  daily_token_limit: number;
  monthly_token_limit: number;
  allowed_models: string[];
}

export interface QuotaResponse {
  success: boolean;
  quota: TenantQuota;
}
