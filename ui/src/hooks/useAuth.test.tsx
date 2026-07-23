import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./useAuth";

type MockResponse = { ok: boolean; json: () => Promise<unknown> };

function res(ok: boolean, body: unknown = {}): MockResponse {
  return { ok, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function refreshCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/auth/refresh").length;
}

describe("useAuth cold-start silent refresh", () => {
  it("recovers the session via /api/auth/refresh when status says unauthenticated", async () => {
    let statusCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/auth/status") {
        statusCalls += 1;
        return Promise.resolve(res(true, statusCalls === 1
          ? { authenticated: false, auth_mode: "local" }
          : { authenticated: true, onboarding_done: true, auth_mode: "local" }));
      }
      if (url === "/api/auth/refresh") return Promise.resolve(res(true, { success: true }));
      if (url === "/api/users/me") return Promise.resolve(res(true, { user: { id: "u1", tenant_id: "default", email: "a@b.c" } }));
      return Promise.resolve(res(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(refreshCalls(fetchMock)).toBe(1);
    expect(result.current.user?.id).toBe("u1");
    unmount();
  });

  it("falls back to the login page when the silent refresh fails, without retry loops", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/auth/status") {
        return Promise.resolve(res(true, { authenticated: false, auth_mode: "local" }));
      }
      if (url === "/api/auth/refresh") return Promise.resolve(res(false, { success: false }));
      return Promise.resolve(res(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.state).toBe("login"));
    expect(refreshCalls(fetchMock)).toBe(1);
    unmount();
  });

  it("does not call refresh at all when the access token is still valid", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/auth/status") {
        return Promise.resolve(res(true, { authenticated: true, onboarding_done: true, auth_mode: "local" }));
      }
      if (url === "/api/users/me") return Promise.resolve(res(true, { user: { id: "u1", tenant_id: "default" } }));
      return Promise.resolve(res(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(refreshCalls(fetchMock)).toBe(0);
    unmount();
  });
});
