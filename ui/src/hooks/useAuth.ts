import { useState, useCallback, useEffect, useRef } from "react";

/**
 * Auth states:
 *   loading     → checking session (httpOnly cookie)
 *   login       → not authenticated, show LoginPage
 *   onboarding  → authenticated but setup incomplete
 *   ready       → fully authenticated and configured
 */
type AuthState = "loading" | "login" | "onboarding" | "ready";

interface AuthStatus {
  authenticated: boolean;
  onboarding_done?: boolean;
  oauth_providers?: string[];
  auth_mode?: string;
  registration_policy?: "open" | "invite" | "closed";
  /** True while no local user exists yet — the first registrant becomes admin without an invite. */
  bootstrap_available?: boolean;
}

export interface AuthUser {
  id: string;
  tenant_id: string;
  email?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  role?: "admin" | "operator" | "viewer";
  status?: "active" | "disabled";
}

const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // proactively refresh well inside the 15-min access-token window

export function useAuth() {
  const [state, setState] = useState<AuthState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [authMode, setAuthMode] = useState<string>("token");
  const [registrationPolicy, setRegistrationPolicy] = useState<"open" | "invite" | "closed">("invite");
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // Core check: server reads httpOnly cookie, no localStorage token
  // -------------------------------------------------------------------------

  const stopRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const loadUserProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/users/me", { credentials: "include" });
      if (!res.ok) {
        setUser(null);
        return;
      }
      const data = await res.json() as { user?: AuthUser };
      setUser(data.user ?? null);
    } catch {
      setUser(null);
    }
  }, []);

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const statusRes = await fetch("/api/auth/status", { credentials: "include" });
        if (statusRes.ok) {
          const status = await statusRes.json() as AuthStatus;
          setOauthProviders(status.oauth_providers ?? []);
          setAuthMode(status.auth_mode ?? "token");
          setRegistrationPolicy(status.registration_policy ?? "invite");
          setBootstrapAvailable(status.bootstrap_available === true);
          if (status.authenticated) {
            if (status.onboarding_done) await loadUserProfile();
            setState(status.onboarding_done ? "ready" : "onboarding");
            return true;
          }
        }
        setUser(null);
        setState("login");
        stopRefresh();
        return false;
      }
      return true;
    } catch {
      setUser(null);
      setState("login");
      stopRefresh();
      return false;
    }
  }, [loadUserProfile, stopRefresh]);

  const scheduleRefresh = useCallback(() => {
    stopRefresh();
    refreshTimerRef.current = setInterval(async () => {
      await refreshToken();
    }, REFRESH_INTERVAL_MS);
  }, [refreshToken, stopRefresh]);

  const checkAuth = useCallback(async () => {
    try {
      // One silent-refresh retry: on cold start the short-lived access cookie
      // is usually gone, but a valid refresh cookie may still exist. Try
      // /api/auth/refresh once before concluding the user must log in again.
      let triedRefresh = false;
      for (;;) {
        const res = await fetch("/api/auth/status", { credentials: "include" });
        if (!res.ok) { setState("login"); return; }

        const data = await res.json() as AuthStatus;
        setOauthProviders(data.oauth_providers ?? []);
        setAuthMode(data.auth_mode ?? "token");
        setRegistrationPolicy(data.registration_policy ?? "invite");
        setBootstrapAvailable(data.bootstrap_available === true);
        if (!data.authenticated) {
          if (!triedRefresh) {
            triedRefresh = true;
            const refreshed = await fetch("/api/auth/refresh", {
              method: "POST",
              credentials: "include",
            }).catch(() => null);
            if (refreshed?.ok) continue;
          }
          setUser(null); setState("login"); return;
        }
        if (!data.onboarding_done) { setState("onboarding"); return; }

        await loadUserProfile();
        setState("ready");
        scheduleRefresh();
        return;
      }
    } catch {
      setUser(null);
      setState("login");
    }
  }, [loadUserProfile, scheduleRefresh]);

  // -------------------------------------------------------------------------
  // OAuth callback — called after provider redirects back with ?code=&state=
  // -------------------------------------------------------------------------

  const handleOAuthCallback = useCallback(async (code: string, oauthState: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch("/api/auth/oauth/callback", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state: oauthState }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Authentication failed");
        return false;
      }
      await checkAuth();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [checkAuth]);

  // -------------------------------------------------------------------------
  // Onboarding + logout
  // -------------------------------------------------------------------------

  const completeOnboarding = useCallback(() => {
    void loadUserProfile();
    setState("ready");
    scheduleRefresh();
  }, [loadUserProfile, scheduleRefresh]);

  const logout = useCallback(async () => {
    stopRefresh();
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch { /* ignore network errors on logout */ }
    setUser(null);
    setState("login");
  }, [stopRefresh]);

  // -------------------------------------------------------------------------
  // Init: handle OAuth redirect params, then check session
  // -------------------------------------------------------------------------

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthState = params.get("state");

    if (code && oauthState) {
      window.history.replaceState({}, "", window.location.pathname);
      handleOAuthCallback(code, oauthState);
    } else {
      checkAuth();
    }

    return () => stopRefresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    error,
    oauthProviders,
    authMode,
    registrationPolicy,
    bootstrapAvailable,
    user,
    completeOnboarding,
    handleOAuthCallback,
    refreshAuth: checkAuth,
    logout,
  };
}
