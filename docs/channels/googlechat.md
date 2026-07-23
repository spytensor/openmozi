# Google Chat

Status: **beta** — outgoing notifications only
Transport: Incoming Webhook (HTTPS POST to `chat.googleapis.com`)
Env vars: `GCHAT_WEBHOOK_<SPACEKEY>` (one per space)
Routing prefix: `gchat:<space-nickname>`

> This integration is **one-way**: MOZI can post messages into a Google
> Chat space, but users in that space cannot chat back with MOZI.
> Interactive-bot mode requires a Google Workspace bot app +
> Google Cloud project + JWT verification, which is deferred — see
> `docs/channels/UNSUPPORTED.md`.

Use this for: reminders, task-completion notifications, alerts pushed
into a channel the team watches.

## 1. Create an Incoming Webhook

1. Open the target Google Chat space.
2. Click the space name → **Apps & integrations** → **Webhooks**.
3. **Add webhook** → pick a name (e.g. *MOZI*) → optional avatar URL →
   **Save**.
4. Copy the webhook URL. It looks like
   `https://chat.googleapis.com/v1/spaces/<SPACE>/messages?key=…&token=…`.

Repeat for every space you want MOZI to post into.

## 2. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Google Chat (notifications)
# → nickname for the space: team-ops
# → paste webhook URL
```

The wizard posts a test message to the space to verify the URL. If you
want to set up additional spaces later, either re-run the wizard or
add env vars by hand in `~/.mozi/.env`:

```
GCHAT_WEBHOOK_TEAMOPS=https://chat.googleapis.com/v1/spaces/AAAA/messages?...
GCHAT_WEBHOOK_ALERTS=https://chat.googleapis.com/v1/spaces/BBBB/messages?...
```

## 3. How chatIds map

MOZI's internal routing uses `gchat:<nickname>`. The nickname is
normalised by uppercasing and stripping non-alphanumerics, so the env
var name is `GCHAT_WEBHOOK_<UPPERCASE>`:

| chatId | env var |
|---|---|
| `gchat:team-ops` | `GCHAT_WEBHOOK_TEAMOPS` |
| `gchat:alerts` | `GCHAT_WEBHOOK_ALERTS` |

Any tool or scheduled job that calls `notify(chatId, text)` with one of
these ids will deliver to the matching space.

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| `HTTP 401 Invalid credentials` | Webhook URL revoked/expired. Recreate the webhook in the space settings. |
| `HTTP 403` | Your Workspace admin disabled Chat webhooks. They need to re-enable under Admin console → Apps → Google Chat. |
| `HTTP 400 Invalid argument` | Body exceeded 4096 chars. MOZI chunks at 4000 but a single giant word may overflow — rare. |
| Nothing appears in the space | Double-check you copied the URL from the Webhooks panel, not the address bar. URLs contain `key=` and `token=` query params. |

## 5. Privacy note

The webhook URL is a bearer credential: anyone with it can post as the
"MOZI" bot in that space. Keep it out of public logs and CI runners.
Rotate by deleting/recreating the webhook in the space settings.
