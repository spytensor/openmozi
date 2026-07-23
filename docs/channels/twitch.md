# Twitch Chat

Status: **stable**
Transport: IRC-over-WSS (`tmi.js`)
Env vars: `TWITCH_USERNAME`, `TWITCH_OAUTH_TOKEN`, `TWITCH_CHANNELS`
Routing prefix: `twitch:<lowercased-channel>`

## 1. Pick a bot account

You can use your personal Twitch account, but most streamers create a
dedicated one (e.g. `mystream_bot`). The bot account needs **Email
Verified** enabled so it can chat.

## 2. Get an OAuth token

Visit <https://twitchtokengenerator.com/> while logged in as the bot
account.

- Pick **Bot Chat Token** (or **Custom Scope**).
- Enable scopes:
  - `chat:read` — required
  - `chat:edit` — required to post
- Authorize → copy the **Access Token** (starts with `agptg…` or
  similar). Do **not** copy the Refresh Token; MOZI only uses Access.

Alternative: if you already have a Twitch app, generate an
implicit-flow token with the same scopes.

## 3. Mod the bot

In your channel:

```
/mod mozi_bot
```

Modded accounts bypass the harsh Twitch rate-limits (20 msg / 30 s for
non-mods → 100 msg / 30 s for mods).

## 4. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Twitch Chat
# → bot username: mozi_bot
# → OAuth access token
# → channels: your_channel,other_channel
```

The wizard calls `https://id.twitch.tv/oauth2/validate` to confirm the
token has `chat:read` + `chat:edit` scopes and matches the username.

## 5. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

MOZI joins the configured channels and replies to chat. Twitch messages
have a 500-char limit; MOZI chunks at 450 and splits on word boundaries
to avoid mid-word truncation.

## 6. Proactive messages

Use `notify('twitch:streamname', text)` to push a proactive message
into a specific channel. The channel must be in `TWITCH_CHANNELS` at
start time — `tmi.js` doesn't auto-join new channels at runtime.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Login authentication failed` | Token expired or has wrong scopes. Regenerate with `chat:read` + `chat:edit`. |
| `Improperly formatted auth` | You pasted the token without the `oauth:` prefix — MOZI adds it automatically, but some generators include it anyway. Either way is fine. |
| Bot joins but can't post | Account isn't email-verified. Verify on twitch.tv first. |
| Messages get ratelimited | `/mod mozi_bot` in the channel. |
| `USERSTATE` flood in logs | Normal; tmi.js emits USERSTATE every N messages. |

## 8. Privacy note

Twitch chat messages are public in the channel by default. Do not send
anything sensitive. Revoke the OAuth token at
<https://www.twitch.tv/settings/connections> if it leaks.
