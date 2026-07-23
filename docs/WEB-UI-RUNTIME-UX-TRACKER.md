# Web UI Runtime UX Hardening Tracker

This tracker is the current source of truth for the post-#313 Web UI workstream.
It supersedes older placeholder/demo wording in `docs/LOVABLE-UI-SPEC.md` where
that document conflicts with the requirements below.

## Context Lock

MOZI is the user-facing agent runtime. The Web UI is the primary interface.
The UI must preserve the current Lovable workspace palette and layout direction,
but it must not remain a demo shell around runtime internals.

The current verified baseline after PR #313:

- The Web UI runs at `http://127.0.0.1:9210`.
- Session timeline restore persists user messages, assistant streams, tool events,
  task progress, approvals, and artifacts.
- The chat rail and composer are visually aligned with the current Lovable-style
  workspace.
- Real task execution works, but the runtime event presentation still exposes
  low-level tool and shell details.

## Non-Negotiable Product Rules

1. Do not hard-code user-facing language in components or runtime event mappers.
2. Do not mix English and Chinese in the same UI session unless the selected
   locale intentionally does so for a technical identifier.
3. Locale selection must be explicit and recoverable:
   - user setting
   - persisted local preference
   - default fallback
4. Runtime data may contain command names, paths, tool ids, worker ids, and raw
   error payloads. The default UI must translate those into user-level actions.
5. Raw technical details are allowed only behind an explicit "technical details"
   affordance.
6. The UI must never imply fake progress. It can show only runtime events that
   exist, plus deterministic derived presentation from those events.
7. Every UI hardening PR must include a real browser verification path with
   screenshots or smoke evidence.

## Locale Architecture Requirement

The implementation must add a small i18n layer before broad copy cleanup.
Do not solve this by replacing individual strings one by one.

Required shape:

- `ui/src/i18n/`
  - locale registry
  - message dictionaries
  - typed translation keys
  - formatter helpers for dates, relative time, counts, statuses, and runtime
    event labels
- `useLocale()` hook or equivalent app-level provider.
- Settings entry for language selection.
- Tests that fail if a component directly introduces new user-visible strings
  outside the translation registry, with an allowlist for technical identifiers.

Initial locales:

- `en`
- `zh-CN`

The default should be deterministic and documented. The user can change it from
Settings; future account sync can move this preference server-side.

## Workstream Issues

GitHub tracker:

- Epic: #314
- P0 UI locale foundation: #315
- P0 task run UX contract: #316
- P1 Settings IA: #317
- P1 System diagnostics split: #318
- P1 Skills as capabilities: #319
- P1 Projects contract: #320
- P2 legacy view cleanup: #321

### P0-1: UI Locale Foundation (#315)

Goal: remove hard-coded UI language as an architecture pattern.

Acceptance:

- App shell, sidebar, composer, chat runtime labels, Settings, System, and Skills
  route through the i18n layer for user-visible text.
- Relative time and dates use locale-aware formatters.
- Existing English/Chinese mixed labels in one session are eliminated except for
  technical identifiers such as model names, paths, branch names, and provider ids.
- Browser smoke verifies both `en` and `zh-CN` render without layout breakage.

### P0-2: Task Run UX Contract (#316)

Goal: make real task execution readable from a user's point of view.

Acceptance:

- The first running state after send is visible and specific, not an empty rail
  with only typing dots.
- Default execution rows use user actions such as "checking runtime status",
  "reading configuration", "verifying database", and "summarizing result".
- Shell commands, tool ids, call ids, and raw payloads are hidden by default.
- Technical details remain available in a collapsed section.
- Restored timelines render the same user-level run narrative after refresh.
- User can see whether work is running, completed, blocked, or waiting for input.

### P1-1: Settings Information Architecture (#317)

Goal: Settings becomes the single place for account, model, locale, workspace,
privacy, service, and advanced preferences.

Acceptance:

- Account menu routes to Settings instead of a duplicate or placeholder profile.
- Settings includes Account, Language, Model & Provider, Workspace Roots,
  MOZI Status, Privacy & Logs, and Diagnostics sections.
- Existing `UserSettings` code is either integrated or removed.
- No fake profile fields are displayed as real account state.

### P1-2: Settings Diagnostics Split (#318)

Goal: runtime/system diagnostics are available for troubleshooting without making
System a primary everyday workspace entry.

Acceptance:

- Sidebar does not expose System as a standalone entry for ordinary users.
- Settings shows user-level MOZI status by default.
- Opening Settings Diagnostics shows runtime health, active work, storage, memory,
  workers, and recorded failures in user-level language.
- Raw paths and log tail are hidden behind the nested advanced diagnostics toggle.
- Service state distinguishes "current daemon is running" from "launchd/systemd
  background service is installed".
- Spelling and status copy are localized.

### P1-3: Skills As Capabilities (#319)

Goal: Skills page represents usable runtime capabilities, not only a static card
grid.

Acceptance:

- Skills show source, status, sandbox/permission profile, trigger/use cases,
  health, and recent use/failure signal where available.
- User can search and inspect a skill without seeing internal ids as primary
  labels.
- Disabled/unavailable skills explain why.

### P1-4: Projects Contract (#320)

Goal: Projects becomes a real work context, not a path list.

Acceptance:

