# Changelog

All notable changes to OpenMozi will be documented in this file.

OpenMozi maintains its own version line.

## [Unreleased]

### Added

- Release queue reset after v1.1.0; new entries land here.

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
