#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE="$ROOT/spikes/sandbox-b0"
STAGE="$SPIKE/stage"
BIN="$STAGE/bin"
LIB="$STAGE/lib"
NATIVE="$STAGE/native"

if [[ -n "${MOZI_B0_NODE:-}" ]]; then
  NODE_SRC="$MOZI_B0_NODE"
elif [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
  NODE_SRC=/opt/homebrew/opt/node@22/bin/node
elif [[ -x /opt/homebrew/bin/node ]]; then
  NODE_SRC=/opt/homebrew/bin/node
else
  NODE_SRC="$(command -v node)"
fi

LIBNODE_NAME="$(otool -L "$NODE_SRC" | sed -n 's#^[[:space:]]*@rpath/\(libnode\.[0-9][0-9]*\.dylib\).*$#\1#p' | head -1)"
LIBNODE_SRC=""
if [[ -n "$LIBNODE_NAME" ]]; then
  for candidate in \
    "$(cd "$(dirname "$NODE_SRC")/.." && pwd)/lib/$LIBNODE_NAME" \
    "/opt/homebrew/lib/$LIBNODE_NAME" \
    "/usr/local/lib/$LIBNODE_NAME"; do
    if [[ -f "$candidate" ]]; then
      LIBNODE_SRC="$candidate"
      break
    fi
  done
fi

SQLITE_SRC="$ROOT/node_modules/.pnpm/better-sqlite3@12.6.2/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
LANCE_SRC="$ROOT/node_modules/.pnpm/@lancedb+lancedb-darwin-arm64@0.27.0/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node"

rm -rf "$STAGE"
mkdir -p "$BIN" "$LIB" "$NATIVE"

cp "$NODE_SRC" "$BIN/node"
if [[ -n "$LIBNODE_SRC" ]]; then
  cp "$LIBNODE_SRC" "$LIB/$LIBNODE_NAME"
fi
cp "$SQLITE_SRC" "$NATIVE/better_sqlite3.node"
cp "$LANCE_SRC" "$NATIVE/lancedb.darwin-arm64.node"
chmod +x "$BIN/node"

echo "node_source=$NODE_SRC"
echo "node_copy=$BIN/node"
if [[ -n "$LIBNODE_SRC" ]]; then
  echo "libnode_source=$LIBNODE_SRC"
  echo "libnode_copy=$LIB/$LIBNODE_NAME"
else
  echo "libnode_copy=not-needed"
fi
echo "sqlite_native_copy=$NATIVE/better_sqlite3.node"
echo "lancedb_native_copy=$NATIVE/lancedb.darwin-arm64.node"

codesign --force --sign - "$BIN/node"
if [[ -n "$LIBNODE_SRC" ]]; then
  codesign --force --sign - "$LIB/$LIBNODE_NAME"
fi
codesign --force --sign - "$NATIVE/better_sqlite3.node"
codesign --force --sign - "$NATIVE/lancedb.darwin-arm64.node"

echo "codesign_verify_node:"
codesign --verify --verbose=4 "$BIN/node"
if [[ -n "$LIBNODE_SRC" ]]; then
  echo "codesign_verify_libnode:"
  codesign --verify --verbose=4 "$LIB/$LIBNODE_NAME"
fi
echo "codesign_verify_better_sqlite3:"
codesign --verify --verbose=4 "$NATIVE/better_sqlite3.node"
echo "codesign_verify_lancedb:"
codesign --verify --verbose=4 "$NATIVE/lancedb.darwin-arm64.node"

echo "codesign_display_node:"
codesign --display --verbose=2 "$BIN/node" 2>&1 | sed -n '1,16p'
if [[ -n "$LIBNODE_SRC" ]]; then
  echo "codesign_display_libnode:"
  codesign --display --verbose=2 "$LIB/$LIBNODE_NAME" 2>&1 | sed -n '1,16p'
fi
echo "codesign_display_better_sqlite3:"
codesign --display --verbose=2 "$NATIVE/better_sqlite3.node" 2>&1 | sed -n '1,16p'
echo "codesign_display_lancedb:"
codesign --display --verbose=2 "$NATIVE/lancedb.darwin-arm64.node" 2>&1 | sed -n '1,16p'

cd "$ROOT"
"$BIN/node" "$SPIKE/native-module-check.mjs"
