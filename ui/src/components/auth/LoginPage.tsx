import { useState } from "react";
import { Github, Loader2, Lock, Mail, User, UserPlus, LogIn } from "lucide-react";
import MoziAvatar from "@/components/MoziAvatar";
import { useLocale } from "@/i18n";

interface LoginPageProps {
  oauthProviders?: string[];
  authMode?: string;
  registrationPolicy?: "open" | "invite" | "closed";
  /** No local user exists yet — the first registrant becomes admin, no invite needed. */
  bootstrapAvailable?: boolean;
  onAuthenticated?: () => void | Promise<void>;
  onOAuthRedirect?: (provider: string) => void;
  error?: string | null;
}

/**
 * OAuth login page — dynamic buttons based on configured providers.
 * Supports Google, GitHub, and enterprise SSO flows.
 */
export default function LoginPage({
  oauthProviders = [],
  authMode = "token",
  registrationPolicy = "invite",
  bootstrapAvailable = false,
  onAuthenticated,
  onOAuthRedirect,
  error,
}: LoginPageProps) {
  const { t } = useLocale();
  const [loading, setLoading] = useState<string | null>(null);
  const [ssoEmail, setSsoEmail] = useState("");
  const [showSso, setShowSso] = useState(false);
  const [localMode, setLocalMode] = useState<"login" | "register">("login");
  const [localError, setLocalError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  const handleOAuth = (provider: string) => {
    setLoading(provider);
    if (onOAuthRedirect) {
      onOAuthRedirect(provider);
      return;
    }
    window.location.href = `/api/auth/oauth/authorize?provider=${encodeURIComponent(provider)}`;
  };

  const handleSsoSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ssoEmail.trim()) return;
    setLoading("sso");
    window.location.href = `/api/auth/saml/login?email=${encodeURIComponent(ssoEmail)}`;
  };

  const hasGoogle = oauthProviders.includes("google");
  const hasGithub = oauthProviders.includes("github");
  const hasAnyOAuth = oauthProviders.length > 0;
  const isLocal = authMode === "local";
  // The first registrant bootstraps as admin server-side — never demand an
  // invite code (or block on a closed policy) from them.
  const inviteRequired = registrationPolicy === "invite" && !bootstrapAvailable;
  const registrationClosed = registrationPolicy === "closed" && !bootstrapAvailable;

  const handleLocalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (localMode === "register") {
      if (registrationClosed) {
        setLocalError(t("auth.local.registrationClosed"));
        return;
      }
      if (password !== confirmPassword) {
        setLocalError(t("auth.local.passwordMismatch"));
        return;
      }
    }

    setLoading(localMode);
    try {
      const res = await fetch(localMode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localMode === "login"
          ? { email, password }
          : {
              name,
              email,
              password,
              ...(inviteRequired ? { invite_code: inviteCode } : {}),
            }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setLocalError(body.error ?? t("auth.local.genericError"));
        return;
      }

      if (onAuthenticated) {
        await onAuthenticated();
      } else {
        window.location.reload();
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("auth.local.genericError"));
    } finally {
      setLoading(null);
    }
  };

  if (isLocal) {
    const registering = localMode === "register";
    const submitDisabled = Boolean(loading)
      || !email.trim()
      || !password
      || (registering && (!name.trim() || !confirmPassword || (inviteRequired && !inviteCode.trim())));

    return (
      <div className="min-h-screen flex items-center justify-center bg-base px-4">
        <div className="card-surface p-8 w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="mx-auto mb-3 flex justify-center">
              <MoziAvatar size={48} />
            </div>
            <h1 className="text-xl font-bold">{t("app.productName")}</h1>
            <p className="text-sm text-ink/50 mt-1">{t("auth.login.continue")}</p>
          </div>

          <div className="grid grid-cols-2 rounded-card border border-ink/[0.08] bg-ink/[0.03] p-1 mb-5">
            <button
              type="button"
              onClick={() => { setLocalMode("login"); setLocalError(null); }}
              className={`h-9 rounded-card text-sm font-medium transition-colors ${!registering ? "bg-elevated text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}
            >
              {t("auth.local.loginTab")}
            </button>
            <button
              type="button"
              onClick={() => { setLocalMode("register"); setLocalError(null); }}
              className={`h-9 rounded-card text-sm font-medium transition-colors ${registering ? "bg-elevated text-ink shadow-sm" : "text-ink/55 hover:text-ink"}`}
            >
              {t("auth.local.registerTab")}
            </button>
          </div>

          {(error || localError) && (
            <div className="mb-4 px-3 py-2 rounded bg-error/10 border border-error/30 text-xs text-error">
              {localError ?? error}
            </div>
          )}

          {registering && bootstrapAvailable && (
            <div className="mb-4 px-3 py-2 rounded bg-selection/10 border border-selection/25 text-xs text-ink/70">
              {t("auth.local.bootstrapHint")}
            </div>
          )}

          {registering && registrationClosed ? (
            <div className="text-sm text-ink/60">{t("auth.local.registrationClosed")}</div>
          ) : (
            <form onSubmit={handleLocalSubmit} className="space-y-3">
              {registering && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink/55">{t("auth.local.name")}</span>
                  <div className="relative">
                    <User size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35" />
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("auth.local.namePlaceholder")}
                      className="input-field pl-9"
                      autoComplete="name"
                    />
                  </div>
                </label>
              )}

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink/55">{t("auth.local.email")}</span>
                <div className="relative">
                  <Mail size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("auth.login.emailPlaceholder")}
                    className="input-field pl-9"
                    autoComplete="email"
                  />
                </div>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink/55">{t("auth.local.password")}</span>
                <div className="relative">
                  <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("auth.local.passwordPlaceholder")}
                    className="input-field pl-9"
                    autoComplete={registering ? "new-password" : "current-password"}
                  />
                </div>
              </label>

              {registering && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink/55">{t("auth.local.confirmPassword")}</span>
                  <div className="relative">
                    <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35" />
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder={t("auth.local.confirmPasswordPlaceholder")}
                      className="input-field pl-9"
                      autoComplete="new-password"
                    />
                  </div>
                </label>
              )}

              {registering && inviteRequired && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink/55">{t("auth.local.inviteCode")}</span>
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder={t("auth.local.invitePlaceholder")}
                    className="input-field"
                    autoComplete="one-time-code"
                  />
                </label>
              )}

              <button
                type="submit"
                disabled={submitDisabled}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                {loading === localMode ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : registering ? (
                  <UserPlus size={15} />
                ) : (
                  <LogIn size={15} />
                )}
                {registering ? t("auth.local.createAccount") : t("auth.local.signIn")}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-base">
      <div className="card-surface p-8 w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="mx-auto mb-3 flex justify-center">
            <MoziAvatar size={48} />
          </div>
          <h1 className="text-xl font-bold">{t("app.productName")}</h1>
          <p className="text-sm text-ink/50 mt-1">{t("auth.login.continue")}</p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded bg-error/10 border border-error/30 text-xs text-error">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {/* Google */}
          {hasGoogle && (
            <button
              onClick={() => handleOAuth("google")}
              disabled={!!loading}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-card bg-ink/[0.06] hover:bg-ink/[0.09] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {loading === "google" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <GoogleIcon />
              )}
              {t("auth.login.google")}
            </button>
          )}

          {/* GitHub */}
          {hasGithub && (
            <button
              onClick={() => handleOAuth("github")}
              disabled={!!loading}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-card bg-ink/[0.06] hover:bg-ink/[0.09] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {loading === "github" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Github size={16} />
              )}
              {t("auth.login.github")}
            </button>
          )}

          {/* Divider — only show if there are OAuth buttons above */}
          {hasAnyOAuth && (
            <div className="relative flex items-center gap-3 py-1">
              <div className="flex-1 h-px bg-ink/[0.08]" />
              <span className="text-xs text-ink/30">{t("auth.login.or")}</span>
              <div className="flex-1 h-px bg-ink/[0.08]" />
            </div>
          )}

          {/* Enterprise SSO */}
          {showSso ? (
            <form onSubmit={handleSsoSubmit} className="space-y-2">
              <input
                type="email"
                value={ssoEmail}
                onChange={(e) => setSsoEmail(e.target.value)}
                placeholder={t("auth.login.emailPlaceholder")}
                className="input-field text-sm"
                autoFocus
              />
              <button
                type="submit"
                disabled={!ssoEmail.trim() || loading === "sso"}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                {loading === "sso" && <Loader2 size={14} className="animate-spin" />}
                {t("auth.login.sso")}
              </button>
            </form>
          ) : (
            <button
              onClick={() => setShowSso(true)}
              className="w-full text-sm text-ink/50 hover:text-ink/80 transition-colors py-1"
            >
              {t("auth.login.enterpriseSso")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.2a10.34 10.34 0 0 0-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.614z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}
