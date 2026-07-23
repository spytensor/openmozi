import type { RuntimeWorkspaceRoot, WorkspaceMessageContext } from "@/types/runtime";
import { DEFAULT_LOCALE, translateMessage, type Locale } from "@/i18n";

export function pathLeaf(path: string): string {
  const clean = path.split("/").filter(Boolean);
  return clean.at(-1) ?? path;
}

export function runtimeRootLabel(root: RuntimeWorkspaceRoot, locale: Locale = DEFAULT_LOCALE): string {
  if (root.kind === "mozi_home") return translateMessage(locale, "root.moziHome");
  if (root.kind === "output") return translateMessage(locale, "root.deliverables");
  if (root.kind === "workspace") return translateMessage(locale, "root.workspace");
  if (root.kind === "project_root") {
    const label = root.label.toLowerCase();
    if (label === "runtime source" || label === "mozi source") return translateMessage(locale, "root.moziSource");
    return root.label || translateMessage(locale, "root.projectFallback");
  }
  if (root.kind === "allowed_root" && root.label.toLowerCase().startsWith("allowed root")) {
    return translateMessage(locale, "root.allowedRoot");
  }
  return root.label || pathLeaf(root.path);
}

export function runtimeRootHint(root: RuntimeWorkspaceRoot, locale: Locale = DEFAULT_LOCALE): string {
  if (!root.exists) return translateMessage(locale, "root.missing");
  if (root.git?.branch) return root.git.branch;
  if (root.git?.is_repo) return translateMessage(locale, "root.git");
  return pathLeaf(root.path) || translateMessage(locale, "root.folder");
}

export function runtimeProjectRoots(roots: RuntimeWorkspaceRoot[]): RuntimeWorkspaceRoot[] {
  return roots.filter((root) => root.kind === "project_root" || root.git?.is_repo);
}

/**
 * Project roots the Files surface can actually browse. The composer carries a
 * root only as message context, so it offers every project root; Files LISTS a
 * root, so it must exclude any the file API can't serve (e.g. the runtime
 * source dir, which in a packaged build points at app internals). Older
 * snapshots omit `browsable` — treat missing as browsable to avoid hiding a
 * genuine granted project.
 */
export function runtimeBrowsableProjectRoots(roots: RuntimeWorkspaceRoot[]): RuntimeWorkspaceRoot[] {
  return runtimeProjectRoots(roots).filter((root) => root.browsable !== false);
}

export function defaultRuntimeProjectRoot(roots: RuntimeWorkspaceRoot[]): RuntimeWorkspaceRoot | null {
  const projects = runtimeProjectRoots(roots);
  return projects.find((root) => root.kind === "project_root")
    ?? projects.find((root) => root.git?.is_repo)
    ?? null;
}

export function runtimeFolderRoots(roots: RuntimeWorkspaceRoot[]): RuntimeWorkspaceRoot[] {
  // MOZI's own home (~/.mozi) is config/runtime state, not a user work folder —
  // don't offer it as a selectable project scope. The output shelf is where
  // finished work is DELIVERED, not a folder to work inside — it browses in
  // Files but is not a chat scope.
  return roots.filter((root) => root.kind !== "project_root" && root.kind !== "mozi_home" && root.kind !== "output");
}

export function workspaceContextFromRoot(root: RuntimeWorkspaceRoot): WorkspaceMessageContext {
  return {
    rootPath: root.path,
    rootKind: root.kind,
    label: root.label || pathLeaf(root.path),
    gitBranch: root.git?.branch,
  };
}
