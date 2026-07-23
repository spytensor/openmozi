import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminView from "./AdminView";

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const patchMock = vi.fn();
const delMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ get: getMock, post: postMock, put: putMock, patch: patchMock, del: delMock }),
}));

describe("AdminView", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    putMock.mockReset();
    patchMock.mockReset();
    delMock.mockReset();
    getMock.mockImplementation((url: string) => {
      if (url === "/api/users?limit=100&offset=0") {
        return Promise.resolve({
          data: {
            users: [
              {
                id: "user-1",
                tenant_id: "default",
                email: "ada@example.com",
                name: "Ada Runtime",
                role: "admin",
                status: "active",
                allowed_models: ["gpt-4.1-mini"],
                last_login_at: "2026-07-01T10:00:00.000Z",
              },
            ],
            limit: 100,
            offset: 0,
          },
          error: null,
        });
      }
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                apiType: "openai-responses",
                defaultModel: "gpt-4.1-mini",
                hasKey: true,
                models: [
                  { id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
                  { id: "gpt-4.1", name: "GPT-4.1" },
                ],
              },
            ],
          },
          error: null,
        });
      }
      if (url.startsWith("/api/audit")) {
        return Promise.resolve({
          data: {
            entries: [
              {
                id: 1,
                timestamp: "2026-07-01T10:00:00.000Z",
                user_id: "user-1",
                user_email: "ada@example.com",
                action: "auth.login",
                resource_type: "user",
                resource_id: "user-1",
                details: { method: "password" },
                outcome: "success",
              },
            ],
            total: 1,
          },
          error: null,
        });
      }
      if (url.startsWith("/api/admin/usage?")) {
        return Promise.resolve({
          data: {
            summary: { calls: 2, success_calls: 1, failed_calls: 1, partial_calls: 0, input_tokens: 150, output_tokens: 30, cache_read_tokens: 60, cache_write_tokens: 0, cache_reported_calls: 2, cache_write_reported_calls: 0, usage_reported_calls: 2, legacy_calls: 0, priced_calls: 2, exact_priced_calls: 2, upper_bound_calls: 0, measured_latency_calls: 2, unattributed_calls: 0, cache_hit_rate: 0.4, cost_usd: 0.012, exact_cost_usd: 0.012, upper_bound_cost_usd: 0, average_latency_ms: 250 },
            by_user: [{ user_id: "user-1", user_email: "ada@example.com", calls: 2, success_calls: 1, failed_calls: 1, partial_calls: 0, input_tokens: 150, output_tokens: 30, cache_read_tokens: 60, cache_reported_calls: 2, usage_reported_calls: 2, legacy_calls: 0, priced_calls: 2, measured_latency_calls: 2, unattributed_calls: 0, cache_hit_rate: 0.4, cost_usd: 0.012, average_latency_ms: 250 }],
            by_model: [{ provider: "openai", model: "gpt-4.1-mini", calls: 2, success_calls: 1, failed_calls: 1, partial_calls: 0, input_tokens: 150, output_tokens: 30, cache_read_tokens: 60, cache_reported_calls: 2, usage_reported_calls: 2, legacy_calls: 0, priced_calls: 2, measured_latency_calls: 2, unattributed_calls: 0, cache_hit_rate: 0.4, cost_usd: 0.012, average_latency_ms: 250 }],
            by_day: [{ day: "2026-07-10", calls: 2, success_calls: 1, failed_calls: 1, partial_calls: 0, input_tokens: 150, output_tokens: 30, cache_read_tokens: 60, cache_reported_calls: 2, usage_reported_calls: 2, legacy_calls: 0, priced_calls: 2, measured_latency_calls: 2, unattributed_calls: 0, cache_hit_rate: 0.4, cost_usd: 0.012, average_latency_ms: 250 }],
            rows: [{ id: 1, created_at: "2026-07-10T10:00:00Z", user_id: "user-1", user_email: "ada@example.com", provider: "openai", model: "gpt-4.1-mini", input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cost_usd: 0.01, pricing_source: "catalog_estimate", usage_status: "provider_reported", price_version: "test:v1", currency: "usd", outcome: "success", failure_category: null, duration_ms: 200 }],
            total: 1,
          },
          error: null,
        });
      }
      if (url.startsWith("/api/tenant/usage?")) return Promise.resolve({ data: { total_tokens: 180, llm_calls: 2, tool_calls: 0, total_input_tokens: 150, total_output_tokens: 30, total_cost_usd: 0.012, cost_by_model: {}, cost_by_day: {} }, error: null });
      if (url === "/api/tenant/quotas") return Promise.resolve({ data: { tenant_id: "default", daily_token_limit: 1000, monthly_token_limit: 10000, allowed_models: [] }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    postMock.mockImplementation((url: string) => Promise.resolve({
      data: url === "/api/admin/usage/refresh-pricing" ? {
        success: true,
        pricing: { registry_available: true, repriced: 4, attributed: 3 },
      } : {
        success: true,
        generated_password: "GeneratedPass1",
        user: {
          id: "user-2",
          tenant_id: "default",
          email: "new@example.com",
          name: "New User",
          role: "viewer",
          status: "active",
          allowed_models: null,
          last_login_at: null,
        },
      },
      error: null,
    }));
  });

  it("renders the users table and validates the create flow", async () => {
    renderWithLocale(<AdminView currentUser={adminUser} />);

    expect(await screen.findByTestId("admin-user-row-ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Ada Runtime")).toBeInTheDocument();
    expect(screen.getByText("OpenAI / GPT-4.1 mini")).toBeInTheDocument();
    const sectionGroup = screen.getByTestId("admin-section-group");
    expect(sectionGroup.className).not.toContain("border");
    expect(sectionGroup.className).not.toContain("rounded");
    expect(sectionGroup.className).not.toContain("bg-");

    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New User" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/users", {
      email: "new@example.com",
      name: "New User",
      role: "viewer",
    }));
    expect(await screen.findByDisplayValue("GeneratedPass1")).toBeInTheDocument();
  });

  it("composes the audit query string from filters", async () => {
    renderWithLocale(<AdminView currentUser={adminUser} />);

    fireEvent.click(await screen.findByText("Audit"));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/audit?limit=25&offset=0"));
    expect((await screen.findAllByText("Signed in")).length).toBeGreaterThan(0);
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("View details")).toBeInTheDocument();
    getMock.mockClear();

    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "auth.login" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "user-1" } });
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "success" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-07-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith(
      "/api/audit?action=auth.login&user_id=user-1&outcome=success&from=2026-07-01&to=2026-07-02&limit=25&offset=0",
    ));
  });

  it("shows only the permission state for non-admin users", () => {
    renderWithLocale(<AdminView currentUser={{ ...adminUser, role: "viewer" }} />);

    expect(screen.getByTestId("admin-permission-state")).toBeInTheDocument();
    expect(screen.getByText("Insufficient permissions")).toBeInTheDocument();
    expect(screen.queryByText("Create user")).not.toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("renders filtered user, model, cache, cost, and call analytics", async () => {
    renderWithLocale(<AdminView currentUser={adminUser} section="usage" />);

    expect((await screen.findAllByText("ada@example.com")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("openai / gpt-4.1-mini").length).toBeGreaterThan(0);
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
    expect(screen.getByText("Daily token trend")).toBeInTheDocument();
    expect(screen.getByText("Cost by model")).toBeInTheDocument();
    expect(screen.getByText("Model reliability")).toBeInTheDocument();
    expect(screen.getByText("Call details")).toBeInTheDocument();
    expect(screen.getByText("Estimated spend")).toBeInTheDocument();
    expect(screen.queryByText("Provider billing connection")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh pricing & recalculate" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/admin/usage/refresh-pricing", {}));
    expect(await screen.findByText(/Price map refreshed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toContain("/api/admin/usage/export?");
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining("/api/admin/usage?"));
  });
});

const adminUser = {
  id: "admin-1",
  tenant_id: "default",
  email: "admin@example.com",
  name: "Admin User",
  role: "admin" as const,
  status: "active" as const,
};
