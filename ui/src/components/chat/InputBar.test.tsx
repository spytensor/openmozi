import { act, fireEvent, screen, waitFor, within, renderWithLocale } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InputBar from "./InputBar";

const noop = () => {};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/commands") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ commands: [] }),
      });
    }
    if (url === "/api/models/roles") {
      if (init?.method === "PATCH") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            roles: {
              brain: { provider: "deepseek", model: "deepseek-chat", ready: true },
              light: { provider: "deepseek", model: "deepseek-chat", ready: true },
              embedding: { provider: "auto", model: "", ready: true },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          brain: { provider: "deepseek", model: "deepseek-chat", ready: true },
          light: { provider: "deepseek", model: "deepseek-chat", ready: true },
          embedding: { provider: "auto", model: "", ready: true },
        }),
      });
    }
    if (url === "/api/providers") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          providers: [
            {
              id: "deepseek",
              name: "DeepSeek",
              apiType: "openai-compat",
              defaultModel: "deepseek-chat",
              hasKey: true,
              models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
            },
          ],
        }),
      });
    }
    if (url === "/api/sessions/s1/permission-level") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          sessionId: "s1",
          permission_level: init?.method === "PATCH" ? "L3_FULL_ACCESS" : "L0_READ_ONLY",
        }),
      });
    }
    if (url === "/api/fs/browse") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          dir: "/Users/test/workspace",
          base: "/Users/test/workspace",
          parent: null,
          dirs: [],
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    });
  }));
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
  });
  vi.unstubAllGlobals();
  delete window.moziDesktop;
});

