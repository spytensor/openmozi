# Mattermost

Status: **stable**
Transport: REST + WebSocket (`@mattermost/client`)
Env vars: `MATTERMOST_URL`, `MATTERMOST_ACCESS_TOKEN`
Routing prefix: `mattermost:<channel_id>`

## 1. Enable Personal Access Tokens (admin, one-time)

By default, Mattermost admins disable Personal Access Tokens. Enable
them from **System Console → Integrations → Integration Management →
Enable Personal Access Tokens = true**.

Also enable **Enable Bot Account Creation** if you want MOZI to run as
a bot account instead of a regular user.

## 2. Create the bot account

Two options:

- **Bot account** (preferred): **Integrations → Bot Accounts → Add
  Bot** → pick a username → create. Copy the token the page shows —
  this is your `MATTERMOST_ACCESS_TOKEN`. You won't see it again.
- **Regular user**: create a user (e.g. `mozi-bot`) → log in as that
  user → **Profile picture → Profile → Security → Personal Access
  Tokens → Create**. Copy the token.

## 3. Invite the bot

Add the bot/user to any channels you want it to respond in. Bots do
not auto-join channels.

## 4. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Mattermost
# → server URL: https://chat.example.com
# → paste token
```

The wizard calls `/api/v4/users/me` to validate the token.

## 5. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

MOZI opens a WebSocket to the server, receives `posted` events for
every channel the bot is in, and replies in the same channel via REST
`createPost`.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `{"status_code":401}` from wizard | Token expired or the bot was disabled. Regenerate. |
| Bot connected but sees no messages | Bot isn't a member of the channel — `@mention` and invite it. |
| `{"status_code":403}` on post | Missing the `create_post` scope, or the channel is archived. |
| WebSocket reconnects in a loop | Server behind Cloudflare / proxy timing out long-lived connections. Increase the proxy idle timeout. |
| `413 Payload Too Large` | `MaxPostSize` setting is below 16k. MOZI chunks at 16k by default; lower it by editing `MM_MAX_LENGTH` if needed. |

## 7. Privacy note

A Personal Access Token grants full account access: read/write every
channel the user is in, read user list, create channels. If it leaks,
revoke from **Security → Personal Access Tokens → Delete**.
