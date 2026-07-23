# Matrix

Status: **stable** (unencrypted rooms only)
Transport: HTTPS /sync (via `matrix-js-sdk`)
Env vars: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`
Routing prefix: `matrix:<roomId>` — e.g. `matrix:!room:matrix.org`

> **Encryption note**: MOZI does not currently decrypt end-to-end
> encrypted rooms. Invite the bot to unencrypted rooms only, or disable
> encryption on a dedicated room. E2E support needs Olm/vodozemac plus
> a persistent crypto store — deferred to a future release.

## 1. Pick a homeserver

Options:

- **matrix.org** — free, managed, accepts signups at
  <https://app.element.io/#/register>.
- **Self-hosted** (Synapse, Dendrite, Conduit) — you control the whole
  thing. Same API; the URL is just different.
- **Beeper, EMS, etc.** — commercial hosts. Works fine.

## 2. Create a dedicated user

Register `mozi-bot` (or any name you like) on the homeserver. **Do not
reuse your personal account** — the access token grants full read/write
access to everything it can see, including your DMs.

## 3. Get an access token

Easiest: sign in as the MOZI user in Element Web →
**Settings → Help & About → Access Token** → copy. Starts with `syt_`.

Alternatively, log in via REST:

```bash
curl -X POST 'https://matrix.org/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"mozi-bot","password":"..."}'
```

Copy `access_token` from the response.

## 4. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Matrix
# → homeserver: https://matrix.org
# → user id: @mozi-bot:matrix.org
# → access token: syt_...
```

The wizard calls `/_matrix/client/v3/account/whoami` to verify the
token and cross-check the user id.

## 5. Invite the bot to rooms

From your personal account, in an **unencrypted** room:

```
/invite @mozi-bot:matrix.org
```

MOZI starts syncing immediately after startup; once the invite is
accepted (server-side auto-accept via MOZI's handler can be added
later) it will respond to messages.

## 6. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

Messages in any joined room dispatch to MOZI. Replies post back as
`m.room.message` / `m.text`.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `M_UNKNOWN_TOKEN` | Access token expired or was logged out elsewhere. Regenerate. |
| Wizard: "Token belongs to @X" | Access token and user id don't match. Re-copy the token from the correct account. |
| Bot joins room but doesn't respond | Room is end-to-end encrypted; MOZI can't decrypt yet. Disable E2EE on the room or use a different one. |
| Sync stuck after startup | Homeserver is very slow; the initial sync can take minutes on large accounts. Consider a fresh MOZI user. |
| `M_LIMIT_EXCEEDED` | Homeserver rate-limits; matrix-js-sdk backs off automatically. |

## 8. Privacy note

The access token is the MOZI user's password equivalent. If it leaks:

```bash
# Log out everywhere to invalidate ALL tokens on that account
curl -X POST 'https://matrix.org/_matrix/client/v3/logout/all' \
  -H "Authorization: Bearer syt_..."
```

Then sign back in to get a fresh token and update MOZI.
