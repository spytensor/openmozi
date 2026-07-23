#!/usr/bin/env bash
# B0.5 operator acceptance test — one-command driver.
#
# Usage:
#   1. Install a "Developer ID Application" cert (see step 0 below).
#   2. Download official Node 22 (NOT Homebrew — its dylibs won't load inside
#      the sandbox). Point MOZI_B05_NODE_SOURCE at its bin/node.
#   3. ./run-operator-test.sh build     # build + sign + launch
#      → then MANUALLY: click "Pick folder" → choose ~/Desktop/mozi-b05-granted
#        → wait → Cmd-Q → relaunch (the script tells you how)
#   4. ./run-operator-test.sh verify    # check the grant/denial result
#
# Env overrides:
#   MOZI_B05_NODE_SOURCE  path to official node 22 bin/node (required for a clean test)
#   CERT                  signing identity; auto-detected if only one exists
set -euo pipefail

SPIKE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$SPIKE/stage/NativeBookmarkB05.app"
BUNDLE_ID="dev.mozi.spikes.native-bookmark-b05"
CONTAINER="$HOME/Library/Containers/$BUNDLE_ID"
SUPPORT="$CONTAINER/Data/Library/Application Support/NativeBookmarkB05"
RESULT="$SUPPORT/last-child-result.json"
LOG="$SUPPORT/b05-app.log"
GRANT_DIR="$HOME/Desktop/mozi-b05-granted"
OUTSIDE_FILE="$HOME/Documents/mozi-should-fail.txt"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

detect_cert() {
  # ADHOC=1 → sign with the ad-hoc identity ("-"). Enough to test App Sandbox
  # + the bookmark grant LOCALLY, no Apple account needed. NOT distributable.
  if [[ "${ADHOC:-}" == "1" ]]; then echo "-"; return; fi
  if [[ -n "${CERT:-}" ]]; then echo "$CERT"; return; fi
  local ids; ids="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' || true)"
  [[ -z "$ids" ]] && die $'No "Developer ID Application" certificate found.\n  → To TEST now without a paid account: re-run with  ADHOC=1 ./run-operator-test.sh build\n  → To DISTRIBUTE later: enroll in the paid Apple Developer Program, then at\n    https://developer.apple.com/account → Certificates → + → "Developer ID\n    Application", download the .cer, double-click to install, and re-run.'
  local n; n="$(echo "$ids" | wc -l | tr -d ' ')"
  [[ "$n" != "1" ]] && { echo "$ids" >&2; die "Multiple identities — set CERT=\"Developer ID Application: <Name> (TEAMID)\" and re-run."; }
  echo "$ids" | sed -E 's/.*"([^"]+)".*/\1/'
}

