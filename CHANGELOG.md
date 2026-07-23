# Changelog

All notable changes to OpenMozi will be documented in this file.

OpenMozi maintains its own version line.

## [Unreleased]

### Added

- Release queue reset after v1.0.0; new entries land here.

### Changed

- None yet.

### Fixed

- None yet.

## [v1.0.0] - 2026-07-23

Initial public release of OpenMozi — a personal AI agent that lives on your
machine. ### Highlights

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
