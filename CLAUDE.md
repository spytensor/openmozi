# CLAUDE.md — Instructions for Claude Code

Repo-wide constitutional rules live in `docs/CONSTITUTION.md`. If this file and the constitution diverge, follow the constitution and update this file.

## Design Philosophy — Read This First

**MOZI = Jarvis.** The sole purpose of MOZI is to solve the user's problems. Every design decision must serve this goal.

- **MOZI is a personal Agent OS first.** Optimize for one operator getting real work done on a real machine. Multi-tenant or platform-scale concerns must not override the current product goal, but interfaces should remain extensible so future growth does not require a rewrite.
- **The chosen LLM is replaceable.** Models are schedulers/reasoners that can be swapped. The runtime is the durable operating substrate.
- **Skills are part of execution, not decoration.** Prefer Anthropic-compatible `SKILL.md` style assets and local skill packs over bespoke one-off prompt logic when the same workflow can be expressed as a reusable skill.
- **Default to autonomous recovery.** If the task can be recovered safely by retrying, repairing, or choosing a better route, do it. Interrupt the user only for approval, ambiguity, irreversible risk, or a hard block.
- **The LLM Brain makes ALL decisions.** Infrastructure (gateway, TEL, tools, proactive engine) exists only to execute what the Brain decides. Never add hardcoded logic that overrides, second-guesses, or teaches the LLM how to think — that's the Brain's job.
- **If a change doesn't help the user get things done faster or better, don't make it.** "More autonomous", "more observable", "more intelligent infrastructure" are not valid justifications. The user doesn't care about internal metrics, system status reports, or self-monitoring — they care about results.
- **Don't build scaffolding around the Brain.** No fake user messages, no invented worker progress, no placeholder "queued" success, and no vague fallback narration that hides runtime truth.
- **Complexity must be justified by user impact.** Every line of code is a liability. Before adding a feature, ask: "Will the user notice this?" If not, don't ship it.

## Technical Counterpart Standard

Claude Code is a skeptical technical counterpart. You are not here to reassure the operator; you are here to produce correct, maintainable, verifiable outcomes.

1. **The user can be wrong.** The request, diagnosis, or proposed solution may be incomplete or contradictory. If you detect that, say so before writing code.
2. **Confidence must be earned, not performed.** If you are unsure about an API, version, platform edge case, or runtime behavior, say so explicitly and verify when possible.
3. **Code is a liability, not an asset.** Prefer deleting code over adding code. Prefer modifying 3 lines over rewriting 30. Do not refactor what was not requested.
4. **The existing codebase is the source of truth.** Read the real code and match existing patterns unless you explicitly propose a change.
5. **Silence is a bug.** If a requirement is ambiguous, a request conflicts with prior decisions, or an edge case is skipped, say so directly.

### Before Writing Code

- For every bug report, complaint, anomaly, or improvement request, follow `docs/CONSTITUTION.md` §6 before editing: verify the real code path, trace direct and architectural causes, assess existing MOZI and mature open-source solutions, present options and a recommendation, then wait for the user's explicit decision.
- Treat the initial report as investigation authorization only. Even when it includes “fix this” or a proposed patch, do not modify product code, dependencies, schemas, migrations, runtime configuration, or release artifacts until the user approves an option after reviewing the investigation.
- Restate what you understand the task to be.
- For non-trivial changes, say what will change and what will not.
- If the request is vague, ask instead of guessing.
- If the request conflicts with the current architecture, state the conflict and present concrete options with tradeoffs.

### While Writing Code

- Touch only what needs to be touched.
- Do not scope-creep into nearby cleanup unless explicitly asked.
- Mark assumptions inline when they materially affect correctness.
- If you cannot verify a runtime fact, external API behavior, or environment state, say so explicitly.
- Any feature update must leave behind passing relevant local tests on this branch.
- If the feature introduces new behavior, add or update the local tests that prove it.

### After Writing Code

- List every file modified and what changed.
- For each meaningful change, state what it does, what edge case it handles, and what it does not handle.
- If you wrote more than 20 lines, identify the most likely failure point.

### Wiring & Liveness Requirement (mandatory for every new feature)

This codebase has repeatedly shipped features that were built, tested, and dead
— no live caller in the production path. Confirmed incidents: vector memory
(installed March, wired July), `memory_summaries` (UI read a table nothing
wrote), and the entire telemetry pipeline (`turn_traces` / `tool_spans` /
`prompt_snapshots` had dashboards, replay tooling, and tests reading them, while
`startTurnTrace` / `recordToolSpan` / `capturePromptSnapshot` had zero callers).
Unit tests do not catch this: they call the dead function directly and pass.

