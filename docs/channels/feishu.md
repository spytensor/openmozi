# Feishu / Lark

Status: **stable**
Transport: Long-connection WebSocket (`@larksuiteoapi/node-sdk` WSClient) +
REST `im.v1.message.create` for sending
Env vars: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`
(`feishu` or `lark`)
Routing prefix: `feishu:<chatId>` (the Feishu-side `chat_id`)

The WebSocket long-connection mode means MOZI does **not** need a
public URL. The SDK opens an outbound connection to Feishu's event
gateway and receives events over it.

## 1. Create a custom app

1. Pick the right console:
   - **Feishu (国内)**: <https://open.feishu.cn/app>
   - **Lark (international)**: <https://open.larksuite.com/app>
2. **Create Custom App** → pick a name (e.g. *MOZI*).

## 2. Credentials

**Credentials & Basic Info** → copy:

- **App ID** (`cli_…`) → `FEISHU_APP_ID`
- **App Secret** → `FEISHU_APP_SECRET`

## 3. Enable the bot

**Features → Bot** → enable the bot capability. Give it a name and
avatar. Without this, the app cannot send or receive chat messages.

## 4. Permissions

**Permissions & Scopes** → add at least:

- `im:message` — read messages
- `im:message.group_at_msg` or `im:message.p2p_msg` — receive messages
  from groups / direct chats
- `im:message:send_as_bot` — send messages
- `im:chat` — look up chat info

Click **Save**.

## 5. Event subscriptions — long connection

**Event Subscriptions** tab:

1. **Delivery method**: pick **Long Connection (WebSocket)** — this is
   the key setting that removes the public-URL requirement.
2. **Subscribed events**: add `im.message.receive_v1`.
3. Click **Save**.

## 6. Publish

**Version Management & Publish** → **Create Version** → fill in change
notes → submit. Enterprise admins need to approve for the app to reach
users.

## 7. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check Feishu / Lark
# → pick Feishu or Lark
# → paste App ID
# → paste App Secret
```

The wizard requests an `app_access_token` to validate the credentials
before saving.

Tokens persist to `~/.mozi/.env`:

```
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
FEISHU_DOMAIN=feishu   # or "lark"
```

## 8. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

Add the bot to a group, or DM it directly. MOZI receives events over
the long connection and replies via REST.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Wizard: "Invalid credentials" | App ID / secret wrong, or the app is not yet approved inside the tenant. |
| WSClient fails to connect | Confirm outbound HTTPS/WebSocket to `open.feishu.cn` / `open.larksuite.com` is not blocked. |
| Bot receives no messages | `im.message.receive_v1` not subscribed, or the app version isn't published/approved yet. |
| Bot cannot be added to groups | Enable "Add bot to groups" toggle under **Bot** settings. |
| `UNAUTHORIZED` on send | Missing `im:message:send_as_bot` scope — add, re-publish, re-approve. |

## 10. Privacy note

The app secret acts as the bot's password. If it leaks, rotate it from
the console's **Credentials & Basic Info** tab; MOZI will need the new
secret.
