# Design — Enterprise Identity, Entitlements & Admin

- Status: Design → implementation (Codex, supervised)
- Owner: architect (Claude) / implementation (Codex CLI)
- Goal: an enterprise can deploy MOZI with Docker, users register/log in with
  email+password, admins control who can use which models, and every
  security-relevant action is auditable — client side, user side, admin side
  all complete. Ships as the v2.0.0 major.

## What already exists (verified 2026-07-04, not assumed)

| Piece | State |
|---|---|
| JWT HS256 + jti revocation, refresh-token rotation (7d), httpOnly cookies | wired |
| OAuth2/OIDC login (Google/GitHub), JIT user provisioning, `users` table | wired |
| SAML | PoC-grade stub (signature check only) |
| RBAC admin/operator/viewer + `role_assignments` + API-route guard | wired |
| Audit log table + `GET /api/audit` | wired |
| Audit export (CSV/JSON, redaction) `src/tenants/audit.ts` | dead code, no endpoint |
| Quotas table incl. `allowed_models`, `daily/monthly_token_limit` | **no enforcement anywhere** |
| Billing records + usage aggregation APIs | **no collection calls in LLM paths** |
| Docker multi-stage + compose (`auth_mode=none`, 127.0.0.1) | wired, personal-mode only |
| Web LoginPage (OAuth buttons only), useAuth state machine | wired |
| Admin UI (user mgmt, audit viewer, quotas) | **missing** |

## Design decisions

1. **`auth_mode: 'local'` is the enterprise mode.** Existing modes stay:
   `none` (personal, default — unchanged), `oauth`/`saml` (SSO). `local` adds
   email+password identity fully inside MOZI. No new heavy SSO work; SAML
   stays PoC and is not part of v2 scope.
2. **Passwords use Node's built-in `crypto.scrypt`** (N=16384,r=8,p=1, 16-byte
   salt, 64-byte key, timing-safe compare), stored as
   `scrypt$N$r$p$<salt_b64>$<hash_b64>` in a new nullable `users.password_hash`
   column. No new native dependency (argon2 rejected: dependency liability).
3. **Bootstrap rule: first registered user in a tenant becomes admin** and
   completes onboarding. After that, `security.registration` policy applies:
   `open` | `invite` (default) | `closed`. Invites reuse the existing
   `pairing_tokens` mechanism (role-carrying, one-time, expiring) — no new
   invite table.
4. **Model entitlement is two-level: tenant ceiling ∩ user grant.**
   - Tenant ceiling: existing `tenant_quotas.allowed_models` (JSON array,
     empty/null = all).
   - User grant: new nullable `users.allowed_models` (JSON array, null =
     inherit tenant ceiling).
   - Effective set = ceiling ∩ grant. Enforced in `model-router` selection,
     in `PATCH /api/models/roles`, and the `/api/providers` catalog marks
     disallowed models. A denied model is a typed error, never silent
     substitution (capability truthfulness).
5. **Usage collection wires the existing dead functions**: `recordLlmCall()`
   called from the Vercel AI SDK adapters (`llm-anthropic.ts`,
   `llm-openai.ts`) with `response.usage`; token quota check
   (daily/monthly) happens before the call via one indexed SUM per turn.
   Over quota → typed `QuotaExceededError` surfaced honestly to the user.
6. **Admin surface is a new UI section, admin-role gated**, reusing existing
   REST where present: Users (create/edit role/disable/reset password/model
   grants), Audit (viewer + CSV export via new `GET /api/audit/export`
   wiring the dead exporter), Usage & Quotas (existing usage endpoints +
   quota editing). Bilingual en/zh-CN, no emoji, existing design system.
7. **Enterprise deployment = Docker as the sandbox boundary.**
   `docker-compose.enterprise.yml`: `auth_mode=local`, `no-new-privileges`,
   read-only rootfs + tmpfs, resource limits, healthcheck, volume for
   `/data`; reverse-proxy TLS documented, MOZI itself enforces auth (unlike
   personal compose). In-container capabilities keep the existing fs
   whitelist + shell timeout model; container is the outer sandbox.
8. **Personal mode is untouched.** `auth_mode=none` keeps today's zero-login
   single-operator flow. All new checks no-op in that mode. MOZI stays a
   personal Agent OS first; enterprise is a deployment profile, not a fork.
9. **Version: 2.0.0** (root + ui), because `local` auth mode changes the
   deployment contract (registration surface, enforced entitlements).

## Work packages (Codex, sequential, one branch/PR each)

- **WP1 identity core**: migration (`password_hash`, `status`, `allowed_models`
  on users), password module, register/login/change-password/admin-reset
  endpoints, registration policy + invites, account disable, rate limits,
  audit events, LoginPage email+password + register form (local mode),
  admin user CRUD endpoints. Tests: unit (password, policy) + route tests.
- **WP2 entitlements + usage**: effective-model-set resolver + enforcement
  (router, roles PATCH, catalog flags), `recordLlmCall` wiring, token quota
  precheck + typed error. Tests: resolver matrix, enforcement, collection.
- **WP3 admin console UI**: Admin section (Users / Audit / Usage & Quotas),
  audit export endpoint wiring, bilingual strings. Component tests.
- **WP4 enterprise deploy + release**: compose.enterprise.yml, hardening,
  `docs/DEPLOY-ENTERPRISE.md`, version bump 2.0.0, CHANGELOG. Smoke:
  compose up → register → login → chat with allowed model → denied model
  → audit shows it.

## Acceptance (release gate for v2.0.0)

1. Fresh enterprise compose up: first register → admin; second register needs
   invite; disabled user cannot log in or refresh.
2. Admin limits a user to model set X: chat uses X; requesting Y fails with a
   truthful error; `/api/providers` marks Y disallowed for that user.
3. Every auth/role/entitlement change appears in the audit log; admin can
   export CSV.
4. Usage dashboard shows real token/cost data from live calls.
5. Personal mode (`auth_mode=none`) behaves exactly as v1.10.7.
6. `pnpm test` green; version reads 2.0.0.
