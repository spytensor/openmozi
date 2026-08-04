import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingWizard from "./OnboardingWizard";
import { DEFAULT_PERMISSION_STORAGE_KEY } from "@/lib/permission-default";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  requests: [] as Array<{ method: string; url: string; body?: unknown }>,
}));

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    get: apiMocks.get,
    patch: apiMocks.patch,
    post: apiMocks.post,
  }),
}));

describe("OnboardingWizard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMocks.get.mockReset();
    apiMocks.patch.mockReset();
    apiMocks.post.mockReset();
    apiMocks.requests.length = 0;
    apiMocks.get.mockImplementation((url: string) => {
      apiMocks.requests.push({ method: "GET", url });
      if (url === "/api/users/me") {
        return Promise.resolve({ data: { user: { name: "Ada Runtime", role: "admin" } }, error: null });
      }
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                defaultModel: "gpt-4.1",
                models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
              },
            ],
          },
          error: null,
        });
      }
      if (url === "/api/keys") {
        return Promise.resolve({ data: { keys: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    apiMocks.patch.mockImplementation((url: string, body?: unknown) => {
      apiMocks.requests.push({ method: "PATCH", url, body });
      return Promise.resolve({ data: { success: true }, error: null });
    });
    apiMocks.post.mockImplementation((url: string, body?: unknown) => {
      apiMocks.requests.push({ method: "POST", url, body });
      if (url === "/api/keys/openai") return Promise.resolve({ data: { success: true }, error: null });
      if (url === "/api/providers/openai/check") return Promise.resolve({ data: { ok: true, model: "gpt-4.1" }, error: null });
      if (url === "/api/onboarding/complete") return Promise.resolve({ data: { ok: true }, error: null });
      return Promise.resolve({ data: { ok: true }, error: null });
    });
  });

  it("navigates the refreshed steps and completes through the existing callback", async () => {
    const onComplete = vi.fn();
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Ada Runtime")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Ada Runtime"), { target: { value: "Ada Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("heading", { name: "Model access" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Paste provider API key"), { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/keys/openai", { key: "sk-test-key" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/providers/openai/check", { model: "gpt-4.1" }));
    expect(await screen.findByText("Provider connection is ready.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Default permissions" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Full access"));
    expect(window.localStorage.getItem(DEFAULT_PERMISSION_STORAGE_KEY)).toBe("L3_FULL_ACCESS");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Setup summary")).toBeInTheDocument();
    apiMocks.requests.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(apiMocks.patch).toHaveBeenNthCalledWith(1, "/api/users/me", { name: "Ada Updated" });
    expect(apiMocks.patch).toHaveBeenNthCalledWith(2, "/api/models/roles", {
      brain: { provider: "openai", model: "gpt-4.1" },
    });
    expect(apiMocks.post).toHaveBeenLastCalledWith("/api/onboarding/complete");
    expect(apiMocks.requests).toEqual([
      { method: "PATCH", url: "/api/users/me", body: { name: "Ada Updated" } },
      { method: "PATCH", url: "/api/models/roles", body: { brain: { provider: "openai", model: "gpt-4.1" } } },
      { method: "POST", url: "/api/onboarding/complete", body: undefined },
    ]);
  });

  it("saves a DashScope key with the onboarding region endpoint", async () => {
    apiMocks.get.mockImplementation((url: string) => {
      if (url === "/api/users/me") {
        return Promise.resolve({ data: { user: { name: "Ada", role: "admin" } }, error: null });
      }
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] }, error: null });
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [{
              id: "dashscope",
              name: "Qwen / Alibaba Cloud",
              defaultModel: "qwen3.7-plus",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              regions: [
                { id: "cn", name: "China (Beijing)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
                { id: "custom", name: "Workspace / subscription endpoint", baseUrl: "" },
              ],
              models: [{ id: "qwen3.7-plus", name: "Qwen 3.7 Plus" }],
            }],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    renderWithLocale(<OnboardingWizard onComplete={vi.fn()} />);

    expect(await screen.findByDisplayValue("Ada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(await screen.findByTestId("onboarding-provider-region"), { target: { value: "custom" } });
    fireEvent.change(await screen.findByTestId("onboarding-provider-endpoint"), {
      target: { value: "https://workspace.example.com/compatible-mode/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste provider API key"), { target: { value: "sk-dashscope-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/keys/dashscope", {
      key: "sk-dashscope-test",
      baseUrl: "https://workspace.example.com/compatible-mode/v1",
    }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/providers/dashscope/check", { model: "qwen3.7-plus" }));
  });

  it("saves an Azure key with its resource URL from the wizard", async () => {
    apiMocks.get.mockImplementation((url: string) => {
      if (url === "/api/users/me") {
        return Promise.resolve({ data: { user: { name: "Ada", role: "admin" } }, error: null });
      }
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] }, error: null });
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [{
              id: "azure",
              name: "Azure OpenAI",
              apiMode: "azure-openai",
              apiType: "azure-openai",
              defaultModel: "gpt-4o",
              baseUrl: "",
              defaultBaseUrl: "",
              apiVersion: "2024-10-21",
              models: [{ id: "gpt-4o", name: "GPT-4o deployment" }],
            }],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    renderWithLocale(<OnboardingWizard onComplete={vi.fn()} />);

    expect(await screen.findByDisplayValue("Ada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // Azure has no region select and no default endpoint — the URL input is direct.
    expect(screen.queryByTestId("onboarding-provider-region")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-provider-endpoint-mode")).not.toBeInTheDocument();
    fireEvent.change(await screen.findByTestId("onboarding-provider-endpoint"), {
      target: { value: "https://myres.openai.azure.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste provider API key"), { target: { value: "azure-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/keys/azure", {
      key: "azure-key",
      baseUrl: "https://myres.openai.azure.com",
    }));
  });

  it("saves a relay endpoint through the wizard endpoint selector", async () => {
    apiMocks.get.mockImplementation((url: string) => {
      if (url === "/api/users/me") {
        return Promise.resolve({ data: { user: { name: "Ada", role: "admin" } }, error: null });
      }
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] }, error: null });
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [{
              id: "openai",
              name: "OpenAI",
              apiMode: "openai-responses",
              apiType: "openai-responses",
              defaultModel: "gpt-4.1",
              baseUrl: "https://api.openai.com/v1",
              defaultBaseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
            }],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    renderWithLocale(<OnboardingWizard onComplete={vi.fn()} />);

    expect(await screen.findByDisplayValue("Ada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(await screen.findByTestId("onboarding-provider-endpoint-mode"), { target: { value: "custom" } });
    fireEvent.change(await screen.findByTestId("onboarding-provider-endpoint"), {
      target: { value: "https://litellm.example.com/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste provider API key"), { target: { value: "sk-relay" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/keys/openai", {
      key: "sk-relay",
      baseUrl: "https://litellm.example.com/v1",
    }));
  });

  it("keeps non-admin onboarding on viewer-safe APIs", async () => {
    apiMocks.get.mockImplementation((url: string) => {
      apiMocks.requests.push({ method: "GET", url });
      if (url === "/api/users/me") {
        return Promise.resolve({ data: { user: { name: "Viewer", role: "viewer" } }, error: null });
      }
      throw new Error(`unexpected GET ${url}`);
    });
    const onComplete = vi.fn();
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Viewer")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Viewer"), { target: { value: "Viewer Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Model access for this workspace is managed by an administrator.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Get Started" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(apiMocks.get).not.toHaveBeenCalledWith("/api/keys");
    expect(apiMocks.patch).toHaveBeenCalledWith("/api/users/me", { name: "Viewer Updated" });
    expect(apiMocks.patch).not.toHaveBeenCalledWith("/api/models/roles", expect.anything());
  });

  it("makes Skip setup marker-only and fail-closed", async () => {
    const onComplete = vi.fn();
    apiMocks.post.mockImplementation((url: string, body?: unknown) => {
      apiMocks.requests.push({ method: "POST", url, body });
      if (url === "/api/onboarding/complete") return Promise.resolve({ data: null, error: "marker unavailable" });
      return Promise.resolve({ data: { ok: true }, error: null });
    });
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Ada Runtime")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Ada Runtime"), { target: { value: "Should Not Save" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip setup" }));

    expect(await screen.findByText("marker unavailable")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(apiMocks.patch).not.toHaveBeenCalled();
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledWith("/api/onboarding/complete");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(2));
    expect(apiMocks.patch).not.toHaveBeenCalled();
  });

  it("stops completion when a profile write fails", async () => {
    apiMocks.patch.mockResolvedValueOnce({ data: null, error: "profile write failed" });
    const onComplete = vi.fn();
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Ada Runtime")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Ada Runtime"), { target: { value: "Ada Failed" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Get Started" }));

    expect(await screen.findByText("profile write failed")).toBeInTheDocument();
    expect(apiMocks.patch).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).not.toHaveBeenCalledWith("/api/onboarding/complete");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("stops before the completion marker when the model role write fails and retries safely", async () => {
    apiMocks.patch.mockResolvedValueOnce({ data: null, error: "role write failed" });
    const onComplete = vi.fn();
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Ada Runtime")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("Provider connection is ready.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Get Started" }));

    expect(await screen.findByText("role write failed")).toBeInTheDocument();
    expect(apiMocks.post).not.toHaveBeenCalledWith("/api/onboarding/complete");
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(apiMocks.patch).toHaveBeenCalledTimes(2);
    expect(apiMocks.post).toHaveBeenLastCalledWith("/api/onboarding/complete");
  });

  it("uses an allowed fallback when the provider default is not entitled", async () => {
    apiMocks.get.mockImplementation((url: string) => {
      if (url === "/api/users/me") return Promise.resolve({ data: { user: { name: "Ada", role: "admin" } }, error: null });
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] }, error: null });
      if (url === "/api/providers") return Promise.resolve({
        data: {
          providers: [{
            id: "openai",
            name: "OpenAI",
            defaultModel: "blocked-model",
            models: [
              { id: "blocked-model", name: "Blocked", allowed: false },
              { id: "allowed-model", name: "Allowed", allowed: true },
            ],
          }],
        },
        error: null,
      });
      return Promise.resolve({ data: null, error: null });
    });
    const onComplete = vi.fn();
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Ada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/providers/openai/check", { model: "allowed-model" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Get Started" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(apiMocks.patch).toHaveBeenCalledWith("/api/models/roles", {
      brain: { provider: "openai", model: "allowed-model" },
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not test or assign a provider with no entitled models", async () => {
    apiMocks.get.mockImplementation((url: string) => {
      if (url === "/api/users/me") return Promise.resolve({ data: { user: { name: "Ada", role: "admin" } }, error: null });
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] }, error: null });
      if (url === "/api/providers") return Promise.resolve({
        data: {
          providers: [{
            id: "openai",
            name: "OpenAI",
            defaultModel: "blocked-model",
            models: [{ id: "blocked-model", name: "Blocked", allowed: false }],
          }],
        },
        error: null,
      });
      return Promise.resolve({ data: null, error: null });
    });
    renderWithLocale(<OnboardingWizard onComplete={vi.fn()} />);

    expect(await screen.findByDisplayValue("Ada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and test" }));

    expect(await screen.findByText("No model allowed for your account is available from this provider.")).toBeInTheDocument();
    expect(apiMocks.post).not.toHaveBeenCalledWith("/api/providers/openai/check", expect.anything());
    expect(apiMocks.patch).not.toHaveBeenCalledWith("/api/models/roles", expect.anything());
  });
});
