# AGENTS.md — Repository Instructions for Coding Agents

This file applies to Codex, Claude Code, Gemini CLI, and any other coding agent working in this repository.

The repo-level source of truth is [docs/CONSTITUTION.md](docs/CONSTITUTION.md). Follow it for all architecture, delegation, and release decisions.

## Non-Negotiable Rules

1. Prompt text is not the execution engine. Runtime owns worker launch, sandboxing, health, state, fallback, and verification.
2. Never invent worker progress, fake `queued`/`completed` states, or hide a deterministic runtime failure behind vague generic apologies.
3. Only claim capabilities that are actually registered and currently ready in this runtime.
4. Treat user-defined workspace skills and workspace agents as first-class extensions; they must follow the same managed-worker contract as built-in flows.
5. Do not ship delegation changes unless a real complex task has been driven end-to-end on the build and the evidence recorded. The automatic gate was removed (see `docs/CONSTITUTION.md` §14) — nothing checks this for you.
6. Do not use generic shell execution as the transport for Claude Code, Codex, Gemini, or other external AI CLIs; those belong to managed-worker skills/adapters.
7. Do not treat a feature change as complete until relevant local tests have been run and passed; if new behavior lacks coverage, add or update tests in the same change.
8. Treat every bug report or feedback item as investigation-only until the user reviews the evidence and explicitly approves an implementation option. Follow the decision gate in `docs/CONSTITUTION.md` §6.

## Mandatory Bug And Feedback Workflow

Before changing product code for any bug, complaint, anomaly, or improvement request:

1. Inspect the real code and live call path; verify that the reported behavior and proposed diagnosis are true.
2. Identify the immediate cause and assess architectural causes, especially ownership, identity, lifecycle, state, persistence, contracts, and duplicated implementations.
3. Check existing MOZI abstractions first, then relevant mature open-source solutions, standards, and industry patterns. Compare fit, maintenance, license, security, and integration cost.
4. Give the user a decision brief: evidence, root cause, architectural assessment, existing solutions, options and tradeoffs, recommendation, scope, and verification plan.
5. Wait for explicit user approval of an option. Do not edit product code, dependencies, schemas, migrations, runtime configuration, or release artifacts before approval.
6. Implement only the approved option. Return for a new decision if material facts or scope change.

The original request to “fix” something does not itself satisfy step 5; approval must follow the investigation. Read-only inspection, reproduction, and research are allowed before approval.

## Practical Implications

- For delegation work, check the real adapter path, preflight, lane, sandbox, and result contract.
- For prompt work, keep prompts thin and grounded in runtime truth.
- For upgrade questions, prefer the startup contract: migrations, bootstrap sync, and workspace reload happen on restart.

## Scope, Simplicity, And Test Discipline

Coding agents in this repo have repeatedly over-designed, over-tested, and added
unrequested fallbacks. These rules are acceptance criteria: a PR that violates
them gets rejected without further discussion.

1. **The task spec is a decision, not a suggestion.** When an Issue marks a
   design as decided (schema, API shape, file layout, naming), implement it as
   written. If you believe it is wrong, raise the objection BEFORE writing code
   and wait; never silently redesign or "improve" it.
2. **Build only what the task asks.** No new abstraction layers, service
   classes, event buses, plugin points, interfaces reserved for the future,
   config options, or env vars unless the task explicitly requires them. Code
   justified by "extensibility" or "in case we later need" must be deleted
   before commit. Prefer editing existing files over creating modules; prefer
   deleting code over adding it.
3. **Fallbacks are forbidden unless the task specifies them.** Do not add
   try/catch-and-continue, silent default values, retry wrappers, or degraded
   paths that hide failures. Fail loudly with typed errors. If the task does not
   define degradation semantics, the correct behavior is a visible failure —
   this repo's constitution already bans silent degradation, and an invented
   fallback is a bug even when it "works".
4. **Respect the stated size estimate.** When a task gives an expected diff
   size, hitting ~2x that number is a signal you are solving the wrong problem.
   Stop, re-read the task, and cut scope — do not push through.
