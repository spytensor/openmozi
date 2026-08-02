# Design — MCP integration

## Where this stands today

The bridge connects to servers, lists their tools, prefixes them `mcp_<server>_<tool>`
and wraps each one with audit logging. Then it stops. `getTools()` has three
callers and every one of them only counts or logs the result, so **no MCP tool
has ever been offered to the model**. There is no API route and no UI. The
capability manifest used to report this as an enabled integration; it now says
plainly that the tools are collected but not exposed.

Two further gaps in the existing code, both load-bearing for this design:

- `permission_level` is declared per server and read only to compute an index
  that nothing consumes. Nothing enforces it.
- The subprocess inherits the full parent environment (`{...process.env, ...}`),
  so every MCP server sees MOZI's provider keys, JWT secret and master key.

## What "wired" has to mean here

MCP tools must arrive through the **same pipeline as every other tool**, not a
parallel one. That pipeline is: `getAllRegisteredTools()` builds the offered
set → the model emits a `tool_call` → `executeToolInner` runs the permission
gate, the pre-call hooks, the dispatch chain, then the result hooks. Anything
that bypasses it loses permission enforcement, approval flows, hook plugins,
audit rows and the execution timeline the UI renders.

Concretely, MCP has to plug into three existing seams:

| Seam | File | What MCP adds |
|---|---|---|
| Tool set assembly | `dynamic-registry.ts:585` `getAllRegisteredTools` | MCP tool definitions alongside built-in and dynamic tools |
| Dispatch chain | `executor.ts:876` `runDispatch` | one more `?? executeMcpTool(...)` link, returning `null` for non-MCP names |
| Permission lookup | `tool-permission-map.ts:139` `getToolPermission` | resolve an MCP name to its server's declared level instead of the catch-all |

## Design

### 1. Naming and collisions

Keep `mcp_<serverId>_<toolName>`. Server ids are config keys, so they are
already unique, which makes the full name unique without a registry.

Two constraints the current prefixing ignores:

- **Model-facing name length and charset.** Provider APIs constrain tool names
  (`^[a-zA-Z0-9_-]{1,64}$` is the tightest common rule). A server id or tool
  name with a dot or a long name silently produces an invalid tool and the
  whole request fails, not just that tool. Sanitise to the charset and truncate
  deterministically with a short hash suffix when over length.
- **Reserved prefix.** A built-in tool must never be shadowed. Reject (and log)
  any MCP tool whose sanitised name collides with a built-in name.

  The reservation runs the other way too: a *dynamic* tool may not take an
  `mcp_` name. Dispatch reaches dynamic tools before MCP, so a script named
  `mcp_files_read` would be the thing that executes while `getToolPermission`
  still resolved the MCP entry — an L0 server's `filesystem/read` requirement
  standing in for the `shell/execute` a script demands. Registration rejects
  the prefix and the loader skips any row that predates the check.

### 2. Permission model

A server declares one `permission_level`. That is a **ceiling on what its tools
may require**, not a grant — the same clamping rule delegated agents use.

- `getToolPermission(name)` gains an MCP branch: an MCP tool resolves to the
  category/action implied by its server's declared level (`L0_READ_ONLY` →
  `filesystem/read`, `L1` → `filesystem/write`, `L2`/`L3` → `shell/execute`).
- The hot-path gate then applies unchanged: a session at L1 calling a tool from
  an L2 server is denied and can escalate through the existing approval flow.
- **Fail closed on an unknown server**: if a tool name parses as MCP but its
  server is gone, resolve to the most restrictive requirement and let dispatch
  return an error, rather than falling through to the catch-all.

Rejected alternative: deriving a per-tool level from the MCP tool's own
annotations (`readOnlyHint` etc.). The server controls those, so a compromised
or careless server could self-declare read-only. The operator's config is the
only trustworthy source.

### 3. Tool-set stability and the prompt cache

