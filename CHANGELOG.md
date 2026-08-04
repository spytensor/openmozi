# Changelog

All notable changes to OpenMozi will be documented in this file.

OpenMozi maintains its own version line.

## [Unreleased]

### Added

- Reasoning from providers whose thinking output is an official display
  surface (DeepSeek, Anthropic, Qwen, Kimi, GLM, MiniMax, Groq, Gemini,
  OpenRouter, Ollama, vLLM) is now visible: streamed live into the chat
  disclosure and browsable per pass in Run details → Reasoning, collapsed by
  default with click-to-expand. Providers without a display-safe contract stay
  private, and the fallback notice now says MOZI kept it private instead of
  blaming the model.

- One-command source install: `./scripts/setup.sh [app|server|--check]` finds
  a compatible Node.js automatically (22 LTS preferred; Homebrew, nvm, fnm,
  mise, volta, asdf), runs the repository-pinned pnpm without `corepack
  enable`, sudo, or a global pnpm, and shims recursive `pnpm` calls so
  `desktop:pack:mac` works on machines that have never installed pnpm. The
  README quick start now uses it; `corepack enable` (broken on Node >= 25 and
  permission-prone on nodejs.org installs) is no longer part of setup.

- Every HTTP provider can now be pointed at a custom endpoint from the web UI
  (Settings and onboarding): official-vs-custom endpoint selector for relays
  such as LiteLLM, a dedicated Azure OpenAI resource URL and API version form,
  and blank-to-reset back to the official endpoint. Plain HTTP endpoints are
  accepted for localhost relays only; everything else requires HTTPS.
  (Writer: `POST /api/keys/:provider` persists `providers.<id>.baseurl` /
  `.apiversion`; reader: `resolveBaseUrl`/`resolveApiVersion` in the live
  model factory path.)
- Run details now provide dedicated Overview, Plan DAG, Reasoning, Trace, and Outputs views from one shared turn contract.

### Changed

- Active and historical runs now use one compact chat summary that opens the shared right-side Workbench instead of expanding process UI inline.

### Fixed

- Switching away from a session and back no longer wipes the visible chat
  history while a heavy task runs. The session timeline page now serves a
  conversation projection (messages, plans, tasks, artifacts, approvals,
  memory updates); an active turn's tool-event flood is served exclusively by
  the per-run endpoint and can never evict messages from the page window.
  Legacy sessions without turn envelopes keep their tool rows, and a restored
  active tool-only turn keeps its live run capsule instead of the welcome
  screen.
- Recovered tool attempts and private quality checks no longer surface as failed product status or verification warnings when a real result was delivered.
- Mixed legacy and envelope-backed sessions keep each turn's process history under the correct renderer, including envelope-only crash recovery.
- Verifier evidence budgeting now reserves persisted result and artifact context before optional source excerpts.

## [v1.5.1] - 2026-08-03

### Fixed

- Multi-step turns now present all model reasoning in one Thinking card and all
  execution phases in one Work card instead of repeating both surfaces
  throughout the conversation.
- Completed HTML artifacts remain open after they are selected instead of
  flashing briefly and disappearing when generation has already finished.

## [v1.5.0] - 2026-08-03

### Added

- Qwen / Alibaba Cloud is now a first-class provider with DashScope China and
  international endpoints, model discovery, and Qwen 3.8 Max metadata.
- Supported models can expose their reasoning separately from the final answer;
  live reasoning remains visible in a compact disclosure after completion.

### Changed

- Work details now expand directly in the conversation instead of opening a
  separate page, and the live card title follows the current action.
- Model activation uses explicit Add and Remove actions instead of an ambiguous
  unlabeled switch.
- macOS download and Release instructions now state the exact Apple signing and
  notarization status and explain Gatekeeper's "damaged" warning.

### Fixed

- Provider endpoint selection is validated, saved, and reused consistently by
  model discovery and model calls.
- User cancellation reaches provider calls without adding an arbitrary global
  wall-clock deadline to the turn.

## [v1.4.1] - 2026-08-03

### Added

- Docker builds can install an optional base64-encoded public root CA before
  Corepack, pnpm, or pip access the network, improving compatibility with
  TLS-intercepting corporate networks.

### Changed

- Active work now uses one compact capsule and one matching timeline dialog.
  Its title follows the current runtime action and uses a restrained
  left-to-right text gradient while work is running.
- macOS installation instructions link directly to GitHub Releases and explain
  checksum verification and first-launch handling for unsigned prereleases.

### Fixed

- macOS packages rebuild native SQLite bindings with the Node runtime embedded
  in the app and verify the binding before packaging. Failed release retries
  also clear generated runtime resources before privacy scanning.
- Codex worker setup recognizes API-key authentication stored by the Codex CLI,
  not only OAuth credentials.
