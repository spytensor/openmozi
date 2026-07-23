import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import type { RuntimeHealth, RuntimeServiceStatus, RuntimeWorkspaceSnapshot } from "@/types/runtime";
import { THEME_STORAGE_KEY } from "@/theme/ThemeProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n";

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const patchMock = vi.fn();
const delMock = vi.fn();
let deepseekReasonerAllowed = true;
let claudeInstalled = true;

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ get: getMock, post: postMock, put: putMock, patch: patchMock, del: delMock }),
}));

function clickCategory(key: string) {
  fireEvent.click(document.querySelector(`[data-settings-category="${key}"]`) as Element);
}

async function openActiveModelManager() {
  await screen.findByTestId("settings-active-model-manager");
  await screen.findByPlaceholderText("Search models or providers…");
}

describe("SettingsView", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    delete window.moziDesktop;
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.classList.remove("dark");
    getMock.mockReset();
    postMock.mockReset();
    putMock.mockReset();
    patchMock.mockReset();
    delMock.mockReset();
    deepseekReasonerAllowed = true;
    claudeInstalled = true;
    postMock.mockResolvedValue({ data: { success: true }, error: null });
    putMock.mockResolvedValue({
      data: { success: true, quota: { tenant_id: "default", allowed_models: [] } },
      error: null,
    });
    patchMock.mockResolvedValue({
      data: {
        success: true,
        roles: {
          brain: { provider: "deepseek", model: "deepseek-reasoner", ready: true },
          light: { provider: "deepseek", model: "deepseek-chat", ready: true },
          step: { provider: "", model: "", ready: true, inherit: true },
          plan_summary: { provider: "", model: "", ready: true, inherit: true },
          embedding: { provider: "auto", model: "", ready: true },
        },
      },
      error: null,
    });
    delMock.mockResolvedValue({ data: { success: true }, error: null });
    getMock.mockImplementation((url: string) => {
      if (url === "/api/models/roles") return Promise.resolve({
        data: {
          brain: { provider: "deepseek", model: "deepseek-chat", ready: true },
          light: { provider: "deepseek", model: "deepseek-chat", ready: true },
          step: { provider: "", model: "", ready: true, inherit: true },
          plan_summary: { provider: "", model: "", ready: true, inherit: true },
          embedding: { provider: "auto", model: "", ready: true },
        },
      });
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] } });
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [
              { id: "deepseek", name: "DeepSeek", apiType: "openai-compat", defaultModel: "deepseek-chat", hasKey: true, models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner", allowed: deepseekReasonerAllowed }] },
              { id: "openai", name: "OpenAI", apiType: "openai-responses", defaultModel: "gpt-4.1", hasKey: false, models: [{ id: "gpt-4.1", name: "GPT-4.1" }] },
            ],
            current: { provider: "deepseek", model: "deepseek-chat" },
          },
        });
      }
      if (url === "/api/search-key") return Promise.resolve({ data: { configured: false } });
      if (url === "/api/services") {
        return Promise.resolve({
          data: {
            providers: [
              { id: "search1api", category: "search", name: "Search1API", hint: "Search + crawl", docsUrl: "https://www.search1api.com", supportsFetch: true, configured: false },
              { id: "tavily", category: "search", name: "Tavily", hint: "LLM search", docsUrl: "https://tavily.com", supportsFetch: true, configured: false },
              { id: "serper", category: "search", name: "Serper", hint: "Google SERP", docsUrl: "https://serper.dev", supportsFetch: false, configured: false },
              { id: "brave", category: "search", name: "Brave Search", hint: "Independent index", docsUrl: "https://brave.com/search/api", supportsFetch: false, configured: false },
            ],
            activeSearchProvider: null,
          },
        });
      }
      if (url === "/api/version") return Promise.resolve({ data: { version: "2.0.0", commit: "b181460bc519", buildTime: "2026-07-11T00:00:00.000Z", channel: "stable", surface: "docker" } });
      if (url === "/api/coding-workers") return Promise.resolve({
        data: {
          workers: [
            { id: "codex_cli", installed: true, authed: true, ready: true, commandPath: "/opt/homebrew/bin/codex", remediation: null },
            claudeInstalled
              ? { id: "claude_code", installed: true, authed: false, ready: false, commandPath: "/opt/homebrew/bin/claude", remediation: "Run: claude login" }
              : { id: "claude_code", installed: false, authed: false, ready: false, commandPath: null, remediation: "npm install -g @anthropic-ai/claude-code" },
          ],
          config: { routing: "auto", available: [] },
        },
      });
      return Promise.resolve({ data: null });
    });
  });

  it("renders the settings dialog and switches intent-based sections", async () => {
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    const region = await screen.findByTestId("settings-scroll-region");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("dialog")).toHaveClass("max-w-[1180px]");
    expect(region).toHaveClass("overflow-hidden");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Display Language" })).toBeInTheDocument();

    clickCategory("models");
    expect(screen.getByTestId("settings-role-grid")).toHaveClass("settings-role-grid");
    expect(screen.getByTestId("settings-role-card-brain")).toBeInTheDocument();
    expect(screen.getByTestId("settings-role-card-light")).toBeInTheDocument();
    expect(screen.getByTestId("settings-role-card-step")).toHaveTextContent("Conversation model");
    expect(screen.getByTestId("settings-role-card-plan_summary")).toHaveTextContent("Conversation model");
    expect(screen.getByTestId("settings-role-card-embedding")).toBeInTheDocument();
    expect(screen.getByTestId("settings-role-card-brain").querySelector('[data-provider-icon="deepseek"]')).toBeInTheDocument();
    expect(screen.queryByText("Change")).not.toBeInTheDocument();
    expect(screen.getAllByText("DeepSeek Chat").length).toBeGreaterThan(0);
    expect(screen.queryByText("Storage Paths")).not.toBeInTheDocument();
    expect(screen.queryByText("Security")).not.toBeInTheDocument();

    // Model Providers: the tab label names the panel, so there is no redundant
    // in-panel heading or search box — just the add-key control and provider rows.
    clickCategory("providers");
    expect(screen.queryByPlaceholderText("Search providers...")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Model Providers" })).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-test-provider-deepseek")).toBeInTheDocument();

    // Provider credentials and non-model services share one user-intent section.
    expect(screen.getByRole("heading", { name: "Web Search" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "More services" })).toBeInTheDocument();

    clickCategory("appearance");
    expect(screen.getByTestId("settings-theme-system")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("combobox", { name: "Display Language" })).not.toBeInTheDocument();

    // Diagnostics: runtime internals stay gated behind the toggle.
    clickCategory("diagnostics");
    expect(screen.queryByText("Runtime Health")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-diagnostics-toggle"));
    expect(await screen.findByTestId("settings-diagnostics-panel")).toBeInTheDocument();
    expect(screen.getByText("Runtime Health")).toBeInTheDocument();
    expect(screen.queryByText("Runtime Service")).not.toBeInTheDocument();

    clickCategory("about");
    expect(screen.getByTestId("settings-about")).toBeInTheDocument();
    expect(screen.getByText("2.0.0")).toBeInTheDocument();
    expect(screen.getByText("b181460bc519")).toBeInTheDocument();
    expect(screen.getByText("Docker / Web")).toBeInTheDocument();
  });

  it("opens the settings shell without waiting for remote sections", () => {
    getMock.mockImplementation(() => new Promise(() => {}));

    renderWithLocale(<SettingsView />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("settings-scroll-region")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Display Language" })).toBeInTheDocument();
  });

  it("can open directly on model settings from a recovery action", async () => {
    renderWithLocale(<SettingsView initialCategory="models" />);

    expect(await screen.findByRole("button", { name: "Models" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Model & Reasoning")).toBeInTheDocument();
  });

  it("closes on Escape and backdrop click", async () => {
    const onClose = vi.fn();
    const { rerender } = renderWithLocale(<SettingsView onClose={onClose} />);
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<SettingsView onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("changes display language immediately and persists it", async () => {
    renderWithLocale(<SettingsView />);
    const select = await screen.findByRole("combobox", { name: "Display Language" });
    fireEvent.change(select, { target: { value: "zh-CN" } });
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "界面语言" })).toHaveValue("zh-CN");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("shows truthful coding worker state and saves activation with routing", async () => {
    putMock.mockImplementation((url: string, body: unknown) => url === "/api/coding-workers"
      ? Promise.resolve({ data: { config: body }, error: null })
      : Promise.resolve({ data: { success: true, quota: { tenant_id: "default", allowed_models: [] } }, error: null }));
    renderWithLocale(<SettingsView />);

    expect(await screen.findByRole("heading", { name: "Coding delegation workers" })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Installed, not authenticated: Run: claude login")).toBeInTheDocument();
    expect(screen.getByTestId("settings-coding-worker-claude_code")).toBeDisabled();

    fireEvent.click(screen.getByTestId("settings-coding-worker-codex_cli"));
    fireEvent.change(screen.getByRole("combobox", { name: "Default routing" }), { target: { value: "codex_cli" } });
    fireEvent.click(screen.getByTestId("settings-save-coding-workers"));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith("/api/coding-workers", {
      routing: "codex_cli", available: ["codex_cli"],
    }));
    expect(await screen.findByText(/no restart is required/i)).toBeInTheDocument();
  });

  it("shows a detected worker that is not installed", async () => {
    claudeInstalled = false;
    renderWithLocale(<SettingsView />);
    expect(await screen.findByText("Not installed")).toBeInTheDocument();
  });

  it.each(["en", "zh-CN"] as const)("does not render banned settings jargon in %s", async (locale) => {
    renderWithLocale(<SettingsView />, { locale });
    await screen.findByRole("dialog");
    clickCategory("models");
    expect(document.body.textContent).not.toMatch(/runtime controls|model roles contract|runtime registry|local agent UI|Role slots are loaded|运行时控制|运行时注册表|模型角色契约/i);
  });

  it("surfaces a Desktop shell and runtime version mismatch", async () => {
    window.moziDesktop = {
      selectDirectory: async () => ({ canceled: true }),
      getBuildInfo: async () => ({ version: "2.0.1", surface: "desktop" }),
    };
    getMock.mockImplementation((url: string) => {
      if (url === "/api/version") return Promise.resolve({ data: { version: "2.0.0", commit: "abc", buildTime: "now", channel: "stable", surface: "desktop" } });
      if (url === "/api/models/roles") return Promise.resolve({ data: { brain: { provider: "deepseek", model: "deepseek-chat", ready: true }, light: { provider: "deepseek", model: "deepseek-chat", ready: true }, embedding: { provider: "auto", model: "", ready: true } } });
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] } });
      if (url === "/api/providers") return Promise.resolve({ data: { providers: [] } });
      if (url === "/api/services") return Promise.resolve({ data: { providers: [], activeSearchProvider: null } });
      return Promise.resolve({ data: null });
    });
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);
    await waitFor(() => expect(document.querySelector('[data-settings-category="about"]')).toBeTruthy());
    clickCategory("about");
    expect(await screen.findByTestId("settings-version-mismatch")).toBeInTheDocument();
    expect(screen.getByText("2.0.1")).toBeInTheDocument();
  });

  it("sets the theme preference from the Appearance cards", async () => {
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("appearance");

    fireEvent.click(screen.getByTestId("settings-theme-dark"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByTestId("settings-theme-dark")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("settings-theme-light"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(screen.getByTestId("settings-theme-light")).toHaveAttribute("aria-pressed", "true");
  });

  it("saves a provider key and can immediately test that provider", async () => {
    postMock.mockImplementation((url: string) => {
      if (url === "/api/keys/openai") return Promise.resolve({ data: { success: true }, error: null });
      if (url === "/api/providers/openai/check") return Promise.resolve({ data: { ok: true, model: "gpt-4.1" }, error: null });
      return Promise.resolve({ data: { success: true }, error: null });
    });

    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("providers");
    // The add-key form is collapsed behind a button now; reveal it first.
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });

    fireEvent.change(screen.getByPlaceholderText("Paste API key…"), { target: { value: "sk-openai-test-key" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save key" })[0]);

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/keys/openai", { key: "sk-openai-test-key" }));
    fireEvent.click(screen.getByTestId("settings-test-provider-openai"));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/providers/openai/check", { model: "gpt-4.1" }));
    await waitFor(() => expect(screen.getByLabelText("Connection OK")).toBeInTheDocument());
  });

  it("patches model role changes through the roles endpoint", async () => {
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("models");
    await screen.findByTestId("settings-role-card-brain");
    fireEvent.keyDown(screen.getByTestId("settings-role-actions-brain"), { key: "Enter", code: "Enter" });
    const change = await screen.findByTestId("settings-change-role-brain");
    change.focus();
    fireEvent.keyDown(change, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(document.querySelector('[data-model-option="deepseek:deepseek-reasoner"]')).toBeInTheDocument());
    fireEvent.click(document.querySelector('[data-model-option="deepseek:deepseek-reasoner"]') as Element);

    await waitFor(() => expect(patchMock).toHaveBeenCalledWith("/api/models/roles", {
      brain: { provider: "deepseek", model: "deepseek-reasoner" },
    }));
  });

  it("only enables active-model saving for changes and settles to a saved state", async () => {
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("models");
    expect(await screen.findByText("All configured models are active")).toBeInTheDocument();
    await openActiveModelManager();
    expect(await screen.findByTestId("settings-active-model-deepseek-chat")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-manage-active-models")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-active-provider-deepseek").querySelector(".lg\\:grid-cols-2")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search models or providers…"), { target: { value: "reasoner" } });
    expect(screen.queryByTestId("settings-active-model-deepseek-chat")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-active-model-deepseek-reasoner")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search models or providers…"), { target: { value: "" } });
    expect(screen.getByTestId("settings-active-model-deepseek-chat")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("settings-active-model-deepseek-reasoner")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("settings-save-active-models")).toBeDisabled();
    expect(screen.getByTestId("settings-save-active-models")).toHaveTextContent("Saved");

    fireEvent.click(screen.getByTestId("settings-active-model-deepseek-reasoner"));
    expect(screen.getByTestId("settings-save-active-models")).toBeEnabled();
    expect(screen.getByTestId("settings-save-active-models")).toHaveTextContent("Save active models");
    fireEvent.click(screen.getByTestId("settings-save-active-models"));

    await waitFor(() => expect(putMock).toHaveBeenCalledWith("/api/quotas/default", {
      allowed_models: ["deepseek-chat"],
    }));
    await waitFor(() => expect(screen.getByTestId("settings-save-active-models")).toBeDisabled());
    expect(screen.getByTestId("settings-save-active-models")).toHaveTextContent("Saved");
    expect(getMock.mock.calls.filter(([url]) => url === "/api/providers")).toHaveLength(1);
  });

  it("keeps changed active models retryable when saving fails", async () => {
    putMock.mockResolvedValueOnce({ data: null, error: "Unable to save models" });
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("models");
    await openActiveModelManager();
    const checkbox = await screen.findByTestId("settings-active-model-deepseek-reasoner");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("settings-save-active-models"));

    await screen.findByText("Unable to save models");
    expect(screen.getByTestId("settings-save-active-models")).toBeEnabled();
    expect(screen.getByTestId("settings-save-active-models")).toHaveTextContent("Save active models");
  });

  it("preserves unrestricted quota semantics when the last connected model is enabled", async () => {
    deepseekReasonerAllowed = false;
    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("models");
    await openActiveModelManager();
    expect(screen.queryByTestId("settings-active-model-deepseek-reasoner")).not.toBeInTheDocument();
    const addModel = screen.getByTestId("settings-add-model-deepseek");
    expect(addModel).toHaveTextContent("Add models · 1");
    fireEvent.click(addModel);
    const checkbox = await screen.findByTestId("settings-picker-model-deepseek-reasoner");
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("settings-save-active-models"));

    await waitFor(() => expect(putMock).toHaveBeenCalledWith("/api/quotas/default", {
      allowed_models: null,
    }));
    await waitFor(() => expect(screen.getByTestId("settings-save-active-models")).toHaveTextContent("Saved"));
  });

  it("refreshes live models and saves an explicit list when a discovered model is selected", async () => {
    getMock.mockImplementation((url: string) => {
      if (url === "/api/models/roles") return Promise.resolve({
        data: {
          brain: { provider: "deepseek", model: "deepseek-chat", ready: true },
          light: { provider: "deepseek", model: "deepseek-chat", ready: true },
          embedding: { provider: "auto", model: "", ready: true },
        },
      });
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] } });
      if (url === "/api/services") return Promise.resolve({ data: { providers: [], activeSearchProvider: null } });
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [
              { id: "deepseek", name: "DeepSeek", apiType: "openai-compat", apiMode: "openai-compat", defaultModel: "deepseek-chat", hasKey: true, discovery: { supported: true, source: "cache", fetched_at: "2026-07-10T00:00:00.000Z", capability_confidence: "provider", fallback_reason: "offline" }, models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }] },
            ],
          },
        });
      }
      if (url === "/api/providers/deepseek/models/live") {
        return Promise.resolve({
          data: {
            success: true,
            provider: "deepseek",
            models: [
              {
                id: "deepseek-v4-pro-preview",
                bundled: false,
                resolvable: true,
                metadata: {
                  contextWindow: 1048576,
                  supportsTools: true,
                  inputCostPer1M: 1.5,
                  outputCostPer1M: 4.5,
                },
              },
            ],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null });
    });

    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("models");
    await openActiveModelManager();
    await screen.findByTestId("settings-active-model-deepseek-chat");
    expect(screen.getByText("Provider is unreachable right now — showing the cached list.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-refresh-live-deepseek"));
    await waitFor(() => expect(screen.getByTestId("settings-add-model-deepseek")).toHaveTextContent("Add models · 1"));
    expect(screen.queryByTestId("settings-active-model-deepseek-v4-pro-preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-add-model-deepseek"));
    fireEvent.change(screen.getByPlaceholderText("Search DeepSeek models…"), { target: { value: "deepseek-v4-pro-preview" } });
    const liveCheckbox = await screen.findByTestId("settings-picker-model-deepseek-v4-pro-preview");
    expect(screen.getByText("live")).toBeInTheDocument();
    fireEvent.click(liveCheckbox);
    expect(screen.getByTestId("settings-active-model-deepseek-v4-pro-preview")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions · DeepSeek" }), { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add custom model ID…" }));
    fireEvent.change(screen.getByPlaceholderText("Manual model ID"), { target: { value: "deepseek-private-preview" } });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/providers/deepseek/models/manual", {
      model: "deepseek-private-preview",
    }));
    await screen.findByTestId("settings-active-model-deepseek-private-preview");
    fireEvent.click(screen.getByTestId("settings-save-active-models"));

    await waitFor(() => expect(putMock).toHaveBeenCalledWith("/api/quotas/default", {
      allowed_models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro-preview", "deepseek-private-preview"],
    }));
  });

  it("replaces stale Codex CLI discoveries with the CLI-owned model list", async () => {
    getMock.mockImplementation((url: string) => {
      if (url === "/api/models/roles") return Promise.resolve({
        data: {
          brain: { provider: "deepseek", model: "deepseek-chat", ready: true },
          light: { provider: "deepseek", model: "deepseek-chat", ready: true },
          embedding: { provider: "auto", model: "", ready: true },
        },
      });
      if (url === "/api/providers") return Promise.resolve({
        data: {
          providers: [{
            id: "codex-cli",
            name: "Codex CLI",
            apiType: "cli-pipe",
            apiMode: "cli-pipe",
            defaultModel: "_cli-default",
            hasKey: true,
            models: [
              { id: "_cli-default", name: "Codex CLI default", allowed: false },
              { id: "deepseek-v4-pro", name: "deepseek-v4-pro", allowed: true, discovered: true, source: "catalog" },
            ],
          }],
        },
      });
      if (url === "/api/providers/codex-cli/models/live") return Promise.resolve({
        data: {
          success: true,
          provider: "codex-cli",
          source: "live",
          models: [{
            id: "gpt-5.6-sol",
            name: "GPT-5.6-Sol",
            bundled: false,
            resolvable: true,
            metadata: { contextWindow: 272000, supportsVision: true, supportsTools: false },
          }],
        },
        error: null,
      });
      if (url === "/api/keys") return Promise.resolve({ data: { keys: [] } });
      if (url === "/api/services") return Promise.resolve({ data: { providers: [], activeSearchProvider: null } });
      return Promise.resolve({ data: null });
    });

    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);
    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("models");
    await openActiveModelManager();
    await screen.findByTestId("settings-active-model-deepseek-v4-pro");

    fireEvent.click(screen.getByTestId("settings-refresh-live-codex-cli"));

    await waitFor(() => expect(screen.queryByTestId("settings-active-model-deepseek-v4-pro")).not.toBeInTheDocument());
    expect(screen.getByTestId("settings-add-model-codex-cli")).toHaveTextContent("Add models · 2");
  });

  it("adds a search service key through the API Services flow and surfaces errors", async () => {
    postMock.mockImplementation((url: string) => {
      if (url === "/api/services/search1api/key") return Promise.resolve({ data: null, error: "Unable to store SEARCH1API_KEY" });
      return Promise.resolve({ data: { success: true }, error: null });
    });

    renderWithLocale(<SettingsView snapshot={snapshot} health={health} service={service} />);

    await screen.findByRole("heading", { name: "Settings" });
    clickCategory("providers");
    await screen.findByRole("heading", { name: "Web Search" });

    // Vendor rows are listed, each with a "Get a key" link when unconfigured.
    expect(screen.getByTestId("settings-service-row-tavily")).toBeInTheDocument();
    expect(screen.getByTestId("settings-service-row-serper")).toBeInTheDocument();
    expect(screen.getByTestId("settings-service-row-brave")).toBeInTheDocument();

    // Reveal the add-key form; the provider select defaults to the first vendor.
    fireEvent.click(screen.getByRole("button", { name: "Add service key" }));
    fireEvent.change(screen.getByPlaceholderText("Paste API key…"), { target: { value: "search1api-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/services/search1api/key", { key: "search1api-test-key" }));
    expect(await screen.findByText("Unable to store SEARCH1API_KEY")).toBeInTheDocument();
  });
});

