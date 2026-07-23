# Operator-Signed B0.5 Acceptance Test

This is the account-backed test that gates B1 production Swift. Run it on a
machine with an Apple Developer Program account, a valid Developer ID
Application certificate, and Node 22 packaging input.

## 0. Configure

Use an official or otherwise self-contained pinned Node 22 runtime for the real
test. Homebrew `node@22` is acceptable only for local smoke because it links to
Homebrew dylibs outside the app bundle.

```sh
cd /Users/example/projects/OpenMozi

security find-identity -v -p codesigning

export TEAM_ID="<TEAMID>"
export CERT="Developer ID Application: <Name> ($TEAM_ID)"
export MOZI_B05_NODE_SOURCE="/absolute/path/to/node-v22.x.y-darwin-arm64/bin/node"
export APP="$PWD/spikes/native-bookmark-b05/stage/NativeBookmarkB05.app"
export SPIKE="$PWD/spikes/native-bookmark-b05"
export BUNDLE_ID="dev.mozi.spikes.native-bookmark-b05"
```

## 1. Build

```sh
"$SPIKE/build-app.sh"
```

If the chosen Node runtime has bundled `.dylib` dependencies, place them under
the app bundle before signing and make sure `otool -L` does not point at
Homebrew-only paths for the real acceptance run.

```sh
otool -L "$APP/Contents/Helpers/node"
"$APP/Contents/Helpers/node" -p 'process.version'
```

## 2. Sign in Explicit Order

Do not rely on `--deep` for signing. Sign nested code first, the Node helper
with child entitlements second, and the app bundle last.

```sh
find "$APP" -type f \( -name "*.node" -o -name "*.dylib" \) -print0 |
  xargs -0 -I{} codesign --force --timestamp --options runtime --sign "$CERT" "{}"

codesign --force --timestamp --options runtime \
  --entitlements "$SPIKE/entitlements/child-node.entitlements" \
  --sign "$CERT" \
  "$APP/Contents/Helpers/node"

codesign --force --timestamp --options runtime \
  --entitlements "$SPIKE/entitlements/app.entitlements" \
  --sign "$CERT" \
  "$APP"

codesign --verify --deep --strict --verbose=4 "$APP"
codesign -d --entitlements :- "$APP"
codesign -d --entitlements :- "$APP/Contents/Helpers/node"
spctl -a -vvv -t exec "$APP"
```

Expected entitlement shape:

- App: `app-sandbox`, `files.user-selected.read-write`,
  `files.bookmarks.app-scope`, `network.client`, `network.server`.
- Child Node: `app-sandbox` and `inherit` only.

## 3. Reset State

```sh
export CONTAINER="$HOME/Library/Containers/$BUNDLE_ID"
export SUPPORT="$CONTAINER/Data/Library/Application Support/NativeBookmarkB05"
export RESULT="$SUPPORT/last-child-result.json"
export LOG="$SUPPORT/b05-app.log"
export GRANT_DIR="$HOME/Desktop/mozi-b05-granted"
export OUTSIDE_FILE="$HOME/Documents/mozi-should-fail.txt"
export OLD_GRANT_DIR="$HOME/Desktop/mozi-b05-granted.previous-$(date +%Y%m%d%H%M%S)"

rm -rf "$CONTAINER"
rm -f "$OUTSIDE_FILE"
if [ -e "$GRANT_DIR" ]; then mv "$GRANT_DIR" "$OLD_GRANT_DIR"; fi
mkdir -p "$GRANT_DIR"
```

## 4. Pick, Quit, Relaunch

```sh
open "$APP"
```

Manual steps:

1. Click `Pick folder`.
2. Select `$HOME/Desktop/mozi-b05-granted`.
3. Wait for the app log to show `nodeChildFinished`.
4. Quit the app with `Cmd-Q`.
5. Relaunch:

```sh
open "$APP"
```

Wait for the launch-time grant check to finish.

## 5. Verify Grant and Denial

```sh
test -f "$RESULT"
cat "$RESULT"

python3 - "$RESULT" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1]))
child = json.loads(record["stdout"])

assert record["terminationStatus"] == 0, record
assert child["verdict"] == "pass", child
assert child["nodeMajorOk"] is True, child
assert child["inside"]["ok"] is True, child
assert child["outside"]["ok"] is False, child
assert child["outside"]["denied"] is True, child
print("B0.5 PASS: grant works and outside write is denied")
PY

ls -la "$GRANT_DIR"
test ! -e "$OUTSIDE_FILE"
grep -E 'bookmarkResolved|nodeChildFinished|scopedAccessStopped' "$LOG"
```

If `inside.ok` is false, option (a) failed: parent-held scoped access did not
give the inherited Node child usable folder access. Stop B1 and implement a
native bookmark consumer or broker.

If `outside.ok` is true, the child is not adequately sandboxed. Stop B1 and fix
signing/entitlements before testing the bookmark design again.

## 6. Revoke

In the app, click `Revoke bookmark`, then quit and relaunch:

```sh
open "$APP"
```

Expected verification:

```sh
grep -E 'bookmarkRevoked|noStoredBookmark' "$LOG"
python3 - "$RESULT" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1]))
assert record["event"] in {"bookmarkRevoked", "noStoredBookmark"}, record
print("B0.5 revoke state is explicit:", record["event"])
PY
```

## 7. Optional Notarization Check

Notarization is not required to answer the bookmark handoff question, but this
is the packaging path the production app will need.

```sh
ditto -c -k --keepParent "$APP" "$SPIKE/stage/NativeBookmarkB05.zip"

xcrun notarytool store-credentials mozi-notary \
  --apple-id "<APPLE_ID>" \
  --team-id "$TEAM_ID" \
  --password "<APP_SPECIFIC_PASSWORD>"

xcrun notarytool submit "$SPIKE/stage/NativeBookmarkB05.zip" \
  --keychain-profile mozi-notary \
  --wait

xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
```
