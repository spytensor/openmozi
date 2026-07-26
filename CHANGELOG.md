# Changelog

All notable changes to OpenMozi will be documented in this file.

OpenMozi maintains its own version line.

## [Unreleased]

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
