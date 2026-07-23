# IRC

Status: **stable**
Transport: TCP / TLS (via `irc-framework`)
Env vars: `IRC_HOST`, `IRC_PORT`, `IRC_TLS`, `IRC_NICK`,
  `IRC_CHANNELS`, `IRC_PASSWORD` (optional), `IRC_SASL_USER`,
  `IRC_SASL_PASSWORD` (optional)
Routing prefix: `irc:<lowercased-target>` — `irc:#mozi-test` for a
channel, `irc:alice` for a DM.

## 1. Pick a network

Common public networks:

- [Libera.Chat](https://libera.chat) — `irc.libera.chat:6697`
- [OFTC](https://oftc.net) — `irc.oftc.net:6697`
- [EFnet](https://efnet.org) — `irc.efnet.org:6697`

Self-hosted networks (InspIRCd, UnrealIRCd, Ergo, ...) work the same
way — supply the host, port, and credentials.

## 2. Register your nick

Most networks require a registered nick before you can join popular
channels. On Libera:

```
/msg NickServ REGISTER <password> <your-email>
```

Wait for the confirmation email, then:

```
/msg NickServ VERIFY REGISTER <nick> <code>
```

Keep the password — MOZI will use it for SASL auth so you don't have to
re-identify after every reconnect.

## 3. Configure MOZI

```bash
pnpm mozi onboard
# → Messaging channels → check IRC
# → host: irc.libera.chat
# → TLS: Yes
# → port: 6697
# → nick: mozi-bot        (must be registered if the network requires it)
# → SASL: Yes             (if you registered a nick)
# → SASL username / password
# → channels: #mozi-test
```

The wizard opens a TLS connection, waits for `RPL_WELCOME` (NUMERIC
001), then disconnects. If the handshake fails you'll see the server's
error message.

## 4. Start chatting

```bash
pnpm build && pnpm mozi restart --daemon
```

MOZI joins the configured channels on connect. Talk to it there, or
start a private conversation (`/query mozi-bot`).

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `ERR_NICKNAMEINUSE` | Another client is using that nick. Pick a different nick or disconnect the other client. |
| `SASL authentication failed` | Wrong SASL user/password, or the nick isn't registered yet. |
| `Cannot send to channel` (ERR 404) | Nick is unregistered, or the channel requires `+m`/`+r` mode. Register and identify. |
| Disconnect loop | Hosted networks throttle reconnects. `irc-framework` backs off automatically; check logs. |
| Text appears double-spaced in terminal | MOZI chunks on `\n`; each newline becomes a separate IRC line (protocol limitation). |

## 6. Privacy note

IRC channel messages are plain-text on the wire between you and the
server; TLS encrypts only the transport from client to server. Do not
put secrets in channel messages; treat them as public.
