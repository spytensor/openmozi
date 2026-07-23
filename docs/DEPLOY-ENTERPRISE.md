# MOZI Enterprise Deployment

This guide is for the MOZI v2 enterprise Docker profile. It runs MOZI with
in-app local authentication, invite-based registration, RBAC, audit logging,
model entitlements, and usage quotas.

The personal `docker-compose.yml` remains the local single-operator profile
with `MOZI_SERVER_AUTH_MODE=none`. Do not use that profile for enterprise
browser access unless an external gate protects every request.

## Prerequisites

- Docker Engine and Docker Compose v2.
- A persistent host directory for `./data`.
- LLM provider credentials in a root `.env` file, for example
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- A TLS reverse proxy such as nginx, Caddy, or Traefik before any network
  exposure beyond `127.0.0.1`.

## One-command Up

Create the data directory and start the enterprise profile:

```bash
mkdir -p data && docker compose -f docker-compose.enterprise.yml up -d --build
```

MOZI listens on `127.0.0.1:9210` on the host by default. Open:

```text
http://127.0.0.1:9210
```

To override registration policy at deploy time:

```bash
MOZI_SERVER_REGISTRATION=open docker compose -f docker-compose.enterprise.yml up -d --build
```

Supported values are `open`, `invite`, and `closed`. The enterprise default is
`invite`.

## First-run Bootstrap

On a fresh `/data` volume, the first person who registers becomes the tenant
admin. After that first admin exists, the configured registration policy is
enforced:

- `invite`: new self-registrations must include an invite code.
- `open`: new self-registrations become viewers by default.
- `closed`: only admin-created users can join.

The first admin should finish the onboarding flow, add or verify provider keys,
and then use the Admin section to manage users, audit, usage, quotas, and model
entitlements.

A fresh `/data` volume has no brain model yet: MOZI boots in setup mode (chat
returns an honest "no brain model configured" error) until the first admin
completes onboarding or sets a provider key and brain model in Settings. The
brain activates immediately — no container restart is required.

## Inviting Users

Admins have two supported paths:

- Admin UI: open Admin -> Users, create a user, choose a role, and give the
  generated or chosen password to that user through a secure channel.
- Invite API: create a one-time invite code from an authenticated admin session,
  then give the code to the user so they can register themselves.

Example invite API flow:

```bash
curl -c mozi.cookies \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"admin-password"}' \
  http://127.0.0.1:9210/api/auth/login

curl -b mozi.cookies \
  -H 'Content-Type: application/json' \
  -d '{"role":"operator","expires_minutes":1440}' \
  http://127.0.0.1:9210/api/auth/invites
```

Roles are `admin`, `operator`, and `viewer`.

## Model Entitlements Quickstart

Model access is the intersection of the tenant ceiling and the user grant:

- Tenant ceiling: Admin -> Usage & Quotas -> Allowed models.
- User grant: Admin -> Users -> Edit model entitlements.
- Empty tenant ceiling means all known models are allowed at the tenant level.
- Empty user grant means the user inherits the tenant ceiling.

Use exact model ids from the provider catalog, for example `gpt-4.1-mini` when
that model is available in your configured catalog.

API example:

```bash
curl -b mozi.cookies \
  -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"allowed_models":["gpt-4.1-mini"],"daily_token_limit":100000,"monthly_token_limit":2000000}' \
  http://127.0.0.1:9210/api/quotas/default

curl -b mozi.cookies \
  -X PATCH \
  -H 'Content-Type: application/json' \
  -d '{"allowed_models":["gpt-4.1-mini"]}' \
  http://127.0.0.1:9210/api/users/<user-id>
```

When a user requests a disallowed model, MOZI returns a typed denial instead of
silently substituting another model.

## Audit Export

Admins can export audit rows from Admin -> Audit -> Export CSV.

API example:

```bash
curl -b mozi.cookies \
  -o audit.csv \
  'http://127.0.0.1:9210/api/audit/export?format=csv&limit=10000'
```

Optional filters include `from`, `to`, `action`, `user_id`, and `outcome`.

## Backup

All persistent runtime state is under the `/data` container volume, mounted from
`./data` by the enterprise compose file. This includes config, SQLite data,
JWT secret, encrypted secrets, logs, workspace files, and generated artifacts.

For a simple consistent backup, stop MOZI and archive `./data`:

```bash
docker compose -f docker-compose.enterprise.yml stop mozi
tar -czf mozi-data-$(date +%F).tar.gz data
docker compose -f docker-compose.enterprise.yml up -d
```

If provider keys live in the root `.env` file, back that file up separately and
store it with the same care as production secrets.

## Upgrade Procedure

```bash
git pull
docker compose -f docker-compose.enterprise.yml up -d --build
docker compose -f docker-compose.enterprise.yml ps
```

Startup reruns database migrations, synchronizes bootstrap assets, reloads
workspace skills and agents, and keeps the existing `/data` volume. Routine
upgrades should not require rerunning onboarding.

## TLS Reverse Proxy Example

Keep MOZI bound to `127.0.0.1:9210` when nginx runs on the same host:

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 443 ssl http2;
  server_name mozi.example.com;

  ssl_certificate /etc/letsencrypt/live/mozi.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mozi.example.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000" always;

  location / {
    proxy_pass http://127.0.0.1:9210;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
  }
}
```

If a reverse proxy runs on another host, expose MOZI only on a trusted private
network and terminate public TLS at the proxy. Do not publish port 9210 directly
to the internet.

## Security Model Summary

The enterprise Docker profile uses Docker as the outer sandbox boundary:

- `read_only: true` keeps the image filesystem immutable at runtime.
- `security_opt: no-new-privileges:true` prevents privilege escalation through
  setuid/setgid binaries.
- `/data` is the only persisted writable mount.
- `/tmp` is tmpfs scratch for Node, screenshots, shell scratch, and libraries
  using `os.tmpdir()`.
- `/var/tmp` is a targeted tmpfs for tooling that expects conventional temp
  storage while the root filesystem is read-only.
- `mem_limit` and `cpus` provide conservative resource caps.
- The host bind defaults to `127.0.0.1`.

Inside MOZI, the application still enforces:

- Auth mode, registration policy, httpOnly browser sessions, and refresh-token
  rotation.
- RBAC roles for admin, operator, and viewer routes.
- Filesystem allowlists for in-app file access.
- Shell execution timeouts and configured sandbox behavior.
- Model entitlement checks before model selection.
- Token usage collection, tenant quotas, and audit logging/export.

## Auth Modes

| Mode | Intended use | Security notes |
|---|---|---|
| `none` | Personal compose and local desktop-style use | MOZI does not authenticate API routes. Keep bound to localhost or put an external gate in front. |
| `token` | API-token deployments and legacy protected routes | Requires bearer/API token handling by clients. Not the v2 browser enterprise default. |
| `local` | Enterprise Docker profile | MOZI owns email/password auth, registration, RBAC, audit, entitlements, and quotas. |
| `oauth` | External OIDC/OAuth providers | Requires provider configuration and callback URLs. |
| `saml` | SAML integration experiments | Present but not the v2 enterprise target; prefer `local` or a configured OIDC provider for production. |

## Validation

Validate compose syntax without starting the service:

```bash
docker compose -f docker-compose.enterprise.yml config >/dev/null && echo COMPOSE_OK
```