describe("InputBar", () => {
  it("shows the branch chip only for git repo roots and opens the branch picker on click", async () => {
    const repoRoot = {
      id: "project_root:/Users/test/Repo",
      kind: "project_root" as const,
      label: "Repo",
      path: "/Users/test/Repo",
      exists: true,
      git: { is_repo: true, branch: "main" },
    };
    const { rerender } = renderWithLocale(
      <InputBar variant="active" onSend={noop} connectionStatus="connected" queueCount={0} roots={[repoRoot]} selectedRoot={repoRoot} onSelectRoot={noop} />,
    );
    expect(screen.getByTestId("branch-chip")).toHaveTextContent("main");

    // Clicking the branch chip (a Radix Popover trigger) opens the branch picker.
    fireEvent.click(screen.getByTestId("branch-chip"));
    expect(await screen.findByTestId("branch-picker")).toBeInTheDocument();

    // Non-repo root: no branch chip at all.
    const folderRoot = { ...repoRoot, id: "project_root:/Users/test/Plain", path: "/Users/test/Plain", git: { is_repo: false } };
    rerender(
      <InputBar variant="active" onSend={noop} connectionStatus="connected" queueCount={0} roots={[folderRoot]} selectedRoot={folderRoot} onSelectRoot={noop} />,
    );
    expect(screen.queryByTestId("branch-chip")).not.toBeInTheDocument();
  });

  it("uses the native desktop directory picker and grants the selected project", async () => {
    const selectDirectory = vi.fn().mockResolvedValue({ canceled: false, path: "/Users/test/Existing" });
    window.moziDesktop = { selectDirectory };
    const onSelectRoot = vi.fn();
    const onRootsChanged = vi.fn();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/fs/roots" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ root: { path: "/Users/test/Existing", label: "Existing" } }),
        } as Response);
      }
      if (url === "/api/commands") return Promise.resolve({ ok: true, json: () => Promise.resolve({ commands: [] }) } as Response);
      if (url === "/api/models/roles") return Promise.resolve({ ok: true, json: () => Promise.resolve({ brain: { provider: "deepseek", model: "deepseek-chat", ready: true } }) } as Response);
      if (url === "/api/providers") return Promise.resolve({ ok: true, json: () => Promise.resolve({ providers: [] }) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    renderWithLocale(<InputBar variant="active" onSend={noop} connectionStatus="connected" queueCount={0} roots={[]} onSelectRoot={onSelectRoot} onRootsChanged={onRootsChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use an existing folder" }));

    await waitFor(() => expect(selectDirectory).toHaveBeenCalledOnce());
    await waitFor(() => expect(onSelectRoot).toHaveBeenCalledWith(expect.objectContaining({ path: "/Users/test/Existing" })));
    expect(fetchMock).toHaveBeenCalledWith("/api/fs/roots", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the server folder browser when the desktop bridge is absent", async () => {
    renderWithLocale(<InputBar variant="active" onSend={noop} connectionStatus="connected" queueCount={0} roots={[]} onSelectRoot={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use an existing folder" }));
    expect(await screen.findByText("Choose a folder to import")).toBeInTheDocument();
  });

  it("uses a compact single-line active composer by default", async () => {
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
      />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;

    expect(screen.getByTestId("composer")).toHaveAttribute("data-composer-variant", "active");
    expect(textarea.rows).toBe(1);
    expect(textarea.className).toContain("min-h-[34px]");
    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
  });

  it("keeps the empty composer compact without a keyboard-help footer", async () => {
    renderWithLocale(
      <InputBar
        variant="empty"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
      />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;

    expect(screen.getByTestId("composer")).toHaveAttribute("data-composer-variant", "empty");
    expect(textarea.rows).toBe(3);
    expect(textarea.className).toContain("min-h-[84px]");
    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
    expect(screen.queryByText("to send")).not.toBeInTheDocument();
    expect(screen.queryByText("Commands")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files and folders" })).toHaveTextContent("Add");
  });

  it("opens the file picker directly from the + button — no menu, no coming-soon list", () => {
    // One live action means the button IS the action (operator decision
    // 2026-07-18): a menu whose only real row was "Files and folders" plus a
    // COMING SOON graveyard advertised unwired capabilities.
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    try {
      renderWithLocale(
        <InputBar variant="empty" onSend={noop} connectionStatus="connected" queueCount={0} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Files and folders" }));
      expect(clickSpy).toHaveBeenCalled();
      expect(screen.queryByTestId("composer-add-menu")).not.toBeInTheDocument();
      expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it("uses collision-aware positioning for the new-project submenu", async () => {
    renderWithLocale(
      <InputBar
        variant="empty"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
        roots={[]}
        onSelectRoot={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));

    const submenu = await screen.findByTestId("project-new-menu");
    expect(["left", "right"]).toContain(submenu.getAttribute("data-side"));
    expect(screen.getByTestId("composer")).not.toContainElement(submenu);
  });

  it("separates writing actions from the configuration tray", async () => {
    renderWithLocale(
      <InputBar variant="empty" onSend={noop} connectionStatus="connected" queueCount={0} sessionId="s1" />,
    );
    await screen.findByText("DeepSeek Chat");

    const tray = screen.getByTestId("composer-controls-tray");
    // The tray inherits the composer surface — no separate fill and no divider
    // (operator decision 2026-07-18: a two-tone composer reads as fragmented).
    expect(tray.style.background).toBe("");
    expect(tray).not.toHaveClass("border-t");
    expect(within(tray).getByRole("button", { name: "Files and folders" })).toBeInTheDocument();
    expect(within(tray).getByTestId("permission-chip")).toBeInTheDocument();
    expect(within(tray).getByTestId("model-chip")).toBeInTheDocument();
    // Send/stop sits at the composer's bottom-right corner INSIDE the tray —
    // the standard chat placement (operator decision 2026-07-18; it previously
    // floated mid-right beside the empty textarea).
    expect(tray).toContainElement(screen.getByTestId("composer-submit"));
  });

  it("fills but does not send a starter prompt", async () => {
    const onSend = vi.fn();
    const onConsumed = vi.fn();
    renderWithLocale(
      <InputBar
        variant="empty"
        onSend={onSend}
        connectionStatus="connected"
        queueCount={0}
        draftRequest={{ id: 7, text: "Create a concise brief" }}
        onDraftRequestConsumed={onConsumed}
      />,
    );

    expect(await screen.findByDisplayValue("Create a concise brief")).toHaveFocus();
    expect(onConsumed).toHaveBeenCalledWith(7);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps slash commands hidden while the command surface is unsupported", async () => {
    const fetchMock = vi.mocked(fetch);
    renderWithLocale(
      <InputBar variant="active" onSend={noop} connectionStatus="connected" queueCount={0} />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...");
    fireEvent.change(textarea, { target: { value: "/" } });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/commands");
  });

  it("can hide workspace and auxiliary controls for chat-only MVP", async () => {
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
        roots={[{
          id: "project",
          kind: "project_root",
          label: "Runtime Source",
          path: "/Users/test/Mozi",
          exists: true,
        }]}
        workspaceContextEnabled={false}
        attachmentControlsEnabled={false}
        mentionControlsEnabled={false}
      />,
    );
    await screen.findByText("DeepSeek Chat");

    expect(screen.queryByText("General task")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Attach")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Mention")).not.toBeInTheDocument();
  });

  it("shows the current brain model from model roles", async () => {
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
      />,
    );

    expect(await screen.findByText("DeepSeek Chat")).toBeInTheDocument();
  });

  it("forwards the admin model-settings action to the empty model chip", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/models/roles") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            brain: { provider: "", model: "", ready: false, eligible: false },
            light: { provider: "", model: "", ready: false, eligible: false },
            step: { provider: "", model: "", ready: false, inherit: true },
            plan_summary: { provider: "", model: "", ready: false, inherit: true },
            embedding: { provider: "auto", model: "", ready: true },
          }),
        });
      }
      if (url === "/api/providers") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ providers: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));
    const onOpenModelSettings = vi.fn();
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
        canConfigureModels
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Configure model" }));
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirmed model visible while a remounted composer refreshes", async () => {
    const view = renderWithLocale(
      <InputBar key="first" variant="empty" onSend={noop} connectionStatus="connected" queueCount={0} />,
    );
    expect(await screen.findByText("DeepSeek Chat")).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    const callsAfterFirstLoad = fetchMock.mock.calls.length;

    view.rerender(
      <InputBar key="second" variant="empty" onSend={noop} connectionStatus="connected" queueCount={0} />,
    );

    expect(screen.getByTestId("model-chip")).toHaveTextContent("DeepSeek Chat");
    expect(screen.getByTestId("model-chip").querySelector(".animate-spin")).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad);
  });

  it("shows a model list load error and retries the provider fetch", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/commands") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ commands: [] }),
        });
      }
      if (url === "/api/models/roles") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            brain: { provider: "deepseek", model: "deepseek-chat", ready: true },
            light: { provider: "deepseek", model: "deepseek-chat", ready: true },
            embedding: { provider: "auto", model: "", ready: true },
          }),
        });
      }
      if (url === "/api/providers") {
        providerCalls += 1;
        if (providerCalls === 1) return Promise.reject(new Error("provider request failed"));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            providers: [
              {
                id: "deepseek",
                name: "DeepSeek",
                apiType: "openai-compat",
                defaultModel: "deepseek-chat",
                hasKey: true,
                models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
              },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }));

    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
      />,
    );

    expect(await screen.findByText("Failed to load model list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(providerCalls).toBe(2));
    expect(await screen.findByText("DeepSeek Chat")).toBeInTheDocument();
  });

  it("renders the current permission level and patches only when a level is selected", async () => {
    const fetchMock = vi.mocked(fetch);
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
        sessionId="s1"
      />,
    );

    expect(await screen.findByText("Ask")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("permission-chip"), { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByText("Full access"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/permission-level",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ permission_level: "L3_FULL_ACCESS" }),
      }),
    ));
    expect(await screen.findByText("Full access")).toBeInTheDocument();
  });

  it("lets the active composer grow and then scroll for long input", async () => {
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
      />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 96 });
    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });

    await waitFor(() => expect(textarea.style.height).toBe("96px"));
    expect(textarea.style.overflowY).toBe("hidden");

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 180 });
    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree\nfour\nfive\nsix" } });

    await waitFor(() => expect(textarea.style.height).toBe("112px"));
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("shows an explicit stop square (not a spinner) while work is running", async () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={onSend}
        onCancel={onCancel}
        connectionStatus="connected"
        queueCount={0}
        isWorking
      />,
    );
    await screen.findByText("DeepSeek Chat");

    const stopButton = screen.getByTitle("Stop task");
    expect(stopButton.getAttribute("data-state")).toBe("working");
    // A stop action must read as a button, not a loading indicator.
    expect(stopButton.querySelector(".animate-spin")).toBeFalsy();
    expect(stopButton.querySelector("svg")).toBeTruthy();

    fireEvent.click(stopButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("acknowledges the stop click immediately and resets when the turn ends", async () => {
    const onCancel = vi.fn();
    const { rerender } = renderWithLocale(
      <InputBar
        variant="active"
        onSend={vi.fn()}
        onCancel={onCancel}
        connectionStatus="connected"
        queueCount={0}
        isWorking
      />,
    );
    await screen.findByText("DeepSeek Chat");

    fireEvent.click(screen.getByTitle("Stop task"));

    // Immediate feedback: the button flips to a disabled "Stopping…" spinner.
    const stopping = screen.getByTitle("Stopping…");
    expect(stopping.getAttribute("data-state")).toBe("cancelling");
    expect(stopping).toBeDisabled();
    expect(stopping.querySelector(".animate-spin")).toBeTruthy();

    // A second click while cancelling must not fire another cancel request.
    fireEvent.click(stopping);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Runtime confirms the turn is over → button returns to the send state.
    rerender(
      <InputBar
        variant="active"
        onSend={vi.fn()}
        onCancel={onCancel}
        connectionStatus="connected"
        queueCount={0}
        isWorking={false}
      />,
    );
    expect(screen.getByTitle("Send").getAttribute("data-state")).toBe("idle");
  });

  it("uploads a pasted image and sends it as an attachment", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/upload" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ files: [{ filename: "pasted-1.png", path: "/ws/uploads/pasted-1.png" }] }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    const onSend = vi.fn();
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={onSend}
        connectionStatus="connected"
        queueCount={0}
      />,
    );

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;
    const image = new File(["png-bytes"], "image.png", { type: "image/png" });
    fireEvent.paste(textarea, { clipboardData: { files: [image] } });

    // Chip shows the server-confirmed filename once the upload resolves.
    expect(await screen.findByText("pasted-1.png")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/upload", expect.objectContaining({ method: "POST" }));

    fireEvent.change(textarea, { target: { value: "what is in this image?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith(
      "what is in this image?",
      [{ filename: "pasted-1.png", path: "/ws/uploads/pasted-1.png" }],
    );
  });

  it("leaves plain-text paste alone (no upload request)", async () => {
    const fetchMock = vi.mocked(fetch);
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={noop}
        connectionStatus="connected"
        queueCount={0}
      />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;
    fireEvent.paste(textarea, { clipboardData: { files: [] } });

    expect(fetchMock).not.toHaveBeenCalledWith("/upload", expect.anything());
  });

  it("strips a block of trailing blank lines from pasted text", async () => {
    renderWithLocale(
      <InputBar variant="active" onSend={noop} connectionStatus="connected" queueCount={0} />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;
    fireEvent.paste(textarea, {
      clipboardData: { files: [], getData: () => "pasted content\n\n\n\n   \n" },
    });

    expect(textarea.value).toBe("pasted content");
  });

  it("does not submit a new message with Enter while work is running", async () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    renderWithLocale(
      <InputBar
        variant="active"
        onSend={onSend}
        onCancel={onCancel}
        connectionStatus="connected"
        queueCount={0}
        isWorking
      />,
    );
    await screen.findByText("DeepSeek Chat");

    const textarea = screen.getByPlaceholderText("Message MOZI...") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "next message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("window drag-and-drop attaches files (operator decision 2026-07-18)", () => {
  it("uploads dropped files through the same /upload path and shows the chip", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/upload") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ files: [{ filename: "notes.zip", path: "/ws/notes.zip", size: 10, mimeType: "application/zip" }] }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    renderWithLocale(
      <InputBar onSend={noop} connectionStatus="connected" queueCount={0} sessionId="s1" />,
    );

    const file = new File(["zipbytes"], "notes.zip", { type: "application/zip" });
    fireEvent.drop(window, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/upload", expect.objectContaining({ method: "POST" }));
    });
    await screen.findByText("notes.zip");
  });

  it("ignores drops another surface already handled (defaultPrevented)", async () => {
    const fetchMock = vi.mocked(fetch);
    renderWithLocale(
      <InputBar onSend={noop} connectionStatus="connected" queueCount={0} sessionId="s1" />,
    );

    const file = new File(["x"], "claimed.csv", { type: "text/csv" });
    const event = new Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { files: [file], types: ["Files"] } });
    event.preventDefault(); // FilesView-style zones claim their drops first
    window.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalledWith("/upload", expect.anything());
  });
});
