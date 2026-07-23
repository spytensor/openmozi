#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="NativeBookmarkB05"
APP_DIR="$ROOT/stage/$APP_NAME.app"
BUILD_PATH="${MOZI_B05_BUILD_PATH:-$ROOT/build/swiftpm}"
NODE_SOURCE="${MOZI_B05_NODE_SOURCE:-}"

if [[ -z "$NODE_SOURCE" ]]; then
  for candidate in \
    "/opt/homebrew/opt/node@22/bin/node" \
    "/usr/local/opt/node@22/bin/node"
  do
    if [[ -x "$candidate" ]]; then
      NODE_SOURCE="$candidate"
      break
    fi
  done
fi

echo "swift_build_path=$BUILD_PATH"
swift build --package-path "$ROOT" --build-path "$BUILD_PATH" -c release
BIN_PATH="$(swift build --package-path "$ROOT" --build-path "$BUILD_PATH" -c release --show-bin-path)"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$APP_DIR/Contents/Helpers"

cp "$BIN_PATH/$APP_NAME" "$APP_DIR/Contents/MacOS/$APP_NAME"
cp "$ROOT/Resources/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$ROOT/node-grant-check.mjs" "$APP_DIR/Contents/Resources/node-grant-check.mjs"
printf "APPL????" > "$APP_DIR/Contents/PkgInfo"

if [[ -z "$NODE_SOURCE" ]]; then
  echo "error: no Node 22 source found. Set MOZI_B05_NODE_SOURCE=/path/to/node-v22/bin/node." >&2
  exit 1
fi

NODE_VERSION="$("$NODE_SOURCE" -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "error: Node source must be Node 22, got v$NODE_VERSION at $NODE_SOURCE" >&2
  exit 1
fi

# Reject non-self-contained node (Homebrew/MacPorts): it links libs under
# /opt/homebrew etc. — directly AND transitively (libnode → libuv/icu/openssl).
# The App Sandbox blocks reading those paths, so the child dies with
# "file system sandbox blocked open()". Bundling them one-by-one is a rabbit
# hole (absolute install names, transitive deps). Only an OFFICIAL Node whose
# deps are all system libs works. Fail loud with the fix.
NODE_DEPS="$(otool -L "$NODE_SOURCE" | awk 'NR>1{print $1}')"
if echo "$NODE_DEPS" | grep -qE '/opt/homebrew|/opt/local|/usr/local/(opt|Cellar)'; then
  echo "error: '$NODE_SOURCE' links non-system dylibs the App Sandbox will block:" >&2
  echo "$NODE_DEPS" | grep -E '/opt/homebrew|/opt/local|/usr/local/(opt|Cellar)' | sed 's/^/  - /' >&2
  echo "  Use an OFFICIAL self-contained Node 22:" >&2
  echo "    curl -fsSLO https://nodejs.org/dist/v22.23.1/node-v22.23.1-darwin-arm64.tar.gz" >&2
  echo "    tar xzf node-v22.23.1-darwin-arm64.tar.gz" >&2
  echo "    export MOZI_B05_NODE_SOURCE=\$PWD/node-v22.23.1-darwin-arm64/bin/node" >&2
  exit 1
fi

cp "$NODE_SOURCE" "$APP_DIR/Contents/Helpers/node"
chmod 755 "$APP_DIR/Contents/MacOS/$APP_NAME" "$APP_DIR/Contents/Helpers/node"

echo "app=$APP_DIR"
echo "swift_executable=$APP_DIR/Contents/MacOS/$APP_NAME"
echo "node_helper=$APP_DIR/Contents/Helpers/node"
echo "node_version=v$NODE_VERSION"
echo "next=./spikes/native-bookmark-b05/run-smoke.sh"
