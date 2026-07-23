# Runtime Sandbox Findings

Last checked: 2026-07-04.

This is a fact-gathering note for a later decision record. It compares delivery
and isolation options without choosing one.

## Repo-Verified Baseline

- MOZI is a Node/TypeScript Fastify runtime that serves the built React UI from
  `ui/dist` when present and defaults to port `9210`
  (`src/index.ts`, `src/config/index.ts`, `Dockerfile`, `docker-compose.yml`).
- Current filesystem tools enforce `tools.fs.workspace_only` in code by
  resolving requested paths against `workspace.dir` plus
  `tools.fs.additional_allowed_roots` (`src/tools/workspace-policy.ts`,
  `src/tools/tool-utils.ts`, `src/tools/fs-tools.ts`). This is not OS isolation.
- Current shell tools run through `sh -c` by default. The workspace boundary is
  best-effort command-string inspection plus optional restricted allow/block
  lists. The code explicitly says this is not a sandbox
  (`src/capabilities/shell.ts`).
- There is already an optional Docker shell executor path using `docker run
  --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only`
  with tmpfs mounts and a bind-mounted cwd, but it is not the universal runtime
  execution boundary (`src/capabilities/shell.ts`).
- Native dependency facts from this checkout: `better-sqlite3@12.6.2`,
  `@lancedb/lancedb@0.27.0`; `pnpm-lock.yaml` pins LanceDB native packages by
  OS/CPU/libc, and `better-sqlite3@12.6.2` declares Node engines `20.x || 22.x ||
  23.x || 24.x || 25.x`. Local Node observations: Homebrew node@22 is
  `v22.23.1` with `NODE_MODULE_VERSION=127`; the default `node` on this machine
  is `v26.0.0` with `NODE_MODULE_VERSION=147`.
- Existing desktop packaging is Electron, not Tauri. It already demonstrates the
  sidecar pattern: stage a pinned Node distribution (`22.21.1` in
  `scripts/stage-desktop-node.mjs`), stage production `node_modules`, and
  supervise `dist/index.js` on localhost (`desktop/src/supervisor.ts`).
  Current staged resource sizes on this machine: `desktop/resources/node` about
  18 MB, `desktop/resources/mozi` about 616 MB, and production
  `desktop/resources/mozi/node_modules` about 606 MB. LanceDB's darwin-arm64
  `.node` file is about 92 MB; `better-sqlite3`'s built `.node` file is about
  1.8 MB.

## Option A - Docker Whole Runtime

Containerized runtime: the user runs the whole MOZI server in a container; agent
shell/fs are confined to the container plus explicitly mounted host folders.

