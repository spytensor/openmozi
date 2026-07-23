import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { ModelPickerMenu } from "./ModelPickerMenu";
import {
  mergeRuntimeProviders,
  providerSelectable,
  type CatalogProvider,
} from "@/lib/model-catalog";

describe("ModelPickerMenu", () => {
  it("hides inactive models and providers with no visible models", async () => {
    const providers: CatalogProvider[] = [
      {
        id: "openai",
        name: "OpenAI",
        apiMode: "openai-responses",
        hasKey: true,
        models: [
          { id: "gpt-active", name: "GPT Active", allowed: true, contextWindow: 128_000 },
          { id: "gpt-hidden", name: "GPT Hidden", allowed: false },
        ],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        apiMode: "anthropic",
        hasKey: true,
        models: [{ id: "claude-hidden", name: "Claude Hidden", allowed: false }],
      },
    ];

    renderWithLocale(
      <ModelPickerMenu
        providers={providers}
        trigger={<button type="button">Choose model</button>}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Choose model" }), { key: "Enter", code: "Enter" });

    expect(await screen.findByText("gpt-active")).toBeInTheDocument();
    expect(screen.getByText("128K")).toBeInTheDocument();
    expect(document.querySelector('[data-provider-icon="openai"]')).toBeInTheDocument();
    expect(screen.getByTestId("model-picker-menu")).toHaveClass("w-[300px]", "max-h-[340px]");
    expect(screen.queryByText("GPT Hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Hidden")).not.toBeInTheDocument();
  });

  it("keeps models visible when allowed is undefined (fail-open: no allowed field means unrestricted)", async () => {
    // Simulate a provider with no `allowed` field on its models — this is
    // the state when /api/providers fails and the UI falls back to a stale
    // or bundled list; activation must never lock the picker in this case.
    const providers: CatalogProvider[] = [
      {
        id: "openai",
        name: "OpenAI",
        apiMode: "openai-responses",
        hasKey: true,
        models: [
          { id: "gpt-no-allowed", name: "GPT No Allowed" },
        ],
      },
    ];

    renderWithLocale(
      <ModelPickerMenu
        providers={providers}
        trigger={<button type="button">Choose model</button>}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Choose model" }), { key: "Enter", code: "Enter" });

    await waitFor(() => expect(screen.getByText("gpt-no-allowed")).toBeInTheDocument());
  });
});
