# LINE (Messaging API)

Status: **stable**
Transport: HTTPS webhook + REST reply/push (`@line/bot-sdk`)
Env vars: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`
Routing prefix: `line:<userId|groupId|roomId>`

> **Important:** LINE pushes events to MOZI over an HTTPS webhook. You
> need a public HTTPS URL that forwards to the machine running MOZI. On
> a laptop, use `ngrok`, `cloudflared tunnel`, or similar. LINE only
> accepts certificates signed by a public CA — self-signed will be
> rejected.

## 1. Create the LINE channel

1. Go to the [LINE Developers Console](https://developers.line.biz/console).
2. Create a **Provider** (your organization).
3. Under the provider, create a new channel of type **Messaging API**.

## 2. Collect credentials

In the channel:

- **Basic settings** tab → copy **Channel secret** → `LINE_CHANNEL_SECRET`.
- **Messaging API** tab → scroll to **Channel access token (long-lived)**
  → click **Issue** → copy → `LINE_CHANNEL_ACCESS_TOKEN`.

## 3. Expose MOZI to the internet

Pick one:

- **Cloud VM / server with public DNS**: point `yourdomain.com` at MOZI.
- **Laptop with ngrok**:
  ```bash
  ngrok http http://localhost:9210
  ```
  Note the `https://<random>.ngrok-free.app` URL.
- **Cloudflare Tunnel** (free, stable):
  ```bash
  cloudflared tunnel --url http://localhost:9210
  ```

MOZI's default port comes from `config/server.port` (default `9210`).

## 4. Configure the webhook

Back in the LINE console → **Messaging API** tab:

- **Webhook URL**: `https://<your-public-url>/webhooks/line`
- Click **Verify**. LINE pings the URL; the response should be 200.
- Toggle **Use webhook** to **On**.
- In **LINE Official Account features** (below the webhook settings):
  - Disable **Auto-reply messages**.
  - Disable **Greeting messages** (optional but recommended).

## 5. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check LINE
# → paste channel access token
# → paste channel secret
```

The wizard calls `/v2/bot/info` to validate the access token before
saving.

## 6. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

Add the bot as a friend via the QR code on the **Messaging API** tab.
Send it a message — MOZI replies in the same conversation, using LINE's
`replyMessage` API (free of quota).

This adapter currently accepts text messages only. Images, audio, video,
files, and stickers are not processed; the bot replies with an explicit
text-only notice instead of silently dropping them.

Proactive notifications (e.g. reminders) use `pushMessage` which
consumes your channel's monthly push quota.

## 7. Groups and rooms

For MOZI to receive events from LINE **groups** and **rooms**, enable
**Allow bot to join group chats** in **LINE Official Account features**
on the admin site. The `chatId` for a group looks like
`line:C<32 hex>`, for a room `line:R<32 hex>`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Verify fails with 401 | `LINE_CHANNEL_SECRET` wrong. HMAC-SHA256 signatures are validated on every POST. |
| Verify fails with 404 | Webhook URL path wrong — must end in `/webhooks/line`. |
| Verify fails with network error | Your tunnel isn't live, or MOZI isn't running on the expected port. |
| Receive messages, no reply | `replyToken` expires in 30 seconds — slow handlers can miss it. Check logs. |
| "You have exceeded quota" on push | Upgrade LINE plan or reduce proactive notifications. |
| Self-signed cert rejected | Use ngrok/cloudflared (public CA) or a real domain — LINE refuses self-signed. |

## 9. Privacy note

The channel access token grants read and reply access to every
conversation the bot is in. Regenerate it from **Messaging API** tab →
**Reissue** if it leaks.