`BUILTIN_TOOL_PREDICATES` carries an explicit invariant: predicates depend only
on config/env/host state so the offered tool set stays stable within a session
and the provider-side prefix cache survives. MCP breaks this if tools appear
and disappear as servers connect, reconnect or die — every change rewrites the
tool array and invalidates the cache — the shape of a past cache collapse here.

**Live membership, snapshotted at turn boundaries** (operator decision,
2026-07-25). Tools appear when a server connects and disappear when it drops,
so the offered set reflects reality — but the set is resolved once per turn and
held for that turn's duration.

Mid-turn stability is not a nicety: without it the model can be offered a tool
that vanishes before it calls it, and the tool array can change between the
iterations of a single tool loop, which rewrites the request prefix mid-turn.

Cache impact is then bounded to real state changes. In steady state — every
configured server connected — the set is identical turn after turn and the
prefix cache survives. A connect or a drop invalidates it once, which is the
honest cost of reflecting reality.

### 4. Execution path

`executeMcpTool(name, args, id, context)` joins the dispatch chain and:

1. returns `null` immediately when the name lacks the MCP prefix, so non-MCP
   dispatch is unaffected;
2. looks up the frozen tool entry; unknown or disconnected → `is_error` result
   naming the server, never a throw that aborts the turn;
3. calls the underlying tool with a **timeout** (`AbortSignal.any` with
   `context.abortSignal`, so a cancelled turn cancels the MCP call — the
   cancellation-chaining rule the delegated runner already follows);
4. normalises the result to text, **truncating** to the same budget other tool
   results use, because an MCP server can return arbitrarily large payloads
   straight into the model's context;
5. keeps the existing audit rows (`mcp_tool_call` / `mcp_tool_result`).

Every MCP request is wrapped in an external deadline (`withDeadline`), because
the SDK cannot be made to time out. `RequestOptions.timeout` is declared in
`@ai-sdk/mcp`'s types but never implemented, and while `signal` is checked
before sending and again when a response arrives, **nothing listens for
`abort`** — so aborting mid-wait does not settle the promise. A server that
accepts a request and goes quiet would otherwise hang its caller forever: the
tool call past its own `finally`, `start()` (and with it MOZI's boot, which
awaits it), and the `/test` route.

### 5. Subprocess isolation

Stop passing the whole parent environment. Pass a minimal base (`PATH`, `HOME`,
`LANG`, `TZ`) plus the server's declared `env`. Anything a server needs must be
declared, which is also what makes the config auditable.