5. **Test the change, not the world.** Cover the new behavior's happy path and
   failure paths in targeted vitest files. Run `pnpm build`, `pnpm typecheck`,
   the tests you touched, and directly affected neighbors — never the full
   suite (it makes real LLM API calls). Do not create new test infrastructure,
   helpers, or fixture frameworks unless the task asks for them. Test count is
   not a quality metric; a change with 6 pointed tests and wiring proof beats
   one with 40 permutations.
6. **Wiring proof beats test volume.** A feature is proven when every new
   export has a production caller (grep evidence), every read side names the
   writer that populates its data, and one real end-to-end trigger shows an
   observable effect. Unit tests that call the new function directly prove
   nothing about wiring — this repo has shipped dead code with green tests
   multiple times.

## Product Surfaces And Parity

MOZI is one product with two first-class delivery surfaces:

- **Web:** the Docker-deployed MOZI runtime and Web UI.
- **App:** the installed macOS app, which supervises the packaged MOZI runtime
  and presents the same Web UI as a desktop product.

Shared product behavior must stay synchronized. A user-facing change is assumed
to affect both surfaces unless its Issue and implementation explicitly identify
it as Web-only or App-only.

1. Keep shared UI, API contracts, persistence behavior, model/provider behavior,
   prompts, permissions, artifacts, files, memory, and error states in common
   code. Do not create separate Web and App implementations without a concrete
   platform requirement.
2. Define both surfaces in the Issue and PR acceptance criteria. For a shared
   change, record Web/Docker evidence and installed-App evidence separately;
   passing one surface never proves the other.
3. Build both surfaces from the same commit. Rebuild/restart Docker for Web
   verification and rebuild/reinstall `/Applications/MOZI.app` for App
   verification so stale artifacts cannot masquerade as current behavior.
4. Verify the surfaces sequentially when they share port 9210. Stop one cleanly,
   verify that its listener and owned processes are gone, then start the other.
   Use isolated test data and state which runtime, data home, and artifact are
   being tested.
5. Exercise the same core workflow on both surfaces for shared changes. Add
   platform-specific checks where the environments differ: container mounts,
   auth, reverse proxy, and service health for Web; Finder launch, packaged
   resources, macOS permissions, quit/relaunch, and sidecar ownership for App.
6. If one surface cannot be verified, report that surface as unverified and do
   not call the complete product change done. Track an explicit blocker or
   follow-up Issue rather than silently narrowing the claim.

## Owner Mac Runtime Baseline

The installed macOS app is the owner's normal MOZI entry point. Unless a task
explicitly requires source-mode development, treat `/Applications/MOZI.app` as
the live product runtime and `~/Library/Application Support/MOZI` as its real
data home.

1. Before runtime work, inspect `http://127.0.0.1:9210/api/health` and verify
   that the listener belongs to the installed app. Do not infer runtime identity
   from the port alone.
2. Do not start `pnpm start`, `pnpm start:all`, `pnpm desktop:dev`, or a Docker
   MOZI service alongside the installed app. They compete for port 9210 and can
   produce false test results. The ONLYOFFICE Docker service may remain running.
3. Use source mode only when the change genuinely needs it. Quit the installed
   app gracefully first, isolate development data from the real App Support
   home, and state which runtime is under test.
4. A source build or passing source test does not update the installed app.
   After a change intended for the owner, rebuild the arm64 package, replace
   `/Applications/MOZI.app`, launch that installed copy, and verify the real
   user path before claiming completion.
5. Launch the product with `open -a /Applications/MOZI.app`. Quit it through the
   normal app lifecycle; use forced process termination only after graceful quit
   has demonstrably failed.
6. Never reset, delete, overwrite, or remigrate the real App Support data as a
   test shortcut. Preserve sessions, memory, secrets, files, workspaces, skills,
   agents, model configuration, and artifacts; create and record a rollback
   backup before any required migration.
7. For user-facing bugs, App evidence must come from the installed app,
   including health, the affected UI/API path, clean quit/relaunch, orphan
   process checks, and SQLite integrity when persistence is involved. Complete
   the separate Web/Docker evidence required above before claiming shared
   product completion.

For Claude-specific conventions and deeper repo guidance, also see [CLAUDE.md](CLAUDE.md).
