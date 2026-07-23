# ADR 0001 — Runtime Delivery & Agent Sandbox

- Status: **Accepted — Option C (native macOS app + App Sandbox)**
- Date: 2026-07-04
- Supersedes: none
- Fact base: [RUNTIME-SANDBOX-FINDINGS.md](./RUNTIME-SANDBOX-FINDINGS.md)
- Design: [0002-native-app-file-model.md](./0002-native-app-file-model.md)

## Operator Decision (2026-07-04)

The operator chose the **native path**: a downloadable macOS app (Codex-app
style — install and go), NOT Tauri, NOT whole-runtime Docker. Isolation is
**macOS App Sandbox**; the Node backend runs as a child of the sandboxed
app so it inherits the sandbox (not an unsandboxed launchd service).

File-access model (operator's words):
- Default / intermediate / output files live under `~/.mozi/output` and
  `~/.mozi/workspace` (always-allowed roots).
- Project work: the user picks a folder; once picked, that path is fully
  readable/writable. (= `additional_allowed_roots`, granted via native
  file picker + security-scoped bookmarks.)

Network: shell may reach the network by default (operator's choice). Noted
caveat: a strong fs sandbox with open network protects files but not
against exfiltration — revisit a per-task network gate later.

The two-coherent-packages analysis below is retained for history; Option C
(native) is the accepted package.

## Context

The agent's `shell_exec` and filesystem tools are only bounded by
code-level string checks (`workspace_only` + `additional_allowed_roots`).
Live testing proved this leaks: the Brain wrote and ran a script in the
MOZI install directory, and a `cwd` defaulting bug put tool output outside
the workspace. Before any "operate on the user's local folders" feature,
the operator requires a **real sandbox** and a **locked delivery form**
(Docker or a macOS app).

Two facts from the fact-gathering pass reframe the decision:

1. **A working desktop wrapper already exists** — `desktop/` is an
   Electron app with a proven sidecar/supervisor (pinned Node 22.21.1,
   staged `node_modules`, localhost supervision). It is **not** Tauri.
2. **A real per-tool sandbox primitive already exists** — `shell.ts`
   already has an optional Docker executor with `--network none
   --cap-drop ALL --security-opt no-new-privileges --read-only` + tmpfs +
   bind-mounted cwd. It is not yet the default execution boundary.

The critical insight from the findings: **packaging choice ≠ sandbox
choice.** Tauri capabilities and macOS App Sandbox both confine the
*frontend*, not the Node backend — under any wrapper the Node sidecar
still needs its own OS sandbox. So the sandbox can and should ship
*independently of and sooner than* the packaging decision.

## Decision (proposed)

Split into two independent tracks.

### Track 1 — Sandbox (unblocks the red line, ship first)

**Promote the existing Docker per-tool executor to the default execution
boundary for `shell_exec` and mutating fs operations, when Docker is
available.** Policy: only `workspace.dir` + `additional_allowed_roots`
bind-mounted; `--network none` by default for shell (network becomes an
explicit per-task grant); `--read-only`, `--tmpfs`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, pids/memory/CPU limits, non-root UID.
Keep code-level `workspace_only` as **defense in depth + audit/error
surface**, not the only boundary. Session-lived container (not per-call)
to amortize startup — see open question Q4.

Why this and not macOS seatbelt: `sandbox-exec` is Apple-deprecated and
its profile language is not a stable API — unsafe as the primary
production boundary. Docker gives real kernel-enforced isolation today and
reuses code we already have.

Fallback when Docker is absent: refuse L2/L3 shell with an honest error
("Sandbox unavailable: install Docker or lower this to read-only"),
**never silently fall back to unsandboxed host exec.** This is the
constitutional "no silent degradation" line.

### Track 2 — Delivery (keep what works)

**Keep Electron (`desktop/`) as the local app for v1.** It already works,
already pins Node 22 (killing the node26 ABI drift we hit), and already
proves the supervisor pattern. Do NOT rebuild as Tauri or Swift for v1 —
the findings confirm both still require a separate Node sandbox anyway, so
they buy nothing for the security goal while costing a rewrite. Add: a
Docker-availability check at startup that drives Track 1's capability
gating; host↔container path mapping for UI display.

Revisit Tauri/Swift only if bundle size (~616MB) or a native-Mac identity
becomes a product priority — a later ADR, not now.

## Consequences

- Real, kernel-enforced isolation for the agent's blast radius, shipped
  without waiting on packaging.
- Docker becomes a runtime prerequisite for L2/L3 shell (see Q2).
- `workspace_only` demoted from "the wall" to "defense in depth" — its
  error messages and audit value stay.
- Electron's ~616MB bundle stays until a size/UX-driven repackaging ADR.
- Network-gated shell changes agent behavior: tasks needing network must
  request it (see Q3).

## Open questions that change this recommendation

| # | Question | If the answer flips |
|---|----------|---------------------|
| Q1 | macOS-only for v1, or Linux/Windows first-class now? | Mac-only → App Sandbox+XPC becomes worth exploring; cross-platform → Docker track is even stronger |
| Q2 | Is Docker an acceptable prerequisite for local users? | No → we must build the harder macOS App-Sandbox+helper path, or accept weaker isolation |
| Q3 | Shell network: on by default / approval-gated / off unless enabled? | Drives the default `--network` policy and the per-task grant UX |
| Q4 | Per-call containers (simple, slower) vs session-lived (stateful, faster)? | Session-lived needs lifecycle/cleanup code; per-call is simpler but adds latency each tool call |

Q5 (single-user desktop vs multi-user server first) is already answered by
product direction: **local Codex-like app first, enterprise later.**

## Implementation phases (after decision)

1. **P1** Docker sandbox as default shell boundary + availability gating +
   honest refusal when absent. (Track 1)
2. **P2** Per-task network grant + UI surface (permission chip already
   exists; add a network toggle). (Track 1)
3. **P3** Electron: Docker detection, path mapping, folder-grant UX wired
   to `additional_allowed_roots`. (Track 2)
4. **P4** fs mutations through the same sandbox; workspace becomes the
   mounted root. (Track 1)
