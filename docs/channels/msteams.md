# Microsoft Teams

Status: **beta** — outgoing notifications only
Transport: Incoming Webhook (Teams Workflow or legacy O365 Connector)
Env vars: `TEAMS_WEBHOOK_<CHANNELKEY>` (one per channel)
Routing prefix: `teams:<channel-nickname>`

> This integration is **one-way**: MOZI posts into a Teams channel; users
> in the channel cannot chat back with MOZI. Interactive-bot mode needs
> Azure Bot Services + a public URL and is deferred — see
> `docs/channels/UNSUPPORTED.md`.

Use cases: CI/CD notifications, agent-loop status summaries, reminders.

## 1. Create the webhook

Microsoft is migrating from "Incoming Webhook" (legacy O365 Connectors)
to **Workflows**. Both still work; pick whichever your tenant allows.

### Option A — Workflow (recommended)

1. In Teams, open the target channel.
2. Click **⋯** on the channel → **Workflows**.
3. Search for "Post to a channel when a webhook request is received".
4. Name the workflow (e.g. *MOZI*) → **Next**.
5. Confirm the team and channel → **Add workflow**.
6. Copy the generated URL. It looks like
   `https://prod-…logic.azure.com/workflows/…?api-version=…`.

### Option B — Legacy Incoming Webhook

If your tenant still allows Incoming Webhook connectors:

1. Channel **⋯** → **Connectors** → **Incoming Webhook** → **Add**.
2. Name it, optionally upload an avatar → **Create**.
3. Copy the URL — `https://<tenant>.webhook.office.com/webhookb2/…`.

## 2. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Microsoft Teams (notifications)
# → nickname: eng-alerts
# → paste webhook URL
```

The wizard posts a test message to verify.

For additional channels, add env entries by hand:

```
TEAMS_WEBHOOK_ENGALERTS=https://prod-123.eastus.logic.azure.com/...
TEAMS_WEBHOOK_RELEASES=https://contoso.webhook.office.com/webhookb2/...
```

## 3. How chatIds map

| chatId | env var |
|---|---|
| `teams:eng-alerts` | `TEAMS_WEBHOOK_ENGALERTS` |
| `teams:releases` | `TEAMS_WEBHOOK_RELEASES` |

Non-alphanumerics are stripped from the nickname before forming the
env var name.

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| Wizard rejects URL as "not a Teams webhook" | Must be `*.webhook.office.com` or `*.logic.azure.com`. Copy the URL exactly as Teams/Logic Apps gave it. |
| 400 / 401 on send | Webhook revoked or the channel was archived. Recreate the workflow. |
| 413 Payload Too Large | Teams enforces ~28k per message; MOZI chunks at 27k. If a single long-word exceeds 27k, reduce it. |
| Admin disabled Connectors | Use Option A (Workflow). Legacy connectors are on a sunset timeline. |

## 5. Privacy note

The webhook URL is a bearer credential: anyone holding it can post as
your MOZI workflow into the channel. Keep it out of public logs. Rotate
by deleting the workflow / connector and creating a new one.
