# MOZI Desktop App

This is the Phase 2A desktop shell path tracked by issue #286. The desktop app
does not replace the MOZI runtime. It supervises the real local runtime and then
loads the existing Web UI.

## Product Direction

- macOS App is the default non-technical user entry.
- Docker remains for server, internal deployment, CI, and advanced operators.
- The app must use real MOZI storage, sessions, logs, skills, memory, and
  workspace state. Demo data is not acceptable.
- The Lovable-style Web UI remains the user-facing workspace.

## Runtime Model

The Electron main process creates a `MoziRuntimeSupervisor`:

1. Probe `http://127.0.0.1:9210/api/health`.
2. If an existing daemon is healthy, attach to it and load the workspace.
3. If no daemon is healthy, start `dist/index.js` with a Node runtime.
4. Keep deterministic states: `stopped`, `starting`, `ready`, `failed`.
5. Show startup failure details and the real log path instead of hiding errors.

In development, the app uses `MOZI_NODE_BIN`, `npm_node_execpath`, or the current
Node executable. In packaged builds, it expects a bundled Node runtime at:

```text
MOZI.app/Contents/Resources/node/bin/node
```

That keeps the user path independent of any system Node/pnpm installation.

Packaged builds also include a checksum-pinned Python 3.11 document runtime at:

```text
MOZI.app/Contents/Resources/python/bin/python3
```

The supervisor exports that exact path as `MOZI_PYTHON`, prepends its `bin`
directory to `PATH`, and disables user site-packages. PDF, DOCX, PPTX, XLSX, and
GIF dependencies are installed and import-checked during packaging from the
pinned `requirements/document-runtime*.txt` contract. Built-in document skills
therefore validate and reuse the packaged environment instead of running pip in
a user task or inheriting Conda from the host.

## Desktop Security And Failure UX

The renderer keeps context isolation and sandboxing enabled with Node integration
disabled and no preload bridge. Main-frame navigation is limited to the exact
configured runtime origin and the app-generated status page. Runtime-origin
popups load in the existing workspace; external links are delegated only for
HTTP, HTTPS, and mailto URLs. Renderer permission requests are denied by default,
and downloads must originate from the runtime, including runtime-origin blobs.

When startup fails, the status page provides Retry, Restart runtime, and Open
log actions through a fixed `mozi-action://` allowlist. Credential-like error
values and provider request IDs are redacted before an error reaches the status
page or desktop stderr. Expected status-page navigation cancellation is silent
instead of logging the complete generated page URL.

Stage the bundled runtime before packaging:

```bash
pnpm desktop:stage-node
pnpm desktop:stage-python
```

By default this downloads the official Node `22.21.1` macOS build for the local
architecture, verifies it against `SHASUMS256.txt`, and writes it to
`desktop/resources/node`. Override with `MOZI_DESKTOP_NODE_VERSION`,
`MOZI_DESKTOP_NODE_PLATFORM`, or `MOZI_DESKTOP_NODE_ARCH` when building other
targets.

The Python staging command downloads the pinned `python-build-standalone`
archive for the target architecture, verifies its embedded SHA256 contract,
installs only binary wheels from official PyPI, checks the resolved environment,
and writes it to `desktop/resources/python`. Override with
`MOZI_DESKTOP_PYTHON_VERSION`, `MOZI_DESKTOP_PYTHON_RELEASE`, or
`MOZI_DESKTOP_PYTHON_ARCH` only when updating the pinned archive and tests.

## Local Development

Build the runtime and UI first:

```bash
pnpm build:all
```

Start the desktop shell:

```bash
pnpm desktop:dev
```

If the shell is launched from an environment whose Node version cannot load
MOZI native modules, point it at a compatible Node binary:

```bash
MOZI_NODE_BIN=/path/to/node pnpm desktop:dev
```

## Packaging

The package has a first-pass macOS builder config:

```bash
pnpm desktop:pack:mac
```

The root packaging command rebuilds the MOZI runtime and Web UI first, then
stages Node and the managed Python document environment and copies the fresh
runtime, Web UI, skills, templates, and production-only `node_modules` into
`desktop/resources/mozi` before Electron Builder copies it into app resources. A
release-grade package still needs signing, notarization, and update channel.