1. **Sandbox/isolation model actually available**

   Docker gives OS-level isolation on Linux through namespaces, cgroups, mount
   namespaces, Linux capabilities, seccomp, user namespaces, read-only roots,
   tmpfs, and Docker network modes. Docker's docs state that `--network none`
   gives a container only loopback networking, the default seccomp profile is an
   allowlist that denies system calls by default, and resource limits are
   explicit because containers otherwise have no default resource ceiling
   ([none network](https://docs.docker.com/engine/network/drivers/none/),
   [seccomp](https://docs.docker.com/engine/security/seccomp/),
   [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)).

   If the whole MOZI server runs in one container, `shell_exec` and filesystem
   tools are confined by that container's mount namespace and Linux kernel
   controls. Unmounted host paths are not visible. However, the container still
   needs outbound network for LLM providers unless network isolation is split by
   tool call; whole-container `--network none` is incompatible with normal MOZI
   online use. Do not mount the Docker socket into this container.

2. **Granting access to local folders**

   Folder grants are bind mounts. Docker bind mounts can be read-write or
   read-only via `readonly`/`ro`, and the source path is a host path on the
   Docker daemon host ([bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)).
   This maps cleanly to `workspace_only + additional_allowed_roots` if MOZI
   records container-visible paths, for example `/workspace` and
   `/allowed/<name>`, rather than raw host paths. A small host-to-container path
   mapping layer is required for UI display and diagnostics.

3. **Packaging Node22 + native deps**

   Feasible and already close to the repo's `Dockerfile`: build on
   `node:22-slim`, install production deps inside the image, and run
   `node dist/index.js`. This pins the Node ABI inside the image and removes
   host Node 26/22 drift from the runtime. Multi-arch images need separate
   builds for `linux/amd64` and `linux/arm64`; LanceDB publishes Linux GNU and
   musl native packages in the current lockfile. Code signing/notarization is
   not a macOS app concern, but image signing/SBOM/provenance may matter for
   enterprise distribution.

   Approximate size: hundreds of MB compressed, potentially larger uncompressed,
   driven by production `node_modules` and LanceDB. The existing desktop
   production resources are about 616 MB uncompressed, which is a useful upper
   bound before Docker layer compression and pruning.

4. **Cross-platform and enterprise fit**

   Runtime image is Linux-first and deployable on Linux servers, Docker Desktop
   on macOS/Windows, or Kubernetes/Compose. Docker Desktop for Mac currently
   supports the current and two previous macOS major versions and requires a
   paid subscription for larger enterprises or government use
   ([Docker Desktop Mac install](https://docs.docker.com/desktop/setup/install/mac-install/)).
   This is the strongest fit for future multi-user/server deployment, but the
   weakest "native local app" UX unless paired with a desktop wrapper.

5. **Effort / biggest risk**

   Effort: **S/M**. The repo already has a `Dockerfile`, `docker-compose.yml`,
   and an optional per-shell Docker executor. A CLI/Compose v1 is small; a
   polished local-folder-grant UX is medium.

   Biggest risk: user experience and path semantics. Users think in host paths,
   while the runtime must operate on mounted container paths. Network policy is
   also nuanced because the server needs network while untrusted shell calls may
   need less.

6. **Current architecture interaction**

   Fastify + built UI survives almost as-is. The watchdog can stay inside the
   container, but Docker restart policy overlaps with it. `workspace_only` should
   move from "primary protection" to "defense in depth" over container mount
   visibility.

## Option B - Tauri v2 Desktop App

Rust shell + system WebView; Node backend as a sidecar binary; OS-level
sandbox/entitlements where available.

1. **Sandbox/isolation model actually available**

   Tauri v2 capabilities and permissions constrain which frontend windows or
   WebViews may call Tauri core/plugin APIs. Tauri's own docs say capabilities
   minimize frontend compromise impact but do not protect against malicious Rust
   code, lax scopes, or intentional bypasses from Rust
   ([capabilities](https://v2.tauri.app/security/capabilities/)).

   That means Tauri's capability system does **not** by itself confine MOZI's
   Node sidecar, `shell_exec`, or Node filesystem code. It confines frontend IPC
   to Tauri APIs. To confine `shell_exec`/fs, MOZI still needs an OS sandbox for
   the sidecar or a separate per-tool sandbox such as Docker/seatbelt. On macOS,
   App Sandbox can be applied to the Tauri app, but the exact sidecar inheritance
   and entitlements must be verified under signing/notarization. On Windows and
   Linux, equivalent OS sandboxing is not provided by Tauri as a single portable
   feature.

2. **Granting access to local folders**

   Tauri's filesystem plugin has allow/scope permissions for app, document,
   downloads, home, temp, and other base directories
   ([filesystem plugin](https://v2.tauri.app/plugin/file-system/)). These scopes
   protect the Tauri frontend/plugin path, not the Node backend. A practical v1
   would use a Tauri dialog to choose a folder, persist that grant in MOZI
   config, and pass it to Node as `additional_allowed_roots`. That maps well to
   MOZI's current model as code-level policy, but OS-level enforcement still
   depends on a sidecar sandbox or per-tool sandbox.

3. **Packaging Node22 + native deps**

   Feasible. Tauri supports external binaries/sidecars via `bundle.externalBin`,
   with one binary per target triple
   ([embedding external binaries](https://v2.tauri.app/develop/sidecar/)). Tauri
   also has a "Node.js as a sidecar" guide, but it packages a Node app into a
   self-contained binary and notes that the guide is desktop-only
   ([Node.js sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)). For MOZI,
   the safer ABI story is to bundle a pinned Node 22 runtime plus production
   `node_modules`, matching the existing Electron staging pattern, rather than
   relying on the user's Node.

   Code signing/notarization is required for a production macOS installer.
   Tauri's macOS signing docs include notarization through Apple credentials
   ([macOS signing](https://v2.tauri.app/distribute/sign/macos/)). Windows code
   signing is a separate pipeline. Approximate bundle size will be dominated by
   the same Node runtime and native modules as the current desktop resources, so
   expect hundreds of MB uncompressed unless dependencies are pruned.

4. **Cross-platform and enterprise fit**

   Tauri capabilities can target `linux`, `macOS`, `windows`, `iOS`, and
   `android`, but the Node sidecar pattern in the official guide is desktop-only
   ([capabilities target platforms](https://v2.tauri.app/security/capabilities/),
   [Node.js sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)). This fits a
   cross-platform local desktop app better than Swift. It is less natural than
   Docker for multi-user/server one-click deployment; enterprise deployment
   becomes per-device app distribution plus update/signing infrastructure.

5. **Effort / biggest risk**

   Effort: **M/L**. Prototype effort is medium because the existing Electron
   supervisor already proves the shape. Production effort is large once signing,
   sidecar ABI pinning, update flow, and real sandboxing are included.

   Biggest risk: confusing Tauri API scopes with actual Node/tool isolation. The
   Node sidecar remains the security-critical runtime and must be sandboxed
   separately.

6. **Current architecture interaction**

   Fastify + built UI survives. Tauri can open the built UI from the local
   Fastify server or embed static assets and proxy to the backend. The current
   watchdog can remain initially, but a Rust supervisor would likely replace or
   wrap desktop process management.

## Option C - Swift/Native macOS App + launchd Service

Thin WKWebView window; Node server as a launchd-managed background service;
sandbox via macOS App Sandbox / seatbelt profiles.

1. **Sandbox/isolation model actually available**

   macOS App Sandbox is the supported Apple mechanism for limiting app access
   to system resources and user data through entitlements
   ([App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)).
   Apple documents the user-selected read-write entitlement as granting access
   to files selected using Open/Save dialogs
   ([user-selected read-write entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.files.user-selected.read-write)).

   `launchd` is a supervisor, not a sandbox. Local `launchd.plist(5)` supports
   keys such as `ProgramArguments`, `KeepAlive`, `UserName`, `RootDirectory`,
   `EnvironmentVariables`, and resource limits, but the checked man page does
   not expose a supported per-job sandbox profile key. If Node is launched as an
   ordinary user LaunchAgent, it has the user's normal filesystem rights and
   `shell_exec` is not confined by App Sandbox.

   macOS seatbelt profiles can sandbox a process. Local `sandbox(7)` says the
   sandbox restricts access to OS resources and new processes inherit the
   parent's sandbox; local `sandbox-exec(1)` says `sandbox-exec` is deprecated
   and developers should adopt App Sandbox. Therefore seatbelt/sandbox-exec is
   viable for internal experiments or per-tool-call wrappers, but risky as the
   primary supported production API.

2. **Granting access to local folders**

   Native macOS can grant folders through `NSOpenPanel` and security-scoped
   bookmarks. Apple's document-picker guidance says security-scoped URLs require
   `startAccessingSecurityScopedResource` and access should be released when no
   longer needed
   ([security-scoped URL guidance](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/DocumentPickerProgrammingGuide/AccessingDocuments/AccessingDocuments.html)).

   This maps conceptually to `workspace_only + additional_allowed_roots`: each
   approved folder becomes an allowed root. The hard part is process ownership.
   If the sandboxed Swift app resolves bookmarks but an unsandboxed launchd Node
   service performs the actual file/shell operations, the OS sandbox is bypassed.
   If the Node service is sandboxed, the service must receive and resolve
   security-scoped access correctly, likely via an app-group/XPC/helper design.

3. **Packaging Node22 + native deps**

   Feasible but macOS-specific. Bundle a pinned Node 22 runtime and production
   `node_modules`, or package a self-contained Node binary. For one-click
   operation, do not rely on Homebrew. Every executable and Mach-O payload inside
   the `.app`/helper tree needs code signing: the Swift app, Node binary, helper
   tools, and native `.node` modules such as `better_sqlite3.node` and
   `lancedb.darwin-arm64.node`. Broad distribution needs notarization; Tauri's
   macOS signing docs state the same Apple credential requirement for
   notarization, and the native Swift route has the same platform requirement
   ([Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/),
   [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).

   ABI pinning is straightforward if the app ships Node 22 and matching native
   deps per architecture. Distribution likely needs separate arm64/x64 builds or
   universal binaries; LanceDB's current package is architecture-specific.
   Expect hundreds of MB uncompressed with today's dependencies.

4. **Cross-platform and enterprise fit**

   macOS-only. Strong fit for MDM, signed `.pkg`, login item/service management,
   and a polished local Mac app. Poor fit for Linux/Windows and for a future
   multi-user web/server deployment unless paired with a separate Docker/server
   product.

5. **Effort / biggest risk**

   Effort: **L**.

   Biggest risk: making App Sandbox, security-scoped folder grants, launchd
   service lifetime, Node/V8/native-module signing, and `shell_exec` all line up
   without accidentally leaving the service unsandboxed. The technical boundary
   is easy to weaken by launching Node outside the sandbox.

6. **Current architecture interaction**

   Fastify + built UI survives very well: WKWebView can load
   `http://127.0.0.1:9210/`, and launchd can own background lifetime. The
   current watchdog becomes redundant or secondary to launchd. Significant new
   code is still needed for install/uninstall, upgrade, folder grants, service
   health, and sandbox handoff.

## Sandboxing the Agent Separately from Packaging

Yes: the real shell/fs sandbox can ship independently of the delivery wrapper.
This is likely the fastest way to reduce risk before deciding on Docker vs
desktop packaging.

- **Per-tool Docker sandbox**: Extend the existing Docker shell executor so
  `shell_exec` and possibly filesystem mutations run in short-lived or
  session-lived containers with only `workspace.dir` and `additional_allowed_roots`
  mounted. Use `--network none` by default for shell calls that do not need
  network, `--read-only`, `--tmpfs`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, pids/memory/CPU limits, and explicit UID/GID.
  Feasibility: **high** on hosts with Docker. Risk: per-call startup overhead,
  missing dev tools inside the image, file ownership, macOS/Windows Docker
  Desktop dependency, and commands that legitimately need network.
- **macOS seatbelt wrapper**: Wrap native `shell_exec` in `sandbox-exec` with a
  generated profile that allows only selected roots. Feasibility: **medium** for
  internal macOS builds; local macOS man pages confirm the tool exists and that
  child processes inherit sandbox restrictions. Risk: `sandbox-exec` is explicitly
  deprecated, the profile language is not a stable product API, and coverage
  must be tested against real shells, compilers, package managers, and spawned
  children.
- **Keep code-level policy as defense in depth**: `workspace_only` and
  `additional_allowed_roots` should remain because they produce clear user-facing
  errors and audit data. They should not be the only boundary once "operate on
  user's local folders" ships.

This separation means Option B or C can use the same hardened tool execution
layer later. It also means Option A does not need to wait for a full desktop
decision if the immediate priority is reducing `shell_exec`/fs blast radius.

## Open Questions for the Operator

1. Is macOS-only acceptable for v1, or must Linux/Windows be first-class at the
   same time?
2. Is Docker Desktop an acceptable prerequisite for local users, including its
   enterprise licensing and admin/MDM implications?
3. Should agent shell commands have network by default, approval-gated network,
   or no network unless explicitly enabled per task?
4. Is per-tool-call container startup overhead acceptable, or do we need
   session-lived sandboxes with lifecycle/state management?
5. Should user folder grants be explicit mount/setup steps, native file-picker
   grants, or both?
6. Is the future "one-click deploy" goal primarily a local single-user desktop
   installer, or a multi-user server/enterprise deployment?
