# MOZI — Internal Web UI Deployment

A minimal "single-user, behind nginx" deployment recipe so a non-technical
operator (e.g. an executive) can use MOZI from a browser without learning
the CLI or installing Telegram. This is **not** the multi-tenant production
setup; see `docs/CONSTITUTION.md` and `docs/ARCHITECTURE-GAPS.md` for that.

## Threat model

This recipe relies on two layers:

1. **nginx** in front, terminating TLS and enforcing HTTP Basic Auth.
2. **MOZI** behind, configured with `MOZI_SERVER_AUTH_MODE=none` because
   the Web UI's first-run pairing flow is Telegram-only and the OAuth/SAML
   paths require external identity provider configuration that is out of
   scope for an internal-only deployment.

If nginx is bypassed (port 9210 exposed, host networking, etc.) every
`/api` route and the WebSocket are open. Bind MOZI strictly to localhost
on the host (the supplied `docker-compose.yml` already does this with
`127.0.0.1:9210:9210`).

## What you need

- Linux host with Docker + Docker Compose
- A domain name pointed at the host (for TLS)
- TLS certificate (Let's Encrypt is fine)
- LLM API key (Anthropic / OpenAI / etc.)

## One-time host setup

```bash
# 1. Clone and enter the repo
git clone <this-repo> mozi && cd mozi

# 2. Create the runtime data directory that the container will mount
mkdir -p ./data

# 3. Place LLM credentials in .env (next to docker-compose.yml)
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
# Or OPENAI_API_KEY=...
EOF

# 4. Pre-seed configuration by running the onboarding wizard once on
#    the host. This writes ~/.mozi/mozi.json with provider/model picks.
#    The container will read the same config from ./data via MOZI_HOME.
MOZI_HOME=$(pwd)/data pnpm install --frozen-lockfile
MOZI_HOME=$(pwd)/data pnpm build
MOZI_HOME=$(pwd)/data pnpm mozi onboard

# 5. Build and start the container
docker compose up -d --build
```

After step 4, `./data/mozi.json` exists with the operator's provider
choices, model router, and `bootstrap_state.onboarding.completed=true`.
The container will skip the wizard and land directly on the chat UI.

## nginx + TLS + Basic Auth

```bash
# Create the password file (one user is enough)
sudo htpasswd -c /etc/nginx/mozi.htpasswd ceo

# Drop the reference config into nginx and reload
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/mozi
sudo ln -s /etc/nginx/sites-available/mozi /etc/nginx/sites-enabled/mozi
# Edit server_name + ssl_certificate paths to match your domain, then:
sudo nginx -t && sudo systemctl reload nginx
```

The CEO opens `https://mozi.example.com`, enters the Basic Auth
credentials once (browser remembers them), and lands on the chat UI.

## Upgrading

```bash
git pull
docker compose up -d --build
```

SQLite migrations run automatically on container start. The `./data`
volume preserves config, secrets, and chat history across rebuilds.

## How "users" works in this recipe

A self-hosted MOZI Web UI is **your** server, **your** browser. There is
no concept of strangers walking in, so MOZI's internal pairing system
(which exists for Telegram bots, where any TG account can DM the bot)
does not apply here. Multi-user means "more entries in nginx's
htpasswd file":

```bash
# Add a second person who can reach the same MOZI instance
sudo htpasswd /etc/nginx/mozi.htpasswd alice
```

Every authenticated browser shares the single `local-user` account on
the MOZI side. If you actually need per-user identity, audit, or RBAC
inside MOZI, this recipe is not the right starting point — flip
`MOZI_SERVER_AUTH_MODE` back to `token` and configure OAuth or SAML
(routes exist; provider setup is outside this guide).

## What this deployment does NOT give you

- Per-user identity, audit, or RBAC inside MOZI (it's all `local-user`).
- Mobile push notifications. The browser does not push when MOZI
  finishes a long task. If you want "tap on phone, get a result later"
  use the Telegram channel (`src/channels/telegram.ts`) instead of, or
  alongside, this Web UI.
