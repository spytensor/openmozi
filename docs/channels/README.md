# Channels

MOZI uses a channel-plugin architecture: every messaging service is a
`ChannelPlugin` registered in `src/channels/registry.ts`. The onboarding
wizard iterates the registry so every plugin shows up as a checkbox;
`src/index.ts` boots every plugin with a `start` method after Fastify
is ready.

## Supported channels

| Channel | Status | Mode | Public URL? | Docs |
|---|---|---|---|---|
| [Telegram](./telegram.md) | stable | Long-poll | No | ✓ |
| [WeChat iLink Bot](./wechat.md) | beta | Long-poll | No | ✓ |
| [WebSocket / Web UI](./websocket.md) | stable | Built-in | No | ✓ |
| [Discord](./discord.md) | stable | Gateway WS | No | ✓ |
| [Slack](./slack.md) | stable | Socket Mode | No | ✓ |
| [LINE](./line.md) | stable | Webhook + REST | **Yes** | ✓ |
| [Feishu / Lark](./feishu.md) | stable | WSClient | No | ✓ |
| [Google Chat](./googlechat.md) | beta | Webhook (outgoing only) | No | ✓ |
| [Microsoft Teams](./msteams.md) | beta | Webhook (outgoing only) | No | ✓ |
| [Matrix](./matrix.md) | stable | SDK (HTTPS sync) | No | ✓ |
| [IRC](./irc.md) | stable | TCP/TLS | No | ✓ |
| [Mattermost](./mattermost.md) | stable | WebSocket + REST | No | ✓ |
| [Twitch Chat](./twitch.md) | stable | IRC-over-TLS | No | ✓ |

"Public URL" means the channel pushes events to MOZI over HTTPS and you
need to expose MOZI's Fastify server to the internet (or tunnel it via
ngrok / cloudflared).

## Deferred channels

See [UNSUPPORTED.md](./UNSUPPORTED.md) for channels that require a
separate bridge daemon, Apple hardware, or complex OAuth backends
(WhatsApp, Signal, iMessage, BlueBubbles, Zalo, Tlon, and interactive
modes of Google Chat / MS Teams). These are planned for a later
release.

## Adding a new channel

1. Create `src/channels/<id>.ts` with the transport, normalizer, and
   `send*` helpers. Pick a unique chatId prefix (`<id>:`).
2. Create `src/channels/plugins/<id>.ts` that implements `ChannelPlugin`
   (id, label, docsPath, envKeys, isConfigured, isChatId, start,
   runWizard).
3. Add the plugin to `src/channels/plugins/index.ts`.
4. Add unit tests in `src/channels/<id>.test.ts` — at minimum cover
   chunking, chatId routing, and event normalization.
5. Write `docs/channels/<id>.md` documenting credential setup.
6. Add a row to the table above.
