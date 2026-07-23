# Telegram

Status: **stable**
Transport: HTTPS long-polling (telegraf)
Env var: `TELEGRAM_BOT_TOKEN`

## 1. Create a bot

1. Open Telegram and chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (choose a display name and a
   username ending in `bot`).
3. BotFather returns a token of the form `123456:ABC-DEF…`. Copy it.

Optional hardening:

- `/setprivacy` → **Disable** (so the bot can read every group message).
- `/setjoingroups` → **Enable** (so you can add the bot to groups).
- `/setcommands` — MOZI publishes its own command list on start, you do
  not need to enter it manually.

## 2. Configure MOZI

Run the onboarding wizard:

```bash
pnpm mozi onboard
```

When prompted for *Telegram bot token*, paste the string from BotFather.
The wizard calls `getMe` to validate the token before saving.

Tokens are persisted to `~/.mozi/.env` as `TELEGRAM_BOT_TOKEN=…`.

To change the token later:

```bash
pnpm mozi onboard
# → Update existing setup → Change Telegram bot token
```

## 3. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

Open the bot in Telegram and send `/start`. First-time users trigger the
pairing flow (an approval request that the MOZI owner confirms).

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| `ETIMEDOUT` on start | MOZI forces IPv4-first DNS already; confirm your outbound firewall allows `api.telegram.org`. |
| `Invalid token — Telegram skipped` | The token was rejected by `getMe`. Re-run `/revoke` and `/token` in BotFather, then redo onboarding. |
| Bot reads no group messages | `/setprivacy` → Disable in BotFather. |
| "User not allowed" response | Ask the MOZI owner to `/approve` your pairing request, or set `TELEGRAM_DM_POLICY=open` (development only). |