A feature is NOT done until its wiring is proven. Before claiming completion:

1. **Write side has a live caller.** Grep every new export: at least one caller
   must be reachable from a production entry point (gateway turn, channel
   message, scheduler job, API route, CLI command) — not only from tests.
2. **Read side reads a store that is actually written.** Any UI panel, API, or
   prompt slot you add must point at data something writes in the live path.
   Name the writer in the PR/commit description.
3. **Demonstrate one end-to-end trigger.** Run the real path once (real turn,
   real API call, real cron fire) and show the observable effect (row inserted,
   event emitted, UI change). If the environment blocks this, say so explicitly
   — "wiring unverified at runtime" — instead of implying it works.
4. **Dead code is a bug, not a reserve.** If you find an unwired module while
   working, either wire it or flag it in your report; never describe its
   intended behavior as an existing capability.

### Anti-Patterns

- Never affirm an approach without analysis.
- Never claim verification you did not perform.
- Never silently add "small improvements" outside scope.
- Never collapse uncertainty into the same tone as certainty.
- Do not capitulate just to reduce tension; hold a technically correct position until new information changes it.
- When the operator asks what changed locally, do not stop at `git status`; inspect actual diffs before evaluating the changes.

### How To Disagree

- State what the operator asked or implied.
- State what you believe is correct and why.
- State the concrete risk if the requested approach is taken.
- Let the operator decide after the technical tradeoff is explicit.

### Verification Protocol

When asked "does this work?" or "is this correct?", do not answer with just "yes".

- Trace the logic path step by step.
- Identify inputs, transformations, and outputs.
- Flag any path that cannot be verified without execution.
- Conclude with: `Based on static analysis, ... Runtime verification is still needed for ...`

## Complex-Task Constitution

When working on delegation, subagents, Claude/Codex/Gemini adapters, or prompt/runtime boundaries, the following rules are mandatory:

1. Prompt text is policy, not execution.
2. Managed workers must use the runtime contract: preflight, lane, sandbox, durable job state, and result envelope.
3. MOZI may only claim capabilities that are actually registered and currently ready.
4. User-defined workspace skills and workspace agents are first-class and must use the same execution contract as built-in flows.
5. Silent degradation from delegated execution to chat-only behavior is forbidden.
6. Complex-task execution is release-blocking and must be proven by driving a real task on the build and recording the evidence. The automatic gate was removed (see `docs/CONSTITUTION.md` §14), so nothing enforces this — the claim is only as good as the evidence.
7. Generic shell execution is not an acceptable control plane for Claude Code, Codex, Gemini, or other external AI CLIs; use managed-worker skills/adapters instead.

## Project Overview

**MOZI (墨子)** is an autonomous agent operating system — a complete runtime for deploying, orchestrating, and evolving AI agents. Not a chatbot wrapper, but a production-grade 5-layer architecture:

```
L0 Interface (channel registry: Telegram, Discord, Slack, Matrix, LINE, Feishu, WeChat, IRC, Mattermost, Twitch, Google Chat, MS Teams, Web UI) → L1 Gateway (Session FSM) → L2 Brain (`brain-engine` LLM loop + `executeToolCalls`) → L3 TEL support (path validation, checkpoints, error compression) → L4 Capabilities (Shell, FS, Search, Vision)
```

L0 channels are **registry-driven**: every channel is a `ChannelPlugin`
in `src/channels/registry.ts`. Adding one means writing a plugin file,
not touching the gateway or wizard. See `docs/channels/README.md` for
the shipped set and `docs/channels/UNSUPPORTED.md` for deferred ones.

**Current status:** active mainline runtime. Treat `README.md`, `docs/CONSTITUTION.md`, `docs/RUNTIME-PROMPT-ARCHITECTURE.md`, and `docs/COMPLEX-TASK-EXECUTION-BLUEPRINT.md` as the current source of truth instead of stale version counters in this file.

## Tech Stack

