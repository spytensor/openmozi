import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelChip } from "./ModelChip";

vi.mock("@/components/models/ModelPickerMenu", () => ({
  ModelPickerMenu: ({ trigger }: { trigger: JSX.Element }) => trigger,
}));

vi.mock("@/components/models/ProviderBadge", () => ({
  ProviderBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));

const emptyRoles = {
  brain: { provider: "", model: "", ready: false, eligible: false },
  light: { provider: "", model: "", ready: false, eligible: false },
  step: { provider: "", model: "", ready: false, inherit: true },
  plan_summary: { provider: "", model: "", ready: false, inherit: true },
  embedding: { provider: "auto", model: "", ready: true },
};

function response(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

function stubModelFetch(options: { rolesOk?: boolean; providersOk?: boolean; configured?: boolean } = {}) {
  const rolesOk = options.rolesOk ?? true;
  const providersOk = options.providersOk ?? true;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/models/roles") {
      if (!rolesOk) return Promise.resolve(response(false, { error: "roles unavailable" }));
      return Promise.resolve(response(true, options.configured ? {
        ...emptyRoles,
        brain: { provider: "openai", model: "gpt-4.1", ready: true, eligible: true },
      } : emptyRoles));
    }
    if (url === "/api/providers") {
      if (!providersOk) return Promise.resolve(response(false, { error: "providers unavailable" }));
      return Promise.resolve(response(true, {
        providers: [{
          id: "openai",
          name: "OpenAI",
          defaultModel: "gpt-4.1",
          models: [{ id: "gpt-4.1", name: "GPT-4.1", allowed: true }],
        }],
      }));
    }
    throw new Error(`unexpected request ${url}`);
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelChip", () => {
  it("opens model settings for an admin when the brain slot is empty", async () => {
    stubModelFetch();
    const onOpenModelSettings = vi.fn();
    renderWithLocale(
      <ModelChip canConfigureModels onOpenModelSettings={onOpenModelSettings} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Configure model" }));
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
  });

  it("shows a read-only organization-managed state to non-admin users", async () => {
    stubModelFetch();
    renderWithLocale(<ModelChip canConfigureModels={false} />);

    expect(await screen.findByTestId("model-chip-admin-managed")).toHaveTextContent("Model managed by administrator");
    expect(screen.queryByRole("button", { name: "Configure model" })).not.toBeInTheDocument();
  });

  it.each([
    ["roles", { rolesOk: false }],
    ["providers", { providersOk: false }],
  ])("surfaces a %s load failure and retries both model endpoints", async (_label, options) => {
    const calls = stubModelFetch(options);
    renderWithLocale(<ModelChip canConfigureModels onOpenModelSettings={vi.fn()} />);

    const retry = await screen.findByTestId("model-chip-load-error");
    expect(retry).toHaveTextContent("Failed to load model list");
    expect(calls.filter((url) => url === "/api/models/roles")).toHaveLength(1);
    expect(calls.filter((url) => url === "/api/providers")).toHaveLength(1);

    fireEvent.click(retry);
    await waitFor(() => {
      expect(calls.filter((url) => url === "/api/models/roles")).toHaveLength(2);
      expect(calls.filter((url) => url === "/api/providers")).toHaveLength(2);
    });
  });

  it("keeps the configured model picker state", async () => {
    stubModelFetch({ configured: true });
    renderWithLocale(<ModelChip canConfigureModels onOpenModelSettings={vi.fn()} />);

    expect(await screen.findByTestId("model-chip")).toHaveTextContent("GPT-4.1");
    expect(screen.queryByRole("button", { name: "Configure model" })).not.toBeInTheDocument();
  });

  it("keeps a configured tenant model read-only for non-admin users", async () => {
    stubModelFetch({ configured: true });
    renderWithLocale(<ModelChip canConfigureModels={false} />);

    expect(await screen.findByTestId("model-chip")).toBeDisabled();
    expect(screen.getByTestId("model-chip")).toHaveTextContent("GPT-4.1");
  });
});
