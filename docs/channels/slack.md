# Slack

Status: **stable**
Transport: Socket Mode (WebSocket) via `@slack/socket-mode` + `@slack/web-api`
Env vars: `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`
Routing prefix: `slack:<channelId>`

Socket Mode is used so MOZI does not need to expose a public HTTPS URL
for event delivery. All event traffic rides over an outbound WebSocket
that Slack keeps open.

## 1. Create the Slack app

1. Visit <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name the app (e.g. *MOZI*) and pick your workspace.

## 2. Enable Socket Mode + app-level token

1. Left sidebar → **Socket Mode** → **Enable**.
2. When prompted, generate a new **App-Level Token** with scope
   `connections:write`. Copy it — it starts with `xapp-…`. This is
   `SLACK_APP_TOKEN`.

## 3. Bot token scopes

Left sidebar → **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:

- `chat:write`
- `app_mentions:read`
- `im:history`
- `channels:history`
- `groups:history`
- `mpim:history`

If you want MOZI to receive plain channel messages (not just mentions),
the `*:history` scopes are required.

## 4. Event subscriptions

Left sidebar → **Event Subscriptions** → **Enable Events**. Under
**Subscribe to bot events**, add:

- `app_mention`
- `message.im`
- `message.channels` *(if you want channel messages, not only DMs)*
- `message.groups` *(optional — private channels)*
- `message.mpim` *(optional — multi-person DMs)*

You do **not** need a Request URL when using Socket Mode.

## 5. Install the app

Left sidebar → **Install App** → **Install to Workspace** → approve the
scopes. After installation, **Bot User OAuth Token** appears (starts
with `xoxb-…`). This is `SLACK_BOT_TOKEN`.

## 6. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Slack
# → paste xapp-... token
# → paste xoxb-... token
```

The wizard calls `auth.test` to validate the bot token before saving.

Update later:

```bash
pnpm mozi onboard
# → Update → Configure Slack
```

## 7. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

`/invite @MOZI` in a channel, or send the bot a DM. Replies land in the
same channel, threaded on the original message to reduce noise.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `not_allowed_token_type` on start | You pasted `xoxp-…` (user token) as bot token. Use `xoxb-…`. |
| `missing_scope` | Add the missing scope in **OAuth & Permissions**, then **Reinstall to Workspace**. |
| No events for channel messages | You only subscribed to `message.im`. Add `message.channels` *and* give the bot `channels:history`, *and* `/invite` it to the channel. |
| Socket disconnects loop | The App-Level Token was rotated. Generate a new one and update `SLACK_APP_TOKEN`. |
| Messages appear twice | You enabled both Socket Mode and an HTTP Request URL. Disable the HTTP one. |

## 9. Privacy note

`im:history` grants the bot read access to every DM it's in. Admins can
audit this via Slack's admin tools. Revoke the tokens from the app
settings page if either leaks; MOZI stops connecting immediately.