- Azure-compatible model endpoints no longer receive the unsupported
  `uniqueItems` tool-schema keyword; duplicate tool names are removed at
  runtime instead.
- Custom provider `base_url` settings are honored consistently during model
  discovery and onboarding.
- Managed and scheduled work is no longer terminated by an arbitrary
  ten-minute wall-clock deadline; explicit cancellation and concrete runtime
  failures still stop execution.

## [1.4.0] - 2026-08-02

### Added

- **PowerPoint files now preview locally in the app.** `.pptx` artifacts use a
  browser-native renderer without LibreOffice, an office container, or a remote
  upload. The original file stays available for download.

### Changed

- **GitHub Releases now contain the macOS app downloads.** The release workflow
  attaches DMG, ZIP, supply-chain manifest, and SHA-256 checksums directly to
  the Release page.
- Public release titles and downloadable files consistently use the exact
  lowercase `openmozi` name, while the installed application remains
  `MOZI.app`.
- Provider compatibility checks are manual-only, and the layered Unit job has
  a ten-minute timeout so a stalled test cannot consume a runner indefinitely.

### Fixed

- Release and DAG tests no longer wait on network dependency installation or
  inactive deferred tools.

## [1.3.1] - 2026-08-02

### Fixed

- Public CI and release checks no longer reference the private export-policy
  file that is intentionally absent from OpenMozi.

## [1.3.0] - 2026-08-02

### Added

- **Skills can be installed from packages.** The Skills page accepts `.skill`,
  `.zip`, and tar archives by picker or drag-and-drop. MOZI can also install the
  same packages with `install_skill`, including a package nested inside a
  wrapper archive.
- **MOZI-authored skill drafts are reviewable.** Drafts now appear on the Skills
  page with an approval action instead of remaining hidden and unusable.
- **Tools are exposed progressively.** Models start with a compact catalog and
  activate the full schemas they need, reducing the persistent context cost of
  large tool collections.

### Changed

- Planning and DAG use are model decisions based on tool descriptions. The
  runtime no longer classifies prompt complexity or forces a plan before the
  selected model can act.
- Visual-output guidance now routes work to the smallest relevant design skill,
  requires structure before styling, and adds dashboard/report rules against
  repetitive card grids and decorative metrics.
- The Agents surface is now presented as `Agents` in English and `专家` in
  Chinese, with a consistent localized editor for names, permissions, skills,
  tools, icons, and personas.
- Chat and document prose use a more readable type scale, line height, and
  spacing rhythm.

### Fixed

- **Scheduled prompts now persist the workload they were created with.** A task
  made from the Scheduled page previously saved its title but could reach the
  unattended runner with an empty prompt and fail immediately.
- **Managed coding workers are verified from runtime evidence.** Allowed-scope
  changes are measured against the Git workspace and required test commands are
  executed by MOZI with recorded exit codes, rather than trusting a worker's
  prose summary.
- Claude Code workers no longer wait for an approval UI that does not exist in
  non-interactive mode. Their file, shell, Git, and web tools are mapped from the
  task's declared permissions.
- Completed work renders as one coherent section instead of showing a second,
  nested `View work` disclosure around the same result.

## [1.2.0] - 2026-07-26

### Added

- **MCP servers can now give MOZI extra tools.** Connect a server and its tools
  become callable by the model, gated at the permission level you declare for
  that server. Manage servers from Settings → MCP: add, edit, remove, and
  dry-run a connection to see what a server would expose before enabling it.
  Credential values never leave your machine through the API — only the variable
  names are shown, with an explicit action to clear them.
- **Agents have icons.** Pick one of 33 role glyphs in the agent editor, or set
  `metadata.icon` in `AGENT.md`. It appears wherever the agent does. An agent
  that declares none gets a stable glyph derived from its name.
- **Scheduled work can be created from the UI.** Previously the scheduled page
  could only list what already existed — you had to ask MOZI in chat to set
  something up. There is now a composer for both a recurring prompt and a
  one-shot reminder, with ten worked examples to start from.

### Changed

- **The scheduled page is one list.** Recurring tasks and reminders were two
  separate features stacked on one page, with different controls. They now share
  one list, one card and one way to create them.
- **Schedules read as words.** A task described as `cron: 15 15 * * 1-5` now
  reads "Weekdays at 15:15". An expression too complex to phrase accurately
  keeps its expression rather than being described wrongly.
- **A scheduled prompt shows what it is allowed to do** while running
  unattended, instead of quietly inheriting it from whichever chat you happened
  to be in.
- Agent and skill icons render as plain glyphs rather than sitting inside a
  tinted tile.

### Fixed

