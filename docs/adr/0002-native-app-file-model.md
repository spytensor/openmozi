# Design 0002 — Native macOS App + File-Access Model

- Status: Design (implementation staged; see phases)
- Decision: [0001-runtime-sandbox.md](./0001-runtime-sandbox.md) (Option C)

## Goal

A downloadable macOS app (install and go, Codex-app style). The Node
backend runs as a **child of the sandboxed app** so it inherits macOS App
Sandbox. The agent's files live in known roots by default; project folders
are granted by the user through the native picker.

## File-access model (the contract)

Three tiers of allowed roots, unified under the existing
`workspace_only + additional_allowed_roots` policy:

| Tier | Path | Access | How |
|------|------|--------|-----|
| Output | `~/.mozi/output` | read/write, always | app container / auto-created |
| Workspace | `~/.mozi/workspace` | read/write, always | app container / auto-created |
| Project | user-picked folder(s) | read/write, until revoked | NSOpenPanel → security-scoped bookmark → passed to Node as an allowed root |

Rules:
- Default writes (skills' scripts, intermediate files, generated docs) go
  to `~/.mozi/output` unless a project folder is the active context.
- A path outside all granted roots is refused with a clear error naming
  the roots — never a silent host-wide write (the bug we just fixed).
- Granted project folders persist across restarts via stored bookmarks;
  the user can list/revoke them (this is the sidebar/settings folder-grant
  UX, tied to the permission model already in the composer).

## Architecture (target)

```
┌ macOS .app (App Sandbox) ────────────────────────────┐
│  Swift shell: WKWebView → http://127.0.0.1:9210      │
│  ├ owns window/menu/lifecycle + native folder picker │
│  ├ resolves security-scoped bookmarks                │
│  └ spawns Node backend as a CHILD (inherits sandbox) │
│       └ Fastify + built UI + Brain + tools           │
│            shell_exec / fs confined by the inherited  │
│            sandbox + code-level allowed-roots policy   │
└───────────────────────────────────────────────────────┘
```

Key point from the findings: App Sandbox only helps if Node is a **child of
the sandboxed app**. If Node were an independent launchd service it would
run unsandboxed and the whole model collapses. So the Swift app owns and
spawns Node; folder grants flow app → Node.

## The hard/unproven parts (must be validated by a spike BEFORE building the Swift shell)

1. **Node + native modules under App Sandbox.** Can a sandboxed Node child
   load `better-sqlite3.node` and `lancedb.darwin-arm64.node` and open its
   SQLite DB + LanceDB dir inside the app container? Signing: every `.node`
   and the Node binary must be signed with the app's entitlements.
2. **shell_exec inside the sandbox.** Children inherit the sandbox — good
   for confinement, but do real tools (python3, node, git) actually run,
   and can they write only to granted roots? Test python-docx/pptx flows
   (our office skills) end-to-end.
3. **Security-scoped bookmark handoff.** App picks a folder → Node writes
   into it. Confirm the granted scope reaches the Node child (env/arg/XPC?)
   and `startAccessingSecurityScopedResource` semantics hold across the
   process boundary.
4. **Signing + notarization** of the whole tree (Swift app, Node, helpers,
   all `.node` modules). Needs an Apple Developer account.

If any spike fails, fall back options: (a) ship the file-model + folder-grant
UX now on the existing Electron wrapper (no OS sandbox yet, honest about
it), and treat the Swift+App-Sandbox as a follow-up once spikes pass; or
(b) reconsider the Docker per-tool sandbox from ADR 0001.

## Phasing

**Track A — File-access model in the Node backend (ship now, no native, fully testable):**
- A1: Default roots `~/.mozi/output` + `~/.mozi/workspace` auto-created and
  always-allowed; default write target = output. Extend workspace-policy.
- A2: Folder-grant API (add/list/revoke `additional_allowed_roots`),
  persisted; refusal errors name the roots.
- A3: UI to pick/manage granted project folders (settings + composer
  context), reusing the permission surface.

**Track B — Native app + OS sandbox (spike-gated, native complexity):**
- B0 (SPIKE, do first): prove parts 1–3 above with a throwaway sandboxed
  Node harness + entitlements; document results. NO production Swift until
  B0 passes.
- B1: Swift shell (WKWebView + menu + lifecycle) spawning Node as child.
- B2: Native folder picker → security-scoped bookmark → Node allowed-root
  handoff (wires Track A's grant API to the OS layer).
- B3: Signing + notarization pipeline; packaged installer.

Track A is independent of Track B and delivers the correct logical model +
UX immediately. Track B adds real OS enforcement underneath it. This is the
same "sandbox separate from packaging" principle from ADR 0001, adapted to
the native decision.
