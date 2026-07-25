import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentsView from "./AgentsView";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/hooks/useApi", () => ({ useApi: () => api }));
vi.mock("@/hooks/useModelState", () => ({
  useModelState: () => ({ data: { providers: [] }, isPending: false }),
}));
vi.mock("@/components/models/ModelPickerMenu", () => ({
  ModelPickerMenu: ({ trigger }: { trigger: JSX.Element }) => trigger,
}));

const workspaceAgent = {
  id: "workspace:analyst",
  name: "analyst",
  description: "Analyzes evidence",
  model: null,
  skills: ["research-workflow"],
  color: "slate",
  source: "workspace",
  status: "ready",
  enabled: true,
  missing_skills: [],
  invalid_model: null,
} as const;

describe("AgentsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (path: string) => {
      if (path === "/api/agents") return { data: { agents: [workspaceAgent] }, error: null };
      if (path === "/api/skills") return {
        data: { skills: [{ name: "research-workflow", description: "Research", status: "active" }] },
        error: null,
      };
      return {
        data: {
          agent: {
            ...workspaceAgent,
            tools: [],
            permission_level: "L0_READ_ONLY",
            persona: "Analyze carefully.",
            content: "---",
          },
        },
        error: null,
      };
    });
  });

  it("lists discovered agents and opens the editable workspace drawer", async () => {
    render(<AgentsView />);
    expect(await screen.findByText("Analyzes evidence")).toBeInTheDocument();
    expect(screen.getByText("research-workflow")).toBeInTheDocument();

    fireEvent.click(screen.getByText("analyst"));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/agents/workspace%3Aanalyst"));
    expect(await screen.findByDisplayValue("Analyze carefully.")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("creates an agent from the drawer and refreshes the list", async () => {
    api.post.mockResolvedValue({ data: { agent: workspaceAgent }, error: null });
    render(<AgentsView />);
    await screen.findByText("Analyzes evidence");
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(screen.getByPlaceholderText("research-analyst"), { target: { value: "writer" } });
    fireEvent.change(screen.getByPlaceholderText("What this expert is best at"), { target: { value: "Writes briefs" } });
    fireEvent.change(screen.getByPlaceholderText("System instructions for this expert..."), { target: { value: "Write clearly." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/agents", expect.objectContaining({
      name: "writer",
      description: "Writes briefs",
      persona: "Write clearly.",
    })));
  });
});