cmd_build() {
  command -v swift >/dev/null || die "swift not found — install Xcode command line tools."
  [[ -n "${MOZI_B05_NODE_SOURCE:-}" ]] || printf '\033[1;33m⚠ MOZI_B05_NODE_SOURCE not set — falling back to Homebrew node@22.\n  The sandbox may fail to load its dylibs; for a clean result use official Node 22.\033[0m\n'
  local cert; cert="$(detect_cert)"
  if [[ "$cert" == "-" ]]; then step "Signing identity: ad-hoc (local test only, not distributable)"; else step "Signing identity: $cert"; fi

  # Distribution flags (timestamp + hardened runtime) only for a real cert;
  # ad-hoc local test drops them to avoid library-validation blocking the
  # Homebrew node dylibs.
  local FLAGS=(--force --options runtime --timestamp)
  [[ "$cert" == "-" ]] && FLAGS=(--force)

  step "Build .app"
  "$SPIKE/build-app.sh"

  step "Sign nested code (.node/.dylib) first"
  find "$APP" -type f \( -name "*.node" -o -name "*.dylib" \) -print0 |
    xargs -0 -I{} codesign "${FLAGS[@]}" --sign "$cert" "{}" 2>/dev/null || true

  step "Sign the Node helper with child entitlements (app-sandbox + inherit)"
  codesign "${FLAGS[@]}" \
    --entitlements "$SPIKE/entitlements/child-node.entitlements" \
    --sign "$cert" "$APP/Contents/Helpers/node"

  step "Sign the app bundle with app entitlements"
  codesign "${FLAGS[@]}" \
    --entitlements "$SPIKE/entitlements/app.entitlements" \
    --sign "$cert" "$APP"

  step "Verify signature + entitlements"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "--- app entitlements ---";   codesign -d --entitlements :- "$APP" 2>/dev/null | grep -E 'sandbox|user-selected|bookmarks|network|inherit' || true
  echo "--- node entitlements ---";  codesign -d --entitlements :- "$APP/Contents/Helpers/node" 2>/dev/null | grep -E 'sandbox|inherit' || true

  step "Reset previous state (best-effort)"
  # macOS protects app containers — `rm` on ~/Library/Containers/<id> returns
  # "Operation not permitted". Don't fight it (and don't let set -e abort):
  # clear only what we own. A stale bookmark just means the app auto-uses it;
  # use the app's "Revoke bookmark" button for a fully clean pick.
  rm -f "$OUTSIDE_FILE" 2>/dev/null || true
  rm -f "$RESULT" 2>/dev/null || true
  [[ -e "$GRANT_DIR" ]] && mv "$GRANT_DIR" "$GRANT_DIR.prev-$(date +%s)" 2>/dev/null || true
  mkdir -p "$GRANT_DIR" 2>/dev/null || true

  step "Launch"
  open "$APP"
  cat <<MANUAL

  Now do this BY HAND (NSOpenPanel needs a real click):
    1. Click  "Pick folder"
    2. Choose  $GRANT_DIR
    3. Wait a moment (child writes its result)
    4. Press  Cmd-Q  to quit
    5. Relaunch:   open "$APP"
    6. Then run:   $0 verify
MANUAL
}

cmd_verify() {
  [[ -f "$RESULT" ]] || die "No result at $RESULT — did you pick the folder, quit, and relaunch?"
  step "Child result JSON"; cat "$RESULT"; echo
  python3 - "$RESULT" <<'PY'
import json, sys
rec = json.load(open(sys.argv[1]))
child = json.loads(rec["stdout"]) if isinstance(rec.get("stdout"), str) else rec.get("stdout", {})
ok = (rec.get("terminationStatus") == 0 and child.get("verdict") == "pass"
      and child.get("inside", {}).get("ok") is True
      and child.get("outside", {}).get("ok") is False
      and child.get("outside", {}).get("denied") is True)
if ok:
    print("\n\033[1;32m✓ B0.5 PASS — grant works, outside write denied. Native path is GREEN for B1.\033[0m")
elif child.get("inside", {}).get("ok") is not True:
    print("\n\033[1;31m✗ inside write FAILED — parent-held access (design a) is insufficient.\033[0m")
    print("  → B1 must use a native bookmark bridge / XPC broker. Send me this JSON.")
elif child.get("outside", {}).get("ok") is True:
    print("\n\033[1;31m✗ outside write SUCCEEDED — not sandboxed. Fix signing/entitlements first.\033[0m")
else:
    print("\n\033[1;33m? Inconclusive — send me the JSON above.\033[0m")
PY
  echo; step "Sanity checks"
  ls -la "$GRANT_DIR" 2>/dev/null || true
  [[ -e "$OUTSIDE_FILE" ]] && echo "⚠ outside file EXISTS (bad): $OUTSIDE_FILE" || echo "✓ outside file absent (good)"
  grep -E 'bookmarkResolved|nodeChildFinished|scopedAccessStopped' "$LOG" 2>/dev/null || true
}

case "${1:-}" in
  build)  cmd_build ;;
  verify) cmd_verify ;;
  *) echo "usage: $0 {build|verify}   (see header comment for the full flow)"; exit 2 ;;
esac
