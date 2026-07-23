# WebSocket (Web UI)

Status: **stable**
Transport: WebSocket (`/ws`) on the built-in Fastify server
Env var: *(none — auth uses the shared JWT secret)*

The web UI is always enabled when MOZI boots. It is the channel the
bundled React UI (`ui/`) speaks to. No configuration is required.

## 1. Build the UI (one-time)

```bash
pnpm ui:build
```

## 2. Start MOZI

```bash
pnpm build && pnpm mozi restart --daemon
```

The server listens on `http://localhost:PORT` (default `3001`, see
`config/server.port` in `~/.mozi/mozi.config.json`).

## 3. Open the UI

Point your browser at the printed URL. The first load walks you through
authenticating against MOZI.

## 4. Auth modes

`server.auth_mode` in the config controls the WS handshake:

- `jwt` (default) — browser gets a short-lived JWT from the pairing
  flow.
- `open` — no auth, for local development only. Never enable in
  production.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| Blank page / `ws://...` refused | Rebuild the UI (`pnpm ui:build`), check the printed `url` in MOZI logs. |
| `Unauthorized` on connect | Ensure the pairing JWT has not expired; re-pair from the UI. |
| High CPU during streaming | Disable edit-streaming in `config/channels.websocket` — fall back to final-only send. |
