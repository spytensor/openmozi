# Native Bookmark B0.5 Spike

Disposable proof harness for the B0.5 security-scoped-bookmark handoff risk.
This does not touch `src/`, `ui/`, or `desktop/`.

## What This Tests

Implemented consumer design: **option (a)**.

The Swift app creates and persists an app-scoped security-scoped bookmark, then
resolves it on launch and calls `startAccessingSecurityScopedResource()`. While
that access is held open, it spawns a signed Node 22 child with only
`app-sandbox` + `inherit` entitlements. The Node child receives the resolved
folder path and performs plain `fs` writes.

This is intentionally the smallest falsifiable test for whether parent-held
security scope is enough for the inherited sandbox child. If the operator-signed
test shows the inside write is denied, B1 must not rely on this design and must
move to a native bookmark consumer in the worker process, a Swift helper, or XPC.

## Files

- `Package.swift` and `Sources/NativeBookmarkB05/main.swift`: minimal AppKit app.
- `node-grant-check.mjs`: child process filesystem probe.
- `entitlements/app.entitlements`: main app App Sandbox grants.
- `entitlements/child-node.entitlements`: child Node inheritance only.
- `build-app.sh`: builds `stage/NativeBookmarkB05.app`.
- `run-smoke.sh`: builds, ad-hoc signs, verifies, and launches for manual smoke.
- `operator-signed-test.md`: Developer ID acceptance test script.

## Build

The build requires Xcode command line tools and Node 22. By default it uses
Homebrew `node@22` when present. For a real package, point it at a pinned Node 22
runtime that is intended to live inside the app bundle:

```sh
MOZI_B05_NODE_SOURCE="/path/to/node-v22/bin/node" \
  ./spikes/native-bookmark-b05/build-app.sh
```

For local ad-hoc smoke:

```sh
./spikes/native-bookmark-b05/run-smoke.sh
```

To build, sign, and verify without launching:

```sh
MOZI_B05_NO_LAUNCH=1 ./spikes/native-bookmark-b05/run-smoke.sh
```

## Expected JSON

The child prints JSON to stdout. A passing signed sandbox run has:

```json
{
  "verdict": "pass",
  "nodeMajorOk": true,
  "inside": { "ok": true },
  "outside": { "ok": false, "denied": true }
}
```

If `outside.ok` is true, the child was not confined enough. If `inside.ok` is
false after the picker and relaunch, option (a) failed and B1 needs a native
bookmark consumer design.

## Local Limits

This machine has no Developer ID identity, and `NSOpenPanel` requires a real
user click. Ad-hoc signing can prove the bundle structure and signatures are
syntactically valid, but the account-backed acceptance script is the B1 gate.