Proxy and TLS-trust variables (`HTTP(S)_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`SSL_CERT_DIR`) are inherited on
purpose: none is a secret, and without them a server behind a corporate proxy
or a TLS-inspecting CA fails with no useful diagnostic.

Note that `Experimental_StdioMCPTransport.getEnvironment` overwrites
`HOME`/`LOGNAME`/`PATH`/`SHELL`/`TERM`/`USER` from the parent *after* applying
this map, so declaring those in a server's `env` has no effect.

This is a behaviour change for setups that relied on inheriting a key. It is
still correct: an MCP server is third-party code, and the old code spread the
whole parent environment whenever a server declared any `env` at all — which is
exactly what a credential-consuming server does.

### 6. Configuration surface

Config stays the source of truth (`config.mcp.servers`). Add REST + UI so it is
manageable without hand-editing JSON.

**Writes are admin-only.** A server definition is an arbitrary command MOZI
spawns, `/test` spawns it immediately, the routes write the same file
`/api/config` already guards at admin, and they are not tenant-scoped — one
writer changes what every tenant's Brain can call. Left on the generic non-GET
default they would have sat at `operator`. Reading stays `viewer`.

- `GET /api/mcp/servers` — id, command, enabled, connected, tool count, declared
  level, restart count, last error
- `POST /api/mcp/servers` / `PATCH /api/mcp/servers/:id` / `DELETE`
- `POST /api/mcp/servers/:id/test` — connect, list tools, disconnect; report
  what would be exposed **without** mutating the live set

**Revocation is immediate, additions are not.** Deleting a server, disabling
it, or changing what it spawns stops the running process and drops its tools
at once. Anything else would mean the operator believes they cut off a
third-party server while it is still live with its credentials. This is safe
mid-session precisely because it only ever *withdraws* capability — live
membership already covers tools disappearing, and nothing new appears. Adding
or editing a definition still takes effect at the next restart.

UI: a section under Settings listing servers with connection state and their
tool inventory, an add/edit form (command, args, env, permission level), and an
explicit note that changes apply after restart — matching the snapshot rule
rather than pretending to hot-swap.

### 7. Truthfulness

The capability manifest reports `enabled` only when at least one MCP tool is
actually in the offered set, with the count. Not "servers connected" — that is
the claim that was wrong before.

## Deliberately out of scope

- **HTTP/SSE transports.** Only stdio today. Remote servers need SSRF policy and
  a credential story; a separate change.
- **Mid-turn membership changes.** See §3: live at turn boundaries, fixed within a turn.
- **Per-tool permission overrides.** Server-level is the unit until there is a
  concrete need; per-tool config invites drift between the model's view and the
  operator's intent.
- **MCP resources and prompts.** Only tools are forwarded. Resources need a
  context-budget story of their own.
- **MOZI as an MCP server.** Different direction, different design.

## Verification

`src/mcp/naming.test.ts`, `src/mcp/bridge.test.ts` and
`src/mcp/tool-adapter.test.ts` cover naming, env construction, the turn
snapshot, permission resolution and the dispatch branch against stubs.

`src/mcp/wiring.e2e.test.ts` is the one that matters. It spawns a real stdio
MCP server subprocess (`echo-server.fixture.mjs`, plain JSON-RPC, no network)
and drives the whole production path. Recorded output:

```
SERVER STATUS: [{"id":"proof","connected":true,"toolCount":2,
                 "permissionLevel":"L1_READ_WRITE","restarts":0,"lastError":null}]
MCP TOOLS OFFERED TO MODEL: ["mcp_proof_echo_shout","mcp_proof_whoami"]
PERMISSION RESOLVED: {"category":"filesystem","action":"write"}
TOOL RESULT: {"content":[{"type":"text","text":"WIRED AT LAST"}],"isError":false}
L0 GATE RESULT: Permission denied: agent 'e2e-proof' has L0_READ_ONLY but
                action 'filesystem.write' requires L1_READ_WRITE
SUBPROCESS ENV: {"leaked_vars":[],"declared_var":"declared-value","env_count":9}
```

Each line answers a specific doubt:

- The server's own tool is named `echo.shout`. It reaches the model as
  `mcp_proof_echo_shout`, so the dot never gets near a provider API.
- The tool is in `getAllRegisteredTools()` — the assertion that would have
  failed against the previous implementation, where the bridge collected tools
  and nothing forwarded them.
- Execution runs through `executeToolCalls`, the same entry every built-in
  takes, not a side channel.
- The denial is a real permission denial naming the required level, not an
  incidental error. An earlier run of this test passed for the wrong reason (a
  missing test database made *every* call fail); the database is now set up so
  the gate is what actually rejects.
- The leak check ran with `ANTHROPIC_API_KEY` and `MOZI_MASTER_KEY` set in the
  parent process. The child saw neither, and nine variables in total.

`src/mcp/resilience.test.ts` drives the failure paths against
`hang-server.fixture.mjs`, a server that completes the handshake, answers
`tools/list` once, fails `tools/call`, then goes silent:

- the post-failure liveness probe returns in ~10s (`PROBE_TIMEOUT_MS`) instead
  of hanging. With the deadline removed the same test times out at 40s, which
  is what the unbounded version did in production terms: forever.
- a server whose command always fails keeps retrying within its
  `max_restarts` budget rather than stopping after the first attempt.
- shutdown leaves nothing connected and no tools exposed.

`src/api/mcp-routes.test.ts` covers the REST surface, including that credential
values never appear in a response and that a patch omitting `env` preserves
them.

Still not driven at runtime: the `CONNECT_TIMEOUT_MS` path (a command that
spawns but never answers `initialize`), and reconnect *succeeding* after an
earlier failure.
