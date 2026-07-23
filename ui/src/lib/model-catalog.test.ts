import { describe, expect, it } from "vitest";
import {
  providerBrainEligible,
  providerLightEligible,
  providerSelectable,
  type CatalogProvider,
} from "./model-catalog";

describe("model-catalog role eligibility", () => {
  it("allows a ready cli-pipe provider in chat role pickers", () => {
    const cliProvider: CatalogProvider = {
      id: "claude-cli",
      name: "Claude CLI",
      apiMode: "cli-pipe",
      brainEligible: true,
      lightEligible: true,
      hasKey: true,
      models: [{ id: "_cli-default", name: "Claude CLI" }],
    };

    expect(providerSelectable(cliProvider)).toBe(true);
    expect(providerBrainEligible(cliProvider)).toBe(true);
    expect(providerLightEligible(cliProvider)).toBe(true);
  });

  it("keeps a detected-but-not-ready cli-pipe provider disabled", () => {
    const cliProvider: CatalogProvider = {
      id: "codex-cli",
      name: "Codex CLI",
      apiMode: "cli-pipe",
      brainEligible: true,
      lightEligible: true,
      hasKey: false,
      models: [{ id: "_cli-default", name: "Codex CLI default" }],
    };

    expect(providerSelectable(cliProvider)).toBe(false);
    expect(providerBrainEligible(cliProvider)).toBe(true);
  });

  it("keeps real chat providers eligible when they have runtime keys", () => {
    const chatProvider: CatalogProvider = {
      id: "openai",
      name: "OpenAI",
      apiMode: "openai-responses",
      brainEligible: true,
      lightEligible: true,
      hasKey: true,
      models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
    };

    expect(providerSelectable(chatProvider)).toBe(true);
    expect(providerBrainEligible(chatProvider)).toBe(true);
    expect(providerLightEligible(chatProvider)).toBe(true);
  });
});
