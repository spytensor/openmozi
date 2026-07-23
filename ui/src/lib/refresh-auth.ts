let pendingRefresh: Promise<boolean> | null = null;

export function refreshAccessToken(): Promise<boolean> {
  if (!pendingRefresh) {
    pendingRefresh = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        pendingRefresh = null;
      });
  }
  return pendingRefresh;
}