- A project root groups conversations, tasks, artifacts, and workspace metadata.
- Selecting a project clearly scopes a new chat and the composer context.
- Sidebar project rows expose meaningful labels and state, not only branch/path
  fragments.

### P2-1: Legacy View Cleanup (#321)

Goal: remove or re-home old UI surfaces that no longer match the primary
workspace model.

Acceptance:

- `DashboardView`, `MemoryView`, `SchedulerView`, `SessionSidebar`, and other
  legacy surfaces are either connected to the current navigation model or removed.
- No unreachable demo view remains without an explicit issue and owner.

## Implementation Status — 2026-07-02

Branch: `codex/mozi-web-ui-i18n-runtime-ux`
PR: #322

### #317 Settings IA

Status: implemented.

- Settings now uses the current workspace layout instead of the centered
  placeholder panel.
- Account, language, provider state, workspace roots, MOZI status, security,
  privacy/logs, and diagnostics sections are grouped on one page.
- Logout is available from the account section and the account menu; it is no
  longer a standalone sidebar item.
- Provider key state no longer reports `Key set` unless the loaded runtime config
  actually exposes a configured key.
- Fake profile/statistics UI was removed rather than replaced with fabricated
  data.

### #318 Settings Diagnostics Split

Status: implemented.

- System is no longer a standalone sidebar item.
- Settings exposes user-level MOZI status by default.
- Settings Diagnostics can be expanded to show runtime health, current daemon
  state, background service installation state, storage, active work, memory,
  workers, task state, and background work.
- Raw paths/log-tail style diagnostics are hidden behind the nested advanced
  diagnostics toggle.
- The failure metric is labeled as recorded failures rather than recent failures.
- The diagnostics view is width constrained and verified without horizontal
  scrolling inside the Settings scroll frame.

### #319 Skills As Capabilities

Status: implemented.

- `/api/skills` now returns runtime readiness fields: source, eligibility,
  missing binaries/environment, user invocability, origin, and sandbox profile.
- Skills page supports search and readiness filters.
- Built-in skills render localized user-facing names and descriptions; technical
  ids are retained only as secondary metadata.
- Sandbox profile labels are localized instead of exposing raw enum ids as the
  primary user contract.

### #320 Projects Contract

Status: implemented.

- Sessions now persist `workspace_root_id` and `workspace_context` in SQLite.
- New chat creation and project selection both send the project context through
  the session API, not only through local UI state.
- Refresh restores the selected project context into the chat workspace and
  composer.
- Existing chats with runtime project metadata are associated with that project
  and remain recoverable after refresh.
- Sidebar project rows show user-facing labels while preserving branch/path
  hints as secondary context.
- A full project hub can be added later as a separate enhancement, but the #320
  acceptance boundary is the persisted project-scoped chat/composer contract.

### #321 Legacy View Cleanup

Status: implemented.

- Removed demo/legacy surfaces that no longer matched the workspace model:
  dashboard cards, memory/scheduler views, old session sidebar, old task/tool
  cards, admin placeholder, duplicate pairing gate, old top bar/nav rail, and
  obsolete dashboard hook.
- Current navigation is Chat/Projects, Skills, and Account/Settings. Runtime
  diagnostics are re-homed under Settings.

### Verification Evidence

- `git diff --check`: passed.
- `pnpm --filter mozi-ui exec tsc --noEmit`: passed.
- `pnpm --filter mozi-ui test -- --run`: 18 files / 47 tests passed.
- `PATH=/opt/mozi/node/bin:$PATH pnpm exec vitest run --config vitest.unit.config.ts src/skills/workspace-manager.test.ts src/skills/loader.test.ts src/memory/sessions.test.ts`: 57 tests passed.
- `pnpm build:all`: passed.
- Root `pnpm exec tsc --noEmit` still fails on pre-existing full-repo type debt,
  but a changed-file filter produced no errors for this workstream's backend
  files.
- Live runtime at `http://127.0.0.1:9210`: restarted from `dist/index.js`, PID
  78529, health page visible in browser.
- SQLite verification: latest OpenClaw session persists
  `workspace_root_id=project_root:/Users/example/projects/OpenMozi` and
  `workspace_context.rootPath=/Users/example/projects/OpenMozi`.
- Browser screenshots:
  - `output/playwright/ui-317-321/01-chat-project-context.png`
  - `output/playwright/ui-317-321/03-settings.png`
  - `output/playwright/ui-317-321/06-skills.png`
  - `output/playwright/web-ui-diagnostics-layout.png`
  - `output/playwright/web-ui-settings-layout.png`

## Verification Protocol

Each PR in this workstream must run:

- `git diff --check`
- targeted unit/UI tests for touched components
- `pnpm --filter mozi-ui test`
- relevant backend tests when runtime/API contracts change
- `pnpm build:all`
- `pnpm test:e2e:web -- --skip-build`
- real browser screenshots for changed surfaces

For runtime/task UX changes, also run one real read-only task through
`http://127.0.0.1:9210`, capture:

- before send
- early running state
- mid-run event state
- final state
- refresh/restore state

Temporary audit sessions must be archived after verification.

## Context-Compression Guardrail

If an agent resumes this work after context compaction, it must first read this
file, then inspect the linked GitHub issues, then verify the live branch and
`http://127.0.0.1:9210` runtime state before claiming progress.
