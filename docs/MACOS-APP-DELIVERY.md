# MOZI.app Delivery Contract

## Authority

The single objective is GitHub Epic #506: ship an installable, full-capability `MOZI.app` for the owner's current Apple Silicon Mac.

The live Epic and child Issues are authoritative for scope, order, acceptance, and completion. This file is a durable recovery index and evidence ledger. It must not override a newer Issue decision.

## Resume Protocol

After context compaction, interruption, or agent handoff:

1. Read Epic #506 and every open child Issue.
2. Read merged PRs and the latest evidence comments linked from those Issues.
3. Read this document, then verify the live branch, worktree, Docker processes, installed app, and data paths.
4. Continue the first open, dependency-ready child Issue.
5. Never infer completion from conversation text, stale memory, generated files, or an unmerged branch.

Every child uses this cycle:

```text
Issue -> branch -> implementation -> local verification -> PR -> merge -> evidence comment -> close
```

The Epic closes only after #515 installs `/Applications/MOZI.app` and the packaged-app capability matrix passes.

## Target And Boundaries

- Target machine: Apple Silicon (`arm64`), macOS 26.5.1, Xcode 26.6.
- Desktop technology: existing Electron 38 shell under `desktop/`.
- Runtime: bundled checksum-verified Node 22 sidecar running the real MOZI server and Web UI.
- Managed data home: `~/Library/Application Support/MOZI` unless an explicit `MOZI_HOME` override is used.
- Current local source data: repository bind mount `data/` used by Docker (`/data` in the container).
- Base desktop experience must launch without Docker.
- Docker sandbox and ONLYOFFICE are optional enhanced capabilities, but they must remain reachable and truthfully reported on this Mac.
- Public signing, notarization, Intel support, App Store distribution, and auto-update are follow-up release work unless local installation requires them.

## Existing Desktop Baseline

The repository already contains:

- Electron main process and hardened renderer settings in `desktop/src/main.ts`.
- Runtime ownership, identity health check, logging, and bundled-Node path resolution in `desktop/src/supervisor.ts`.
- Legacy `~/.mozi` to App Support migration guardrails in `desktop/src/migration.ts`.
- Node staging and checksum verification in `scripts/stage-desktop-node.mjs`.
- Production runtime/resource staging in `scripts/prepare-desktop-runtime.mjs`.
- Electron Builder packaging scripts in `desktop/package.json` and root `package.json`.
- Unsigned macOS packaging CI and resource/native-module checks.
- `desktop/assets/icon-master.svg` is the editable source. Every visible surface uses the canonical raster `desktop/assets/mozi-mark.png`; Web publishes a byte-identical `ui/public/mozi-mark.png` copy.

Known gaps at Epic creation:

- No packaged app/icon artifact is currently installed.
- `desktop/package.json` does not wire a production `.icns` icon.
- Migration does not cover the owner's current repository `data/` Docker source.
- App quit sends `SIGTERM` but does not await confirmed sidecar exit or SQLite checkpoint.
- Finder-launch PATH and native document/tool dependencies need packaged-mode verification.
- Docker/ONLYOFFICE enhanced-mode attachment needs packaged-app evidence.
- No complete packaged-app capability matrix has been executed.

## Issue Ledger

| Order | Issue | Deliverable | Status source |
| --- | --- | --- | --- |
| 1 | #507 | Delivery contract and capability matrix | GitHub Issue |
| 2 | #508 | Reproducible arm64 packaged runtime | GitHub Issue |
| 3 | #509 | Runtime lifecycle and SQLite-safe shutdown | GitHub Issue |
| 4 | #510 | Existing Docker-data migration and rollback | GitHub Issue |
| 5 | #511 | Native tools and optional Docker/ONLYOFFICE parity | GitHub Issue |
| 6 | #512 | Web-brand macOS app icon | GitHub Issue |
| 7 | #513 | Navigation, permissions, secrets, and failure UX | GitHub Issue |
| 8 | #514 | Packaged-app full capability regression | GitHub Issue |
| 9 | #515 | Install and owner release acceptance | GitHub Issue |

## Capability Matrix

Each row must eventually contain packaged-app evidence. `Native` means the bundled sidecar path. `Enhanced` means an optional local service such as Docker/ONLYOFFICE. `Fallback` must be explicit and truthful.

| Capability | Expected desktop mode | Primary evidence owner |
| --- | --- | --- |
| App launch, health, logs | Native | #508, #509 |
| Auth and onboarding | Native | #513, #514 |
| Provider/model settings and secrets | Native | #511, #513 |
| Chat, streaming, retry, cancel, refresh | Native | #514 |
| Sessions, memory, search, digests | Native, migrated data | #510, #514 |
| Files, uploads, downloads, generated links | Native | #511, #514 |
| Artifacts and fallback previews | Native | #511, #514 |
| DOCX/XLSX/PPTX/PDF generation | Native dependencies or explicit unavailable state | #511 |
| Editor-grade Office | Enhanced ONLYOFFICE; honest fallback otherwise | #511, #514 |
| Shell, git, browser, desktop tools | Native with runtime permission gates | #511, #513 |
| Docker sandbox | Enhanced Docker | #511, #514 |
| Managed coding workers | Native CLI adapters with verified PATH/auth | #511, #514 |
| Plans, tasks, scheduler, background work | Native | #514 |
| Admin, diagnostics, audit, runtime logs | Native | #513, #514 |
| App icon, Finder, Dock, Launchpad, DMG | Native app metadata | #512, #515 |
| Quit, relaunch, crash recovery, DB integrity | Native | #509, #514, #515 |
| Migration, upgrade, rollback | Native | #510, #515 |

