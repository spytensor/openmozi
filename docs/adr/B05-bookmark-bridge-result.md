# B0.5 Bookmark Bridge Result

Date: 2026-07-04.

## Scope

This ADR records the result shape for the disposable B0.5 harness in
`spikes/native-bookmark-b05/`. The target risk is the
security-scoped-bookmark to sandboxed Node child handoff from
`docs/adr/B0-sandbox-spike.md`.

## Implemented Consumer Design

Implemented design: **(a) Swift parent holds scoped access for the child
lifetime; Node performs plain filesystem I/O on the resolved path**.

Rationale: this is the smallest harness that can prove or disprove the critical
question. Pure Node cannot consume app-scoped security-scoped bookmarks, and a
native N-API bridge would add implementation surface before proving whether it
is required. This spike therefore intentionally tests the simpler parent-held
access model first.

Important caveat: B0 already found that static App Sandbox inheritance does not
include later PowerBox rights by assumption. If the operator-signed run denies
the inside write, this design is rejected and B1 must use a native bookmark
consumer in the worker process, a Swift helper that owns the scoped access, or
an XPC/file-broker design.

## Harness

Delivered files:

- `spikes/native-bookmark-b05/Package.swift`
- `spikes/native-bookmark-b05/Sources/NativeBookmarkB05/main.swift`
- `spikes/native-bookmark-b05/node-grant-check.mjs`
- `spikes/native-bookmark-b05/entitlements/app.entitlements`
- `spikes/native-bookmark-b05/entitlements/child-node.entitlements`
- `spikes/native-bookmark-b05/build-app.sh`
- `spikes/native-bookmark-b05/run-smoke.sh`
- `spikes/native-bookmark-b05/operator-signed-test.md`

The app entitlement file includes:

- `com.apple.security.app-sandbox`
- `com.apple.security.files.user-selected.read-write`
- `com.apple.security.files.bookmarks.app-scope`
- `com.apple.security.network.client`
- `com.apple.security.network.server`

The child Node entitlement file includes only:

- `com.apple.security.app-sandbox`
- `com.apple.security.inherit`

## Local Smoke vs Operator Test

Local ad-hoc signing can verify:

- SwiftPM builds the app executable.
- The `.app` bundle has the intended minimal shape.
- The bundled Node helper is Node 22.
- The app and helper can be ad-hoc signed with the requested entitlement files.
- `codesign --verify --deep --strict` accepts the bundle.

Local ad-hoc signing does **not** prove:

- Developer ID signing and Gatekeeper acceptance.
- Notarization.
- The full picker to bookmark to quit/relaunch flow, because `NSOpenPanel`
  requires a real user click.
- The decisive folder grant result unless the operator manually runs the app and
  captures the result JSON.
- Production-grade Node packaging, if the smoke uses Homebrew `node@22`.

The account-backed acceptance test is
`spikes/native-bookmark-b05/operator-signed-test.md`.

## Result Criteria

The child process must print JSON with:

```json
{
  "verdict": "pass",
  "nodeMajorOk": true,
  "inside": { "ok": true },
  "outside": { "ok": false, "denied": true }
}
```

Interpretation:

- `inside.ok: true` proves the child can write to the user-selected folder after
  relaunch using the persisted bookmark.
- `outside.ok: false` and `outside.denied: true` prove the child is still
  sandbox-confined outside the selected folder.
- Any successful outside write is a sandbox/signing failure.
- Any denied inside write is a bookmark-consumer failure for design (a).

## RESULT (2026-07-04): PASS — design (a) works

Operator ran the acceptance test with ad-hoc signing (free, no Apple
account) using an OFFICIAL self-contained Node 22 (v22.23.1). Verdict:

```
verdict: pass
inside.ok: true       — sandboxed Node child wrote into the user-picked folder
outside.denied: true  — write to ~/Documents blocked with EPERM
```

Both `source=pick` (write right after picking) and `source=launch` (write
after quit+relaunch using the persisted app-scoped bookmark) succeeded —
bookmark persistence across restarts confirmed. **Design (a) — Swift
parent holds scoped access, child does plain I/O — is sufficient. No
native N-API bridge / XPC broker needed.** Native App Sandbox path is
GO for B1.

Critical gotcha proven along the way: the node helper MUST be an OFFICIAL
self-contained Node. Homebrew node links /opt/homebrew dylibs (libnode →
libuv/icu/openssl) that the sandbox blocks ("file system sandbox blocked
open()"). build-app.sh now rejects non-self-contained node with the fix.

## Prior recommendation (superseded by the PASS above)

Was: **NO-GO for B1 production Swift until the operator-signed
B0.5 acceptance test passes**.

If the operator-signed run passes exactly, B1 may start with design (a), while
keeping this harness as the regression proof for bookmark handoff. If it fails
on the inside write, B1 must not start on parent-held access and should first
implement design (b) or a Swift/XPC broker. If it fails by allowing the outside
write, fix signing, entitlements, and Node packaging before drawing any
conclusion about bookmark handoff.
