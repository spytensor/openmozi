#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="NativeBookmarkB05"
APP="$ROOT/stage/$APP_NAME.app"
APP_ENTITLEMENTS="$ROOT/entitlements/app.entitlements"
CHILD_ENTITLEMENTS="$ROOT/entitlements/child-node.entitlements"

"$ROOT/build-app.sh"

if [[ ! -x "$APP/Contents/Helpers/node" ]]; then
  echo "error: bundled Node helper is missing at $APP/Contents/Helpers/node" >&2
  exit 1
fi

while IFS= read -r -d '' nested_code; do
  echo "ad_hoc_sign_nested=$nested_code"
  codesign --force --sign - "$nested_code"
done < <(find "$APP" -type f \( -name "*.dylib" -o -name "*.node" \) -print0)

echo "ad_hoc_sign_child_node=$APP/Contents/Helpers/node"
codesign --force --sign - \
  --entitlements "$CHILD_ENTITLEMENTS" \
  "$APP/Contents/Helpers/node"

echo "ad_hoc_sign_app=$APP"
codesign --force --sign - \
  --entitlements "$APP_ENTITLEMENTS" \
  "$APP"

codesign --verify --deep --strict --verbose=4 "$APP"

cat <<STEPS

Built and ad-hoc signed:
  $APP

Manual smoke steps:
  1. Create or choose a disposable folder outside this repo, for example:
       mkdir -p "\$HOME/Desktop/mozi-b05-granted"
  2. Launch the app, click "Pick folder", and select that folder.
  3. Confirm the app log shows nodeStdout with "inside.ok": true.
  4. Quit the app.
  5. Relaunch the same .app. It should resolve the persisted bookmark without another picker.
  6. Confirm the app log or result JSON shows:
       "verdict": "pass"
       "inside": { "ok": true, ... }
       "outside": { "ok": false, "denied": true, ... }
  7. Click "Revoke bookmark", quit, relaunch, and confirm it logs noStoredBookmark.

Result files, when sandboxed, should be under:
  \$HOME/Library/Containers/dev.mozi.spikes.native-bookmark-b05/Data/Library/Application Support/NativeBookmarkB05/

This script cannot automate NSOpenPanel, the quit/relaunch step, or the operator's real Developer ID signing.
STEPS

if [[ "${MOZI_B05_NO_LAUNCH:-0}" == "1" ]]; then
  echo "MOZI_B05_NO_LAUNCH=1 set; not launching app."
  exit 0
fi

open "$APP"
