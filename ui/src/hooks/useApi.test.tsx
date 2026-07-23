import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApi } from "./useApi";

function res(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useApi authentication recovery", () => {
  it("refreshes an expired access token and retries the original request once", async () => {
    let templateCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/task-templates") {
        templateCalls += 1;
        return Promise.resolve(templateCalls === 1
          ? res(401, { error: "Authentication required" })
          : res(200, { templates: [{ id: "task-1" }] }));
      }
      if (url === "/api/auth/refresh") return Promise.resolve(res(200, { success: true }));
      return Promise.resolve(res(404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    let response: Awaited<ReturnType<typeof result.current.get>> | undefined;
    await act(async () => { response = await result.current.get("/api/task-templates"); });

    expect(response).toEqual({ data: { templates: [{ id: "task-1" }] }, error: null });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/task-templates", "/api/auth/refresh", "/api/task-templates",
    ]);
  });

  it("shares one refresh across concurrent unauthorized requests", async () => {
    let resolveRefresh!: (value: ReturnType<typeof res>) => void;
    const refreshResponse = new Promise<ReturnType<typeof res>>((resolve) => { resolveRefresh = resolve; });
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/auth/refresh") return refreshResponse;
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return Promise.resolve(attempt === 1 ? res(401) : res(200, { ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    let responses: unknown[] = [];
    await act(async () => {
      const pending = Promise.all([result.current.get("/api/task-templates"), result.current.get("/api/config")]);
      await Promise.resolve();
      resolveRefresh(res(200, { success: true }));
      responses = await pending;
    });

    expect(responses).toEqual([
      { data: { ok: true }, error: null },
      { data: { ok: true }, error: null },
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/auth/refresh")).toHaveLength(1);
  });

  it("surfaces the original error without retrying when refresh fails", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(url === "/api/auth/refresh"
      ? res(401, { error: "Invalid refresh token" })
      : res(401, { error: "Authentication required" })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    let response: Awaited<ReturnType<typeof result.current.get>> | undefined;
    await act(async () => { response = await result.current.get("/api/task-templates"); });

    expect(response).toEqual({ data: null, error: "Authentication required" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never enters a refresh loop when the retried request is still unauthorized", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(url === "/api/auth/refresh"
      ? res(200, { success: true })
      : res(401, { error: "Still unauthorized" })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    let response: Awaited<ReturnType<typeof result.current.get>> | undefined;
    await act(async () => { response = await result.current.get("/api/task-templates"); });

    expect(response).toEqual({ data: null, error: "Still unauthorized" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/auth/refresh")).toHaveLength(1);
  });
});