- **A failed scheduled run now says why on the card.** The reason was being
  recorded and even rendered, but inside a collapsed disclosure with no visible
  control to open it — so a failure showed as a red dot and nothing else.
- **MCP server processes no longer inherit MOZI's environment.** A server that
  declared any environment variable previously received the whole parent
  environment, including MOZI's own provider keys and secrets. Servers now get a
  minimal base plus what they declare. Proxy and TLS-trust variables are still
  passed through.
- **An MCP server that stops responding can no longer hang MOZI.** Requests now
  run against a deadline, so a server that accepts a call and goes silent cannot
  block a turn, startup, or the connection test.
- **A disabled or deleted MCP server stops immediately.** It previously kept
  running with its credentials, and its tools stayed callable, until the next
  restart.
- Failed MCP servers are retried according to `restart_on_failure` and
  `max_restarts`, which had no effect before.
- Claude Code is detected as available when you are signed in through the CLI,
  not only when an API key is set.
- Built-in alerts fire again: they were being evaluated against a metric none of
  them used.
- The ACP channel no longer rejects every prompt it receives.
- Reprocessing usage records no longer zeroes the cost of rows whose price
  cannot be resolved on that run.

### Changed

- None yet.

### Fixed

- None yet.

## [v1.1.0] - 2026-07-25

### Added

- User-defined agents: describe an expert in `AGENT.md` (persona, model, bound
  skills, tool whitelist, permission level), manage them in the MY AGENTS view,
  and summon one with `@name` in chat. MOZI stays the single orchestrator — it
  writes the brief, the agent runs in an isolated loop, and only a contracted
  result envelope returns to the conversation while the full transcript and
  artifacts are archived under the session's output directory.
- Azure OpenAI as a first-class provider, using deployment-based routing, the
  `api-key` header and an `api-version` query parameter. Configure it with
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL` and
  `AZURE_OPENAI_API_VERSION`. Azure does not enumerate models, so register your
  deployment name manually; deployments named after a model family inherit that
  family's capabilities.

### Fixed

- **Installs now fail fast with a clear message instead of dying in node-gyp.**
  The supported range is declared and enforced (`engines`, `.nvmrc`, `.npmrc`):
  Node >= 22.12 and < 26, because the bundled native database has no prebuilt
  binary past Node 25 and the build toolchain needs 22.12 or newer.
- **`pnpm install` now runs Electron's install script**, so a clean clone can
  actually build the desktop app. Two competing build-script allowlists meant
  the Electron binary was silently never downloaded, with the usual pnpm warning
  suppressed by the conflict.
- Peer resolution is pinned in the repository's own `.npmrc`, so the install no
  longer depends on each user's global pnpm strictness settings.
- Removed a five-month-stale `ui/pnpm-lock.yaml` that pinned React 19 against
  React 18 sources.
- Clone instructions across the README, the deployment guide and the generated
  user guides point at this repository. Several pointed at a private repository
  that 404s for everyone.
- Docker builds pin pnpm to the version this repository's lockfile was written
  with, instead of resolving `pnpm@latest`.

## [v1.0.0] - 2026-07-23

Initial public release of OpenMozi — a personal AI agent that lives on your
machine.

### Highlights

- **Agent runtime** — a 5-layer architecture (channels → gateway → brain →
  execution support → capabilities) with a direct LLM/tool loop, durable
  SQLite-backed state, checkpoints, and an independent watchdog process.
- **Desktop app** — macOS app with project picker, git branch switcher,
  permission levels (read-only → full access), and live execution timeline.
- **Real deliverables** — generates Word / PowerPoint / Excel / PDF files with
  in-app previews; every claimed deliverable is verified against the
  filesystem before the agent reports done. Optional ONLYOFFICE container
  upgrades previews to a full editor.
- **13 messaging channels** — Telegram, Discord, Slack, Matrix, LINE, Feishu,
  WeChat, IRC, Mattermost, Twitch, Google Chat, MS Teams, and the built-in
  Web UI, all through one registry-driven plugin contract.
- **Multi-provider LLM support** — Anthropic, OpenAI, and OpenAI-compatible
  providers (DeepSeek, Kimi, MiniMax, GLM, Groq, OpenRouter, Ollama …) with
  live model discovery, failover chains, and prompt-cache-aware routing.
  Codex CLI and Claude Code CLI can act as chat-model providers when detected.
- **Skills** — Anthropic-compatible SKILL.md assets (the official skill set
  plus a managed-worker coding-agent skill), versioned, lazily injected, and
  executed with provisioned dependencies.
- **Memory** — user-scoped long-term memory with SQLite facts as the source of
  truth and provider embeddings past a size threshold (LanceDB).
- **Scheduler & unattended execution** — cron-style background jobs with
  durable run state, cancellation cascades, and approval-aware turns.
