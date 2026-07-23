import { describe, expect, it } from "vitest";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import {
  defaultRuntimeProjectRoot,
  runtimeFolderRoots,
  runtimeProjectRoots,
  runtimeBrowsableProjectRoots,
  runtimeRootHint,
  runtimeRootLabel,
  workspaceContextFromRoot,
} from "@/lib/runtime-display";

const roots: RuntimeWorkspaceRoot[] = [
  {
    id: "home",
    kind: "mozi_home",
    label: "Runtime home",
    path: "/tmp/mozi",
    exists: true,
    git: { is_repo: false },
  },
  {
    id: "workspace",
    kind: "workspace",
    label: "Workspace",
    path: "/tmp/mozi/workspace",
    exists: true,
    git: { is_repo: false },
  },
  {
    id: "source",
    kind: "project_root",
    label: "Runtime source",
    path: "/Users/me/Mozi",
    exists: true,
    git: { is_repo: true, branch: "codex/mozi-lovable-v1-runtime-workspace" },
  },
  {
    id: "allowed",
    kind: "allowed_root",
    label: "Allowed root",
    path: "/Users/me/project",
    exists: true,
    git: { is_repo: true, branch: "main" },
  },
];

describe("runtime-display", () => {
  it("translates runtime root kinds into user-facing labels", () => {
    expect(runtimeRootLabel(roots[0])).toBe("Runtime Home");
    expect(runtimeRootLabel(roots[1])).toBe("Workspace");
    expect(runtimeRootLabel(roots[2])).toBe("Runtime Source");
    expect(runtimeRootLabel(roots[3])).toBe("Allowed Root");
    expect(runtimeRootLabel(roots[2], "zh-CN")).toBe("运行时源码");
  });

  it("derives concise hints without exposing internal run jargon", () => {
    expect(runtimeRootHint(roots[0])).toBe("mozi");
    expect(runtimeRootHint(roots[2])).toBe("codex/mozi-lovable-v1-runtime-workspace");
    expect(runtimeRootHint({ ...roots[3], exists: false })).toBe("missing");
  });

  it("classifies project and folder roots from runtime data", () => {
    expect(runtimeProjectRoots(roots).map((root) => root.id)).toEqual(["source", "allowed"]);
    // mozi_home (~/.mozi) is config/runtime state, deliberately NOT offered
    // as a selectable work folder (see runtimeFolderRoots).
    expect(runtimeFolderRoots(roots).map((root) => root.id)).toEqual(["workspace", "allowed"]);
  });

  it("uses the runtime source as the default project when project mode is enabled", () => {
    expect(defaultRuntimeProjectRoot(roots)?.id).toBe("source");
    expect(defaultRuntimeProjectRoot(roots.filter((root) => root.id !== "source"))?.id).toBe("allowed");
    expect(defaultRuntimeProjectRoot(roots.filter((root) => !root.git?.is_repo && root.kind !== "project_root"))).toBeNull();
  });

  it("excludes non-browsable project roots from the Files scope but keeps them for the composer", () => {
    const withRuntimeSource: RuntimeWorkspaceRoot[] = [
      { id: "workspace", kind: "workspace", label: "Workspace", path: "/ws", exists: true, browsable: true },
      { id: "runtime", kind: "project_root", label: "Runtime source", path: "/app/dist", exists: true, browsable: false },
      { id: "openmozi-demo", kind: "project_root", label: "OpenMoziDemo", path: "/Users/me/OpenMoziDemo", exists: true, browsable: true, git: { is_repo: true, branch: "main" } },
    ];
    // Composer keeps every project root (context only).
    expect(runtimeProjectRoots(withRuntimeSource).map((root) => root.id)).toEqual(["runtime", "openmozi-demo"]);
    // Files drops the non-browsable runtime source.
    expect(runtimeBrowsableProjectRoots(withRuntimeSource).map((root) => root.id)).toEqual(["openmozi-demo"]);
  });

  it("builds the WebSocket workspace context from the selected root", () => {
    expect(workspaceContextFromRoot(roots[2])).toEqual({
      rootPath: "/Users/me/Mozi",
      rootKind: "project_root",
      label: "Runtime source",
      gitBranch: "codex/mozi-lovable-v1-runtime-workspace",
    });
  });
});
