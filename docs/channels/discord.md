# Discord

Status: **stable**
Transport: Discord Gateway (WebSocket, via `discord.js@14`)
Env var: `DISCORD_BOT_TOKEN`
Routing prefix: `discord:<channelId>`

## 1. Create an application and bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → name it (e.g. "MOZI").
3. Left sidebar → **Bot** → **Reset Token** → copy the token. Treat it
   like a password; you won't be able to view it again.
4. Still on the **Bot** page, scroll to **Privileged Gateway Intents** and
   toggle **MESSAGE CONTENT INTENT** on. Save. Without this, the bot
   receives empty `content` strings.

## 2. Invite the bot to a server

1. **OAuth2** → **URL Generator**.
2. Scopes: check `bot` and `applications.commands`.
3. Bot Permissions: minimum `Send Messages`, `Read Message History`,
   `Embed Links`, `Attach Files`.
4. Copy the generated URL, paste it into a browser while logged in as
   someone with *Manage Server* on the target guild, and authorize.

## 3. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Discord
# → paste the bot token
```

The wizard calls `client.login()` to validate the token before saving.
Stored as `DISCORD_BOT_TOKEN` in `~/.mozi/.env` (encrypted when a master
key is set).

Update later:

```bash
pnpm mozi onboard
# → Update → Configure Discord
```

## 4. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

Any user with access to the bot can send a message in a channel where it
has read permissions, or DM it directly. MOZI replies in the same
channel; messages over 2000 chars are split on newline/space boundaries.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `Used disallowed intents` on login | You enabled the MESSAGE CONTENT INTENT in the portal, but the bot is still on an old gateway session. Restart MOZI. |
| Bot receives messages but `content` is `""` | MESSAGE CONTENT INTENT is still off, or your bot is in 100+ servers and needs a verification. Toggle the intent and save. |
| Replies don't appear in a channel | Bot lacks `View Channel` or `Send Messages`. Check channel-level overrides, not just server-wide perms. |
| `Invalid token` from wizard | You copied a client secret instead of the bot token. Use the **Bot** page, not **OAuth2**. |
| Rate limited | Discord returns 429 with a `retry_after`; discord.js handles backoff automatically. If sustained, MOZI is sending too fast — check log spam from a looped tool. |

## 6. Privacy note

The bot token grants full read/write access to every channel the bot is
in. Revoke it from the Developer Portal (**Bot** → **Reset Token**) if
it leaks; MOZI will stop connecting once the old token is revoked.