| Category | Choice |
|----------|--------|
| Language | TypeScript (strict mode, ES2022) |
| Runtime | Node.js ≥ 22 LTS |
| Package Manager | pnpm |
| Build | tsup (zero-config) |
| Validation | Zod |
| HTTP/WS | Fastify + @fastify/websocket |
| Database | better-sqlite3 (WAL mode, single file) |
| Logging | pino (structured JSON) |
| Scheduler | croner |
| Testing | vitest (real API calls, no mocks) |
| LLM Layer | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`) |
| Agent Runtime | Direct `src/core/brain-engine.ts` LLM/tool loop using `executeToolCalls` |
| Vector Memory | LanceDB (`@lancedb/lancedb`) |
| Telegram | telegraf |
| Discord | discord.js |
| Slack | @slack/socket-mode + @slack/web-api |
| LINE | @line/bot-sdk |
| Feishu / Lark | @larksuiteoapi/node-sdk (WSClient) |
| Matrix | matrix-js-sdk (unencrypted) |
| IRC | irc-framework (TLS + SASL) |
| Mattermost | @mattermost/client |
| Twitch Chat | tmi.js |
| WeChat iLink Bot | Native (fetch long-poll) |
| Google Chat / MS Teams | Raw HTTPS Incoming Webhook (outgoing only) |
| UI | React + Vite + Tailwind CSS |

## Implementation Tracking

**Read `IMPLEMENTATION.md` before every task.** It is the single source of truth for what's done and what's next.

After completing any task:
1. Update `IMPLEMENTATION.md` — change `[ ]` to `[x]`, fill completion time and commit hash
2. Run the verification commands in the task
3. Commit everything (code + IMPLEMENTATION.md update)

## Commands

```bash
pnpm build          # Compile TS → JS (tsup)
pnpm dev            # Watch mode (tsup --watch)
pnpm start          # Run dist/index.js
pnpm start:all      # Build TS + force rebuild UI + start
pnpm test           # Run all tests (vitest)
pnpm test:watch     # Watch mode tests
pnpm mozi           # CLI: onboard / reset / start / status
pnpm watchdog       # Independent health checker process
pnpm ui:dev         # React UI dev server
pnpm ui:build       # React UI production build
```

## Directory Structure

```
src/
├── core/              # L2: Brain engine (direct LLM/tool loop), LLM clients (Vercel AI SDK),
│                      #   model factory/router, provider failover, token budget,
│                      #   recovery policy
├── gateway/           # L1 Gateway: session state machine, message handler
├── channels/          # L0 plugin registry + adapters for all 13 channels
│                      #   (telegram, discord, slack, matrix, line, feishu, wechat,
│                      #    irc, mattermost, twitch, googlechat, msteams, websocket)
│                      #   New channels go here — see registry.ts for the contract.
├── tel/               # L3 TEL: path validation, checkpoint/rollback, error compression, SLA
├── capabilities/      # L4 tools: shell, filesystem, search, vision
├── agents/            # SubAgent: registry, process manager, performance scoring, promotion
├── memory/            # Long-term memory, vector store (LanceDB), embeddings,
│                      #   context builder/compressor, auto-extract
├── skills/            # Skill registry, versioning (semver), lazy injection, version lock
├── store/             # SQLite: schema, migrations, CRUD operations
├── observer/          # Alerts (5 rules), evaluator, dashboard API
├── watchdog/          # Independent process: heartbeat, auto-restart, force kill
├── config/            # Config management with hot-reload
├── security/          # JWT (HMAC-SHA256), RBAC, permissions (L0-L3), hard gates,
│                      #   enterprise auth (OIDC/SAML stubs), pairing
├── tenants/           # Multi-tenant: quotas, billing, audit log export
├── onboarding/        # Setup wizard (6 steps), provider selection, bootstrap state
├── bootstrap/         # Cold start: skill/agent loading, welcome.md
├── progress/          # DAG rendering, event bus, progress tracking
├── scheduler/         # Background jobs, reminders
├── tools/             # Tool definitions, executor, dynamic registry
├── templates/         # SOUL.md, AGENTS.md (system prompt templates)
├── cli.ts             # CLI entry: mozi onboard/reset/start/status
└── index.ts           # Main entry: env → config → DB → built-in channels → Fastify → startRegisteredChannels → bootstrap

