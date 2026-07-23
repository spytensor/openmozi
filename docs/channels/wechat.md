# WeChat (iLink Bot)

Status: **beta**
Transport: HTTPS long-polling (iLink Bot)
Env var: `WECHAT_BOT_TOKEN`

WeChat does not expose an official bot API for personal accounts. MOZI
uses the **ClawBot / iLink Bot** bridge: a WeChat plugin that opens a
session on your personal account and exposes it over HTTPS. You must own
the WeChat account and install the ClawBot plugin.

## 1. Pair your WeChat account

1. On your phone, open WeChat → **Me** → **Settings** → **Plugins** and
   enable **ClawBot**.
2. On the machine that will run MOZI, install and start the pairing CLI:

   ```bash
   npx -y @tencent-weixin/openclaw-weixin-cli@latest install
   ```

3. Scan the QR code that the CLI prints. On completion the CLI writes a
   `bot_token` to stdout — copy the whole string.

## 2. Configure MOZI

```bash
pnpm mozi onboard
# → at the "Configure WeChat iLink Bot channel?" prompt, choose Yes
# → paste the bot_token
```

The token is persisted to `~/.mozi/.env` as `WECHAT_BOT_TOKEN=…`.

Update later:

```bash
pnpm mozi onboard
# → Update existing setup → Configure WeChat iLink Bot
```

## 3. Limitations

- iLink Bot is **reactive only**. MOZI cannot initiate a conversation, and
  reminders or other proactive notification requests return not delivered.
  There is no queue that sends them after the user's next message.
- If you log out of WeChat on your phone, the bridge disconnects. Rerun
  the pairing CLI to get a fresh token.
- The bridge tunnels through Tencent infrastructure. Treat messages as
  sensitive and avoid secrets.

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| Polling stops after a few hours | Re-pair via the CLI; the token rotates. |
| No response to messages | Check `~/.mozi/logs/mozi.log` for `mozi:wechat` entries. |
| ClawBot plugin missing on phone | Update WeChat to the latest version, toggle Plugins off/on. |
