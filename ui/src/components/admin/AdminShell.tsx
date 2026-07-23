import { useState } from "react";
import { ArrowLeft, BarChart3, FileText, Users, type LucideIcon } from "lucide-react";
import type { AuthUser } from "@/hooks/useAuth";
import { useLocale, type MessageKey } from "@/i18n";
import type { AdminSection } from "./types";
import AdminView from "./AdminView";

interface AdminShellProps {
  currentUser: AuthUser | null;
  onBackToWorkspace: () => void;
}

const ADMIN_SECTIONS: Array<{ key: AdminSection; labelKey: MessageKey; icon: LucideIcon }> = [
  { key: "users", labelKey: "admin.shell.nav.users", icon: Users },
  { key: "audit", labelKey: "admin.shell.nav.audit", icon: FileText },
  { key: "usage", labelKey: "admin.shell.nav.usage", icon: BarChart3 },
];

export default function AdminShell({ currentUser, onBackToWorkspace }: AdminShellProps) {
  const { t } = useLocale();
  const [section, setSection] = useState<AdminSection>("users");

  return (
    <div
      data-testid="admin-shell"
      className="flex h-screen min-h-0 w-full flex-col overflow-hidden bg-base"
      style={{ background: "var(--surface-base)", color: "var(--text-primary)" }}
    >
      <header
        data-testid="admin-header"
        className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-4"
        style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--sidebar-bg)" }}
      >
        <button
          type="button"
          onClick={onBackToWorkspace}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.045]"
          style={{ color: "var(--text-secondary)" }}
          title={t("admin.shell.backToWorkspace")}
          aria-label={t("admin.shell.backToWorkspace")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 items-center">
          <h1 className="truncate text-[15px] font-semibold tracking-normal text-ink/82">
            {t("admin.shell.title")}
          </h1>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="w-[224px] shrink-0 overflow-y-auto px-3 py-4"
          style={{ borderRight: "1px solid var(--border-subtle)", background: "var(--sidebar-bg)" }}
        >
          <nav className="flex flex-col gap-1" aria-label={t("admin.shell.title")}>
            {ADMIN_SECTIONS.map((item) => {
              const active = section === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-admin-category={item.key}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setSection(item.key)}
                  className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors"
                  style={{
                    background: active ? "var(--surface-active)" : "transparent",
                    color: active ? "var(--text-primary)" : "rgb(var(--ink-rgb) / 0.58)",
                  }}
                >
                  <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="min-w-0 truncate">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ background: "var(--main-bg)" }}
        >
          <AdminView currentUser={currentUser} section={section} />
        </main>
      </div>
    </div>
  );
}