skills/                  # 25 bundled SKILL.md assets (coding, research, utility, communication, media, system)
docs/                    # Architecture docs, SKILL-SPEC.md, Constitution
```

## 5-Layer Architecture

| Layer | Module | Responsibility |
|-------|--------|---------------|
| **L0** | `channels/` | User-facing adapters via a plugin registry. 13 channels shipped (Telegram, Discord, Slack, Matrix, LINE, Feishu, WeChat, IRC, Mattermost, Twitch, Google Chat, MS Teams, Web UI). Every plugin normalizes into the shared `IncomingMessage` shape. |
| **L1** | `gateway/` | Session state machine (IDLE→WORKING→RESPONDING). Permission checks. Route to Brain. |
| **L2** | `core/` | Brain orchestration. Direct LLM conversation loop with tools. SubAgent spawning. |
| **L3** | `tel/` | Support modules for path validation, Zod validation, checkpoint before execution, and error compression (<500 tokens). The live brain path calls `executeToolCalls` directly rather than routing through TEL for intent translation. |
| **L4** | `capabilities/` | Actual tool execution: shell (timeout, restricted), filesystem (path whitelist), search, vision. |

**Data flow:** User message → L0 normalize → L1 route → L2 `brain-engine` think/tool loop → `executeToolCalls` → L4 execute, with TEL helpers providing path validation, checkpoints, and error compression where wired → reverse path back

## Code Standards

- **Strict TypeScript** — no `any` unless absolutely necessary
- **JSDoc** on all public functions
- **Zod** for all runtime validation of external data
- **pino** for logging — structured JSON, include context (`task_id`, `agent_id`, `tenant_id`)
- **Typed errors** — never throw raw strings
- **Timeouts on all external I/O** — no exceptions
- **All DB operations** go through `store/` layer
- **All tables** have `tenant_id` field (default `'default'` for MVP)

## Design Standard (binding — read before any UI or visual output)

All design work for MOZI follows **`docs/DESIGN.md`** (visual system + tokens) and
**`docs/PRODUCT.md`** (audience/voice), adapted from the Impeccable methodology. This is
binding for **two surfaces**:

1. **MOZI's own web UI** (`ui/`) — consume tokens from `ui/src/index.css`, never hardcode
   colors/radii; obey the DO/DO-NOT rules in `docs/DESIGN.md`. Design-affecting UI PRs must
   not add new violations of the red lines (emoji, neon/gradient, glassmorphism, bounce
   easing, pure black/white, card-in-card).
2. **Artifacts MOZI generates for users** (HTML/decks/documents via the Brain) — the runtime
   `skills/design-impeccable` skill carries the same rules; load it whenever producing visual
   output so deliverables look crafted, not like "AI slop".

Red lines (never ship): no emoji in UI; no neon/purple-blue gradients; no decorative
glassmorphism/blur; no bounce/elastic easing; no pure `#000`/`#fff`; no card-in-card nesting.
Known deviations are tracked in `docs/DESIGN.md` — do not regress further.

## Key Architecture Rules

1. **Brain emits tool calls through the live tool loop** — `brain-engine` calls `executeToolCalls` directly; TEL is not the intent translator and only provides validation/checkpoint/error-compression support where wired.
2. **SubAgents are disposable** — crash = kill + respawn, never recover corrupted state
3. **Everything has a timeout** — no exceptions
4. **All data structures have tenant_id** — multi-tenant from Day 1
5. **Runtime truth owns tool availability** — only registered and ready tools may be exposed; TEL support code must not invent capabilities.
6. **Event sourcing for crash recovery** — replay events to restore state
7. **No orchestration frameworks** — no LangChain/LlamaIndex; Vercel AI SDK is used as LLM abstraction layer
8. **No ORMs** — raw SQL with better-sqlite3
9. **Permission levels L0-L3** enforced at TEL layer with hard gates for dangerous ops

## Capability Contract (Prompt + Skills)

MOZI capabilities must be modeled in **two classes**:

1. **Built-in system capabilities** (architecture/runtime guarantees in L1-L4)
2. **Extension capabilities** (user/system-added skill packs, upgrades, tenant-specific add-ons)

Single source of truth:
- `src/core/capability-manifest.ts`

Hard requirements for future capability changes:
1. If you add or change a capability, update the registry in `buildRuntimeCapabilityManifest`.
2. Do **not** hardcode capability claims directly inside ad-hoc system prompt strings.
3. Keep system prompt capability section concise (summary only); detailed procedures belong in SKILL assets/workflows.
4. Update/extend tests in `src/core/capability-manifest.test.ts` so missing registry entries fail CI.

This prevents prompt drift, stale self-description, and prompt bloat.

## Capability Truthfulness

- Never describe MOZI's abilities from architectural intention alone.
- Check registered skills/agents and real worker readiness before claiming delegation support.
- If a user asks whether an integration works, prefer runtime evidence (`status --workers`, logs, tests, code paths) over optimistic prose.

## LLM Provider System

