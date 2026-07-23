# Onboarding Config Write Contract

This document defines the single write contract for `mozi onboard` (wizard; legacy alias: `mozi init`) and Telegram onboarding.

## Goal

Avoid drift between onboarding flows and prevent future changes from silently missing required writes.

## Single Source of Truth

All onboarding persistence must go through:

- `src/onboarding/persistence.ts`

No direct `writeFileSync(mozi.json)` or ad-hoc secret-storage update logic should be added in onboarding flows.

## Write Targets

### `mozi.json` (non-secret runtime config)

Required by onboarding:

- `workspace.dir`
- `server.host`
- `server.port`
- `server.auth_mode`

Writer functions:

- `saveWorkspaceDirToConfig`
- `saveServerDefaultsToConfig`
- `saveWizardRuntimeConfig`

### Secret storage (`.env` or encrypted secret store)

Required when provided by user:

- `SEARCH1API_KEY`
- Provider keys (`*_API_KEY`, `*_BASE_URL`, custom provider key)
- Channel-plugin credentials (dynamic): each registered channel
  declares its own `envKeys` — e.g. `TELEGRAM_BOT_TOKEN`,
  `DISCORD_BOT_TOKEN`, `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`,
  `MATRIX_HOMESERVER` + `MATRIX_USER_ID` + `MATRIX_ACCESS_TOKEN`,
  `GCHAT_WEBHOOK_<KEY>`, ... The wizard reads the list at runtime
  from `channelRegistry.list()`.

Writer functions:

- `upsertEnvVar`
- `persistSearchKey`
- `persistEnvValue(key, value)` — generic writer used by every
  channel plugin's `runWizard()` return value

## Flow Requirements

### Wizard (`mozi onboard`)

- Must use `saveWizardRuntimeConfig(workspaceDir)` at completion.
- Must persist entered keys via `persistence.ts` helpers.
- Must run `validateOnboardingWriteContract(...)` before marking onboarding complete.
- Required secrets may live in either `.env` or the encrypted secret store; validation must accept both.

### Channel-plugin credentials

Channel credentials are **never** written by `wizard.ts` directly. Instead:

- `src/onboarding/channels.ts#runChannelSelection()` iterates
  `channelRegistry.list()`, calls each selected plugin's `runWizard()`,
  and persists the returned `env` map via `persistEnvValue(key, value)`.
- Each plugin owns its own validation (e.g. Discord calls
  `client.login(token)`, Telegram calls `getMe`, LINE calls `/v2/bot/info`);
  the wizard never saves credentials that failed validation.
- Adding a new channel means adding a plugin file; this contract does
  not need an update unless the persistence path itself changes.

### Telegram Onboarding (chat-initiated setup)

- Must use `saveWorkspaceDirToConfig` + `saveServerDefaultsToConfig` when workspace is set.
- Must persist `SEARCH1API_KEY` and `TELEGRAM_BOT_TOKEN` through `persistence.ts`.
- Must not introduce a second write path for the same key.

## Change Checklist (Mandatory)

When adding a new onboarding field (generic, non-channel):

1. Add/update writer in `src/onboarding/persistence.ts`.
2. Wire both flows (`src/onboarding/wizard.ts`, `src/onboarding/index.ts`) to that writer.
3. Extend `validateOnboardingWriteContract` if the new field is contract-critical.
4. Add/update tests in `src/onboarding/persistence.test.ts` (and flow tests if needed).
5. Update this document if the contract changed.

When adding a new **channel**:

1. Create `src/channels/<id>.ts` with the transport + `validate*` helper.
2. Create `src/channels/plugins/<id>.ts` implementing `ChannelPlugin` (including `runWizard`).
3. Register the plugin in `src/channels/plugins/index.ts`.
4. Add `docs/channels/<id>.md` covering credential acquisition + troubleshooting.
5. Add unit tests (`src/channels/<id>.test.ts`) — at minimum message chunking, chatId routing, and event normalization.
6. Update `docs/channels/README.md` with the new row.
7. No change needed to this contract, `wizard.ts`, or `persistence.ts`.

## Security Rule

Secrets belong in secret storage (`.env` or encrypted store), not in `mozi.json`.