The Electron shell is built into `desktop/build/`; Electron Builder writes the
packaged app under `desktop/dist/`. Keeping those paths separate prevents prior
packaging output from being bundled back into `app.asar`.

## CI Packaging

`.github/workflows/desktop-app.yml` builds the unsigned macOS app on
`macos-14`, runs the desktop supervisor tests, stages a Node runtime matching
the runner architecture, packages the app, and uploads a short-lived
`mozi-desktop-macos-<arch>-unsigned` artifact.

The packaging command runs:

1. `pnpm desktop:prepare-package` (builds the current backend and Web UI before staging them)
2. `pnpm --filter mozi-desktop pack:mac`

The CI resource check verifies that the packaged app contains:

- `Contents/MacOS/MOZI`
- `Contents/Resources/app.asar`
- `Contents/Resources/node/bin/node`
- `Contents/Resources/mozi/package.json`
- `Contents/Resources/mozi/dist/index.js`
- `Contents/Resources/mozi/dist/store/schema.sql`
- `Contents/Resources/mozi/ui/dist/index.html`
- `Contents/Resources/mozi/node_modules`
- `Contents/Resources/mozi/bootstrap/agents`
- bundled skills from `skills/` and runtime templates

The resource check also imports `better-sqlite3` and `@lancedb/lancedb` with the
bundled Node binary so native dependency failures are caught before the artifact
is uploaded. `app.asar` is expected to contain only the Electron shell; MOZI's
runtime dependencies must live under `Contents/Resources/mozi/node_modules`.

When the app owns the runtime, macOS Quit is delayed until the runtime exits.
The supervisor sends `SIGTERM` first so active turns, channels, the HTTP server,
and SQLite can close through the runtime shutdown path. It sends `SIGKILL` only
after the graceful timeout. A runtime that was already running before the app
opened is treated as external and is never terminated by the app.

## First-Run Data Migration

The packaged app stores runtime state at `~/Library/Application Support/MOZI`.
Its default legacy source remains `~/.mozi`. For a Docker-backed checkout, stop
the MOZI container and launch the packaged executable once with an explicit
source instead of asking the app to guess between unrelated data homes:

```bash
MOZI_DESKTOP_LEGACY_HOME=/absolute/path/to/Mozi/data \
  /absolute/path/to/MOZI.app/Contents/MacOS/MOZI
```

Migration refuses a running runtime or any non-empty target without a migration
manifest. It checkpoints and integrity-checks the source SQLite database, copies
the complete source to `~/Library/Application Support/MOZI Migration Backups`,
validates a staging target, writes `.mozi-desktop-migration.json`, and atomically
renames the staging directory into place. The source and backup are not deleted.
The manifest contains the exact backup path, database hashes and key table
counts, plus rollback steps. Subsequent Finder launches use the migrated target
without needing the environment variable.

## Desktop Capability Truth

Finder does not inherit the interactive shell PATH. The desktop supervisor
constructs a deterministic PATH from existing standard Homebrew, `/usr/local`,
Conda, and per-user tool directories, then appends the inherited system PATH.
It never adds the current working directory. The packaged document interpreter
is prepended ahead of those optional host paths and is also selected explicitly
through `MOZI_PYTHON`, so a host Conda installation cannot replace it.

`GET /api/runtime/desktop-capabilities` reports the actual packaged runtime
state. It includes resolved command paths, executable probes for LibreOffice,
Poppler, and managed-worker CLIs, the document Python module set, CLI credential
readiness, Docker daemon health, and ONLYOFFICE mode. Optional Office is
`enhanced` only when configured and healthy; otherwise it is explicitly
`fallback`. A command merely existing on PATH is not enough to report it ready.

## App Icon

The desktop identity is the existing web `墨` mark adapted to a macOS-safe
transparent margin. `desktop/assets/icon-master.svg` is the source and
`pnpm desktop:generate-icon` reproducibly creates the standard iconset plus
`desktop/assets/MOZI.icns`. Electron Builder uses that ICNS for the app bundle
and distribution artifacts.

Signing and notarization stay out of the unsigned PR artifact until Apple
Developer credentials and release secrets are configured.

## Next Required Work

- Sign and notarize the DMG.
- Add auto-update.
- Add explicit App Support migration from existing `~/.mozi`.
- Add a user-visible setting for launchd always-on mode.