## Evidence Ledger

Evidence is appended through Issue comments and merged PRs. Keep this table as a short index only.

| Issue | PR | Verification summary | Artifact/path |
| --- | --- | --- | --- |
| #507 | #516 | Baseline audit and contract merged | `docs/MACOS-APP-DELIVERY.md` |
| #508 | #517 | Clean arm64 package, bundled Node 22.21.1 native imports, and restricted-PATH launch passed | `desktop/dist/mac-arm64/MOZI.app` |
| #509 | #518 | Three packaged launch/quit cycles left no listener or sidecar; SQLite integrity check passed | isolated `/tmp/mozi-desktop-509.*` home |
| #510 | #519 | Docker source migrated with checkpoint, full backup, manifest, matching key counts/secrets, and target integrity | `~/Library/Application Support/MOZI` |
| #511 | #520 | Finder PATH, base APIs, document generation/preview, Docker sandbox, ONLYOFFICE, and worker readiness verified | `/api/runtime/desktop-capabilities` |
| #512 | #521 | Web `墨` mark adapted to 1024px master, ICNS, app bundle, and distribution metadata | `desktop/assets/MOZI.icns` |
| #513 | #522 | Exact-origin navigation, permission/download policy, redacted errors, and actionable failure page verified | packaged failure-state CDP smoke |
| #514 | #540 | Packaged matrix 26/26, startup race 5/5, unit/integration/E2E/Web UI gates, real native tools and enhanced services | `docs/MACOS-APP-REGRESSION-MATRIX.md` |

## Release Blockers

- Any data loss, secret loss, SQLite corruption, or migration without rollback.
- App requires Terminal, system Node, or pnpm for normal launch.
- A capability silently disappears or reports success while unavailable.
- App attaches to or kills an unrelated runtime.
- Untrusted navigation can replace the workspace or access Electron privileges.
- Any open P0/P1 defect or known release-blocking P2 defect.

## Final Installation Record

Issue #515 was accepted from commit `1826ae7369dbb1220e272e70a97eebbce844e1c1`
as MOZI `2.0.0` on the owner's Apple Silicon Mac.

- Installed app: `/Applications/MOZI.app` (`arm64`, bundle ID `ai.mozi.desktop`).
- Distribution artifact: `desktop/dist/MOZI-2.0.0-arm64.dmg`.
- DMG SHA-256: `ef492da434898ac3c140a6d0d9f8cb6f0cee91ab8d18958b052a22a60275a5c5`.
- Installed `app.asar` SHA-256: `bab35423d07b900633a2187df68514a02e0f949ff8fa79b79b6283bc3c7968cf`.
- Installed bundled Node SHA-256: `8179f1d4a920be531d81edef7a26df5cc5c9cb11c8b5a28fb336aa030fbfe3df`.
- Installed runtime `dist/index.js` SHA-256: `7c0d1476497bd1759d6466da47045f411dd16d28fdc5257d486531db975b22f7`.
- App icon: installed `Resources/icon.icns` matches `desktop/assets/MOZI.icns` at SHA-256
  `d2817be5144308797fc9e52b015302eb86020671b3f4dd7f5995d537e7d293ee`.
- Managed data home: `~/Library/Application Support/MOZI`.
- Migration rollback backup: `~/Library/Application Support/MOZI Migration Backups/2026-07-10T09-34-52-654Z`.
- Runtime: bundled Node `22.21.1`; normal launch does not depend on Terminal, system Node, or pnpm.
- Packaged matrix: 26/26 passed; startup race 5/5; unit 2793 passed/11 skipped;
  integration 18 passed/6 skipped; E2E 5/5; Web Chromium and complex-task gates passed.
- Finder-equivalent launch from `/Applications` reached the local sign-in UI and the App Support
  health endpoint. A graceful quit removed the listener, sidecar, Electron helpers, and CDP process;
  `PRAGMA integrity_check` returned `ok`; relaunch passed the same checks.
- Docker MOZI stays stopped to avoid competing for port 9210. The installed native runtime owns 9210.
  ONLYOFFICE remains available through Docker on port 8082 and returned HTTP 200.

Remaining owner inputs are external credentials, not hidden desktop fallbacks: the configured
DeepSeek key is rejected by the provider and must be replaced in Settings before a real-model
response can succeed; managed coding workers likewise require their provider credentials. External
messaging channels are explicitly deferred and are not part of this local MOZI.app acceptance.
