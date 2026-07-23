import { useCallback } from "react";

const BASE = "";

export function useApi() {
  const request = useCallback(async <T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ data: T | null; error: string | null }> => {
    try {
      const hasBody = body !== undefined;
      const requestBody = hasBody ? JSON.stringify(body) : undefined;
      const send = () => fetch(`${BASE}${path}`, {
          method,
          headers: hasBody ? { "Content-Type": "application/json" } : undefined,
          credentials: "include",
          body: requestBody,
        });
      let res = await send();
      if (res.status === 401 && await import("../lib/refresh-auth").then(({ refreshAccessToken }) => refreshAccessToken())) {
        res = await send();
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errorMessage = (errBody as Record<string, string>).message || (errBody as Record<string, string>).error;
        return { data: null, error: errorMessage || `HTTP ${res.status}` };
      }
      const data = await res.json() as T;
      return { data, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, []);

  const get = useCallback(<T = unknown>(path: string) => request<T>("GET", path), [request]);
  const post = useCallback(<T = unknown>(path: string, body?: unknown) => request<T>("POST", path, body), [request]);
  const put = useCallback(<T = unknown>(path: string, body?: unknown) => request<T>("PUT", path, body), [request]);
  const patch = useCallback(<T = unknown>(path: string, body?: unknown) => request<T>("PATCH", path, body), [request]);
  const del = useCallback(<T = unknown>(path: string) => request<T>("DELETE", path), [request]);

  return { get, post, put, patch, del };
}
