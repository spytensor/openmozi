import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SkillsView from "./SkillsView";

const getMock = vi.fn();
const putMock = vi.fn();
const postMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    get: getMock,
    put: putMock,
    post: postMock,
  }),
}));

describe("SkillsView", () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    postMock.mockReset();
  });

  it("renders skills and opens read-only bundled detail", async () => {
    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/skills") {
        return {
          data: {
            skills: [
              {
                id: "bundled:docx",
                directory_name: "docx",
                name: "docx",
                description: "Bundled DOCX skill",
                version: "1.0.0",
                category: "utility",
                status: "active",
                source: "bundled",
                eligible: true,
                missing_bins: [],
                missing_env: [],
                user_invocable: true,
                sandbox_profile: "read-only",
              },
              {
                id: "workspace:research-helper",
                directory_name: "research-helper",
                name: "research-helper",
                description: "Workspace research helper",
                version: "1.0.0",
                category: "research",
                status: "active",
                source: "workspace",
                eligible: false,
                missing_bins: [],
                missing_env: ["SEARCH1API_KEY"],
                user_invocable: false,
              },
              {
                id: "workspace:disabled-helper",
                directory_name: "disabled-helper",
                name: "disabled-helper",
                description: "Disabled workspace helper",
                version: "1.0.0",
                category: "system",
                status: "disabled",
                enabled: false,
                source: "workspace",
                eligible: false,
                missing_bins: [],
                missing_env: [],
                user_invocable: false,
              },
            ],
          },
          error: null,
        };
      }
      if (path === "/api/skills/bundled%3Adocx") {
        return {
          data: {
            skill: {
              id: "bundled:docx",
              directory_name: "docx",
              name: "docx",
              description: "Bundled DOCX skill",
              version: "1.0.0",
              category: "utility",
              status: "active",
              enabled: true,
              source: "bundled",
              eligible: true,
              missing_bins: [],
              missing_env: [],
              user_invocable: true,
              sandbox_profile: "read-only",
              file_path: "/repo/skills/docx/SKILL.md",
              frontmatter: {
                name: "docx",
                description: "Bundled DOCX skill",
                version: "1.0.0",
                category: "utility",
                "user-invocable": true,
                requires: { bins: ["python3"], env: [] },
              },
              content: "# DOCX\n\nRendered **body**.",
              files: [
                { name: "SKILL.md", size: 128 },
                { name: "references/guide.md", size: 9 },
              ],
            },
          },
          error: null,
        };
      }
      return { data: null, error: "not found" };
    });

    const { container } = renderWithLocale(<SkillsView />);

    await waitFor(() => expect(screen.getByText("DOCX")).toBeInTheDocument());
    expect(screen.getAllByText("Documents").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Research").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("System").length).toBeGreaterThanOrEqual(1);
    // File-type skills (docx/pdf/pptx/xlsx) use the shared colorful file glyph
    // (same TypeIcon as artifacts/attachments); conceptual skills keep lucide.
    const docxGlyph = screen.getByTestId("skill-icon-docx").querySelector('[data-testid="artifact-type-icon"]');
    expect(docxGlyph).toBeTruthy();
    expect(docxGlyph?.getAttribute("data-type")).toBe("document");
    expect(screen.getByTestId("skill-icon-research-helper").querySelector(".lucide-search")).toBeTruthy();
    expect(screen.getByText("What MOZI can help you do")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
    expect(screen.getByText("Creates, reads, edits, and validates Word document files.")).toBeInTheDocument();
    expect(screen.queryByText("User command")).not.toBeInTheDocument();
    expect(screen.queryByText("Dependencies ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Sandbox: Managed runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Technical name: docx")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing environment: SEARCH1API_KEY")).not.toBeInTheDocument();
    expect(screen.getAllByText("Needs setup").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Built in")).not.toBeInTheDocument();
    expect(screen.getAllByText("Workspace").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole("button", { name: "Open DOCX" }));

    await waitFor(() => expect(screen.getByText("Read-only")).toBeInTheDocument());
    expect(screen.getByText("Requires tools: python3")).toBeInTheDocument();
    expect(screen.getByText("references/guide.md")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "SKILL.md" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs setup" }));
    expect(screen.queryByRole("button", { name: "Open DOCX" })).not.toBeInTheDocument();
    expect(screen.queryByText("Disabled workspace helper")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace research helper")).toBeInTheDocument();
  });

  /**
   * The page could manage skills but had no way to add one — the only install
   * path was asking the Brain to call `install_skill`.
   */
  it("installs a skill package and shows the installed skill", async () => {
    const installedSkill = {
      id: "workspace:sector-chip-rating",
      directory_name: "sector-chip-rating",
      name: "sector-chip-rating",
      description: "Rate A-share sector chip structure",
      version: "1.0.0",
      category: "finance",
      status: "active",
      enabled: true,
      source: "workspace",
      eligible: true,
      missing_bins: [],
      missing_env: [],
      user_invocable: true,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, overwritten: false, skill: installedSkill }),
    });
    vi.stubGlobal("fetch", fetchMock);
    // Empty before the install, listing the new skill on the refresh after it.
    getMock.mockImplementation(async (path: string) => {
      if (path !== "/api/skills") return { data: null, error: "not found" };
      return { data: { skills: fetchMock.mock.calls.length === 0 ? [] : [installedSkill] }, error: null };
    });

    renderWithLocale(<SkillsView />);
    await waitFor(() => expect(screen.getByText("Install package")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain(".skill");
    const file = new File(["zip-bytes"], "INVESMENT-SKILL.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills/install",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    ));
    const body = fetchMock.mock.calls[0]![1].body as FormData;
    expect((body.get("file") as File).name).toBe("INVESMENT-SKILL.zip");

    // The list refreshes, and the operator is told the skill is usable.
    expect(await screen.findByText(/Installed .* It is ready to use\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Rate A-share sector chip structure")).toBeInTheDocument());

    vi.unstubAllGlobals();
  });

  it("surfaces the runtime's reason when a package is rejected", async () => {
    getMock.mockResolvedValue({ data: { skills: [] }, error: null });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: "No SKILL.md found inside junk.zip." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithLocale(<SkillsView />);
    await waitFor(() => expect(screen.getByText("Install package")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "junk.zip", { type: "application/zip" })],
      configurable: true,
    });
    fireEvent.change(input);

    expect(await screen.findByText("No SKILL.md found inside junk.zip.")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("edits workspace SKILL.md and toggles workspace state", async () => {
    const initialContent = `---
name: custom-skill
description: Custom skill
---

# Custom
`;
    const updatedContent = `---
name: custom-skill
description: Updated custom skill
---

# Updated
`;

    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/skills") {
        return {
          data: {
            skills: [
              {
                id: "workspace:custom-skill",
                directory_name: "custom-skill",
                name: "custom-skill",
                description: "Custom skill",
                version: "1.0.0",
                category: "communication",
                status: "active",
                source: "workspace",
                eligible: true,
                missing_bins: [],
                missing_env: [],
                user_invocable: true,
              },
            ],
          },
          error: null,
        };
      }
      if (path === "/api/skills/workspace%3Acustom-skill") {
        return {
          data: {
            skill: {
              id: "workspace:custom-skill",
              directory_name: "custom-skill",
              name: "custom-skill",
              description: "Custom skill",
              version: "1.0.0",
              category: "communication",
              status: "active",
              enabled: true,
              source: "workspace",
              eligible: true,
              missing_bins: [],
              missing_env: [],
              user_invocable: true,
              file_path: "/workspace/skills/custom-skill/SKILL.md",
              frontmatter: {
                name: "custom-skill",
                description: "Custom skill",
                requires: {},
              },
              content: initialContent,
              files: [{ name: "SKILL.md", size: initialContent.length }],
            },
          },
          error: null,
        };
      }
      return { data: null, error: "not found" };
    });
    putMock.mockResolvedValueOnce({
      data: {
        skill: {
          id: "workspace:custom-skill",
          directory_name: "custom-skill",
          name: "custom-skill",
          description: "Updated custom skill",
          version: "1.0.0",
          category: "communication",
          status: "active",
          enabled: true,
          source: "workspace",
          eligible: true,
          missing_bins: [],
          missing_env: [],
          user_invocable: true,
          file_path: "/workspace/skills/custom-skill/SKILL.md",
          frontmatter: { name: "custom-skill", description: "Updated custom skill" },
          content: updatedContent,
          files: [{ name: "SKILL.md", size: updatedContent.length }],
        },
      },
      error: null,
    });
    postMock.mockResolvedValueOnce({
      data: {
        skill: {
          id: "workspace:custom-skill",
          directory_name: "custom-skill",
          name: "custom-skill",
          description: "Updated custom skill",
          version: "1.0.0",
          category: "communication",
          status: "disabled",
          enabled: false,
          source: "workspace",
          eligible: false,
          missing_bins: [],
          missing_env: [],
          user_invocable: true,
        },
      },
      error: null,
    });

    renderWithLocale(<SkillsView />);

    await waitFor(() => expect(screen.getByText("Custom skill")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Custom Skill" }));

    const editor = await screen.findByRole("textbox", { name: "SKILL.md" });
    fireEvent.change(editor, { target: { value: updatedContent } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledWith(
      "/api/skills/workspace%3Acustom-skill",
      { content: updatedContent },
    ));
    expect(await screen.findByText("Updated")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/api/skills/workspace%3Acustom-skill/state",
      { enabled: false },
    ));
  });
});