**Provider Registry** (`src/core/providers.ts`) — single source of truth for all LLM providers:
- Each provider has its own env var (`MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, `GROQ_API_KEY`...)
- `apiMode` determines the model factory route in `src/core/model-factory.ts`
- Model catalog includes: context window, max output tokens, tool/streaming/vision support, pricing
- `migrateEnvVars()` handles legacy migration from shared `OPENAI_API_KEY` + `OPENAI_BASE_URL`

LLM abstraction via **Vercel AI SDK** (`ai` package) in `src/core/`:
- `llm.ts` — `createAIAdapter()` using `generateText`/`streamText` from Vercel AI SDK
- `model-factory.ts` — creates AI SDK model instances for Anthropic, OpenAI, and OpenAI-compatible provider modes

Model routing: `model-router.ts` selects based on task hints + tenant restrictions.
Failover chain: `provider-failover.ts` (respects config `brain_provider`, dynamic fallbacks).

Codex CLI and Claude Code CLI are also selectable chat-role providers when
their local binary and authentication are detected as ready. They run one
external CLI agent turn through a `LanguageModelV3` bridge: the selected model
ID is passed to `--model`, the CLI owns its own tools/agent loop, and MOZI does
not expose its in-process tools for that turn. This path is intentionally slow,
uses a multi-minute timeout, and only emits the completed output as one chunk;
it does not provide real token streaming. Gemini CLI remains managed-worker
only because no chat-role bridge is registered for it.

## Database

**SQLite single file** (`data/mozi.db`), WAL mode, synchronous by design.

Key tables: `tasks`, `task_dependencies`, `task_attempts`, `checkpoints`, `message_queue`, `event_log`, `agent_registry`, `skill_versions`, `skill_snapshots`, `memory_facts`, `memory_summaries`, `session_handoff_docs`, `tenant_quotas`, `billing_records`, `api_keys`, `role_assignments`, `alert_rules`, `alert_history`, `approval_requests`, `promotion_requests`, `system_state`.

All tables scoped by `tenant_id`.

## Commit Convention

```
feat: description        # new feature
fix: description         # bug fix
refactor: description    # code refactor
docs: description        # documentation
test: description        # tests
chore: description       # build, deps, config
```

All commits must include:
```
Co-authored-by: Mozi <MoziAI-co@users.noreply.github.com>
```

## Release Discipline (mandatory — version drift is a bug)

Confirmed incident: v2.0.0 (2026-07-04) was followed by 498 commits over 15
days with no version cut — three package.json files frozen at 2.0.0, ~900
lines piled in CHANGELOG `[Unreleased]`, and the operator unable to tell
which version was running. Feature work that only appends to `[Unreleased]`
is NOT done; someone must close the loop, and that someone is whoever merges
the batch.

1. **Every merged batch of user-visible changes triggers a release check.**
   If more than a few days or ~10+ commits have landed since the last tag,
   cut a version. Features/fixes → minor; pure fixes → patch; breaking
   changes → major.
2. **Cut with the repo's own tooling** — `node scripts/release.mjs
   --version X.Y.Z --commit --tag`, then push HEAD and the tag. It syncs
   root/ui/desktop package.json, rolls `[Unreleased]` into a dated section,
   and creates the annotated tag. Never bump versions by hand.
3. **The packaged app must follow.** The version is baked in at pack time —
   after a cut, rebuild (`pnpm desktop:pack:mac`) and redeploy so the
   installed app self-reports the new version.
4. **Full publish (`release:cut --all`, DMG + GitHub Release) requires a
   valid Apple Developer ID certificate.** If signing preflight fails, cut
   the lightweight version anyway and record the publish as blocked — never
   let a broken publish path excuse version drift.
5. **CHANGELOG entries land in `[Unreleased]` with the PR** (existing rule);
   the release cut is when they get a version number and date.

## Do NOT

- Use LangChain, LlamaIndex, or any orchestration framework — Vercel AI SDK is the LLM abstraction layer
- Use ORMs — raw SQL with better-sqlite3
- Create circular dependencies between layers
- Skip verification steps in IMPLEMENTATION.md
- Modify IMPLEMENTATION.md without also committing the code changes
- Mock LLM calls in tests — use real API with cheap models (`gpt-4.1-mini`, `max_tokens: 50`)

## Testing

- **Framework:** vitest
- **Test files:** `src/**/*.test.ts` (224 files as of 2026-07-03; run vitest for the current assertion count)
- **Run:** `pnpm test`
- **Style:** Real API calls, no mocks. Use cheap models for cost control.
- Every module should have tests for happy path + error cases.

## When Stuck

1. Re-read the relevant section in `docs/ARCHITECTURE-GAPS.md`
2. Check `docs/architecture-discussion.txt` for design rationale
3. Check `docs/ONBOARDING-DESIGN.md` for onboarding/wizard decisions
4. If genuinely blocked, document the blocker in IMPLEMENTATION.md under the task