const snapshot: RuntimeWorkspaceSnapshot = {
  generated_at: "2026-07-01T00:00:00.000Z",
  mozi_home: { path: "/Users/test/.mozi", exists: true },
  config: {
    path: "/Users/test/.mozi/mozi.json",
    exists: true,
    server: { host: "127.0.0.1", port: 9210, auth_mode: "none" },
    workspace_dir: "/Users/test/.mozi/workspace",
    workspace_dir_resolved: "/Users/test/.mozi/workspace",
  },
  storage: {
    db_path: "/Users/test/.mozi/data/mozi.db",
    db_exists: true,
    db_size_bytes: 4096,
    log_path: "/Users/test/.mozi/logs/mozi.log",
    log_exists: true,
    log_size_bytes: 2048,
    heartbeat_path: "/Users/test/.mozi/data/heartbeat.json",
    heartbeat_exists: true,
    pid_path: "/Users/test/.mozi/data/mozi.pid",
    pid_exists: true,
  },
  migration: {
    legacy_home_path: "/Users/test/.mozi",
    legacy_home_exists: true,
    target_home_path: "/Users/test/Library/Application Support/MOZI",
    manifest_path: "/Users/test/.mozi/.mozi-desktop-migration.json",
    manifest_exists: true,
    conflict: false,
  },
  roots: [
    {
      id: "project",
      kind: "project_root",
      label: "Runtime Source",
      path: "/Users/test/Mozi",
      exists: true,
      git: { is_repo: true, branch: "main" },
    },
  ],
  counts: {
    sessions: 2,
    conversations: 12,
    memory_facts: 4,
    session_digests: 1,
    skills: 7,
    active_tasks: 0,
    worker_jobs: 1,
    background_tasks: 0,
  },
  runtime: {
    tasks_by_status: {},
    worker_jobs_by_status: {},
    background_tasks_by_status: {},
  },
};

const health: RuntimeHealth = {
  ok: true,
  pid: 12345,
  mozi_home: "/Users/test/.mozi",
  config_path: "/Users/test/.mozi/mozi.json",
};

const service: RuntimeServiceStatus = {
  installed: true,
  platform: "darwin",
  unitPath: "/Users/test/Library/LaunchAgents/com.mozi.plist",
  active: true,
  enabled: true,
};
