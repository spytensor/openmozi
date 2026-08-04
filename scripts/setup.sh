#!/usr/bin/env bash
# MOZI one-command source setup.
#
#   ./scripts/setup.sh          install dependencies, print next steps
#   ./scripts/setup.sh app      + build the macOS desktop app (Apple Silicon)
#   ./scripts/setup.sh server   + build the headless server + Web UI
#   ./scripts/setup.sh --check  environment check only, no changes
#
# Design constraints, learned from real community failures:
# - Never run `corepack enable`: it writes symlinks into Node's bin directory,
#   which needs sudo for nodejs.org installs, and the command does not even
#   exist on Node >= 25 (corepack is no longer bundled).
# - Never require a globally installed pnpm: resolve the repository-pinned
#   version through `corepack pnpm` (no global writes) or `npx -y pnpm@<pin>`.
# - Never just say "wrong Node version": find a usable Node 22.12–25 from
#   common installers (Homebrew, nvm, fnm, mise, volta, asdf) automatically,
#   and only ask the user to install one when none exists anywhere.
#
# Compatible with macOS system bash 3.2: no associative arrays, no mapfile.

set -u -o pipefail

cd "$(dirname "$0")/.." || exit 1

MODE="${1:-}"
case "$MODE" in
  ""|app|server|--check|check) ;;
  -h|--help)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown mode: $MODE (expected: app | server | --check)" >&2
    exit 2
    ;;
esac
[ "$MODE" = "check" ] && MODE="--check"

info() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$1" >&2; shift; for line in "$@"; do printf '  %s\n' "$line" >&2; done; exit 1; }

# ---------------------------------------------------------------------------
# Platform gate
# ---------------------------------------------------------------------------
step "Platform"
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    if [ "$ARCH" != "arm64" ]; then
      die "Intel Macs are not supported." \
        "The vector database dependency ships no macOS x64 binary." \
        "Supported: macOS Apple Silicon, Linux x64/arm64."
    fi
    ;;
  Linux)
    case "$ARCH" in
      x86_64|aarch64|arm64) ;;
      *) die "Unsupported Linux architecture: $ARCH (supported: x64, arm64)." ;;
    esac
    if [ "$MODE" = "app" ]; then
      die "The desktop app build targets macOS Apple Silicon." \
        "On Linux, run: ./scripts/setup.sh server"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Native Windows is not supported. Use WSL2 (Ubuntu) and run this script inside it."
    ;;
  *)
    die "Unsupported platform: $OS"
    ;;
esac
info "$OS $ARCH"

# ---------------------------------------------------------------------------
# Node resolution: engines require >=22.12 <26
# ---------------------------------------------------------------------------
node_version_ok() {
  # $1 = path to a node binary; prints "major.minor.patch" on success
  local v major minor
  v="$("$1" --version 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  case "$major" in
    22) [ "$minor" -ge 12 ] || return 1 ;;
    23|24|25) ;;
    *) return 1 ;;
  esac
  printf '%s' "$v"
}

find_node() {
  # Prints "path<space>version" of the best usable node, or nothing.
  local candidates="" dir best_path="" best_version="" best_key=0 path v key rank major minor

  if command -v node >/dev/null 2>&1; then
    candidates="$candidates
$(command -v node)"
  fi
  for dir in \
    /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@24/bin \
    /usr/local/opt/node@22/bin /usr/local/opt/node@24/bin; do
    [ -x "$dir/node" ] && candidates="$candidates
$dir/node"
  done
  for dir in \
    "$HOME"/.nvm/versions/node/v*/bin \
    "$HOME/Library/Application Support/fnm/node-versions"/v*/installation/bin \
    "$HOME"/.local/share/fnm/node-versions/v*/installation/bin \
    "$HOME"/.local/share/mise/installs/node/*/bin \
    "$HOME"/.volta/tools/image/node/*/bin \
    "$HOME"/.asdf/installs/nodejs/*/bin; do
    [ -x "$dir/node" ] && candidates="$candidates
$dir/node"
  done

  # Rank: prefer the LTS majors the repo actually tests on (22, then 24).
  # Odd, non-LTS majors (23, 25) pass MOZI's engine range but are rejected by
  # dependency engine pins (vitest excludes Node 23) — keep them as last
  # resorts only. Within a rank, higher version wins; first seen wins ties,
  # so the user's own default node is preferred at equal footing.
  local IFS='
'
  for path in $candidates; do
    [ -n "$path" ] || continue
    v="$(node_version_ok "$path")" || continue
    major="${v%%.*}"
    minor="${v#*.}"; minor="${minor%%.*}"
    case "$major" in
      22) rank=3 ;;
      24) rank=2 ;;
      *)  rank=1 ;;
    esac
    key=$((rank * 1000000 + major * 1000 + minor))
    if [ "$key" -gt "$best_key" ]; then
      best_key="$key"
      best_path="$path"
      best_version="$v"
    fi
  done
  [ -n "$best_path" ] && printf '%s %s' "$best_path" "$best_version"
}

step "Node.js (need >= 22.12 and < 26)"
CURRENT_NODE_DESC="none found on PATH"
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_DESC="$(node --version 2>/dev/null) at $(command -v node)"
fi

# MOZI_NODE is a hard override: if the user pointed at a node, use exactly
# that one (after the version gate) instead of shopping around.
if [ -n "${MOZI_NODE:-}" ]; then
  OVERRIDE_VERSION="$(node_version_ok "$MOZI_NODE")" \
    || die "MOZI_NODE=$MOZI_NODE is not a usable Node >=22.12 <26."
  FOUND="$MOZI_NODE $OVERRIDE_VERSION"
else
  FOUND="$(find_node)"
fi
if [ -z "$FOUND" ]; then
  if [ "$OS" = "Darwin" ]; then
    die "No usable Node.js found (current: $CURRENT_NODE_DESC)." \
      "Install one of:" \
      "  brew install node@22        # then re-run this script (it will find it)" \
      "  https://nodejs.org — download the 22 LTS installer" \
      "Note: the latest Node (26) is too new for our native dependencies."
  else
    die "No usable Node.js found (current: $CURRENT_NODE_DESC)." \
      "Install Node 22 LTS, e.g.:" \
      "  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22" \
      "or use your distribution's Node 22 packages, then re-run this script."
  fi
fi
NODE_BIN="${FOUND% *}"
NODE_VERSION="${FOUND##* }"
NODE_DIR="$(dirname "$NODE_BIN")"
DEFAULT_NODE="$(command -v node 2>/dev/null || true)"
export PATH="$NODE_DIR:$PATH"
info "using node v$NODE_VERSION ($NODE_BIN)"
if [ "$DEFAULT_NODE" != "$NODE_BIN" ]; then
  info "note: your default node is $CURRENT_NODE_DESC; the one above is used for this run only"
fi

# ---------------------------------------------------------------------------
# pnpm resolution: exact repository pin, zero global writes, zero sudo
# ---------------------------------------------------------------------------
step "pnpm"
PNPM_PIN="$(node -p "(require('./package.json').packageManager||'').split('@')[1]||''")"
[ -n "$PNPM_PIN" ] || die "Could not read the pnpm version pin from package.json (packageManager field)."

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_DEFAULT_TO_LATEST=0

PNPM_STRATEGY=""
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version 2>/dev/null)" = "$PNPM_PIN" ]; then
  PNPM_STRATEGY="local"
elif command -v corepack >/dev/null 2>&1; then
  PNPM_STRATEGY="corepack"
else
  PNPM_STRATEGY="npx"
fi

# Repository scripts invoke `pnpm` recursively (e.g. desktop:pack:mac runs
# `pnpm desktop:prepare-package`), and neither corepack nor npx puts a `pnpm`
# on the child PATH. Verified live: without this shim the recursive call dies
# with "sh: pnpm: command not found". A throwaway shim directory is the
# no-sudo, no-global equivalent of `corepack enable`.
if [ "$PNPM_STRATEGY" != "local" ]; then
  SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mozi-setup-pnpm.XXXXXX")" || die "mktemp failed."
  trap 'rm -rf "$SHIM_DIR"' EXIT
  if [ "$PNPM_STRATEGY" = "corepack" ]; then
    COREPACK_BIN="$(command -v corepack)"
    printf '#!/bin/sh\nexec "%s" pnpm "$@"\n' "$COREPACK_BIN" > "$SHIM_DIR/pnpm"
  else
    NPX_BIN="$(command -v npx)" || die "Neither corepack nor npx is available next to node $NODE_BIN."
    printf '#!/bin/sh\nexec "%s" -y "pnpm@%s" "$@"\n' "$NPX_BIN" "$PNPM_PIN" > "$SHIM_DIR/pnpm"
  fi
  chmod +x "$SHIM_DIR/pnpm"
  export PATH="$SHIM_DIR:$PATH"
fi

run_pnpm() {
  pnpm "$@"
}

case "$PNPM_STRATEGY" in
  local)    info "using installed pnpm $PNPM_PIN (matches the repository pin)" ;;
  corepack) info "using 'corepack pnpm' -> pnpm $PNPM_PIN (no 'corepack enable', no sudo, no global install)" ;;
  npx)      info "using 'npx pnpm@$PNPM_PIN' (no corepack on this Node; no global install needed)" ;;
esac

if [ "$MODE" = "--check" ]; then
  RESOLVED="$(run_pnpm --version 2>/dev/null)"
  [ "$RESOLVED" = "$PNPM_PIN" ] || die "pnpm resolution failed: expected $PNPM_PIN, got '${RESOLVED:-nothing}'."
  step "Check passed"
  info "node v$NODE_VERSION, pnpm $RESOLVED via $PNPM_STRATEGY"
  info "next: ./scripts/setup.sh        (install)"
  info "      ./scripts/setup.sh app    (macOS desktop app)"
  info "      ./scripts/setup.sh server (headless server + Web UI)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Install + build
# ---------------------------------------------------------------------------
step "Installing dependencies"
run_pnpm install || die "pnpm install failed." \
  "If the error above mentions your Node version, re-run this script — it selects a supported Node automatically." \
  "Otherwise please open an issue with the full output."

if [ "$MODE" = "app" ]; then
  step "Building the macOS desktop app (unsigned local build)"
  # Match CI: skip code-signing discovery unless the user opts in.
  if [ -z "${MOZI_SETUP_ALLOW_SIGNING:-}" ]; then
    export CSC_IDENTITY_AUTO_DISCOVERY=false
  fi
  run_pnpm desktop:pack:mac || die "Desktop packaging failed." \
    "Re-run with the same command; if it keeps failing, open an issue with the full output."
  APP_PATH="desktop/dist/mac-arm64/MOZI.app"
  if [ -d "$APP_PATH" ]; then
    step "Done"
    info "App built: $APP_PATH"
    info "Drag it into /Applications and launch it."
  else
    die "Packaging reported success but $APP_PATH was not found." \
      "Check desktop/dist/ for the actual output path."
  fi
elif [ "$MODE" = "server" ]; then
  step "Building the server runtime + Web UI"
  run_pnpm build:all || die "Build failed."
  step "Done"
  info "Next steps:"
  info "  ./scripts/setup.sh --check   # prints how pnpm is being run on this machine"
  info "  pnpm mozi onboard            # interactive setup: provider, API key"
  info "  pnpm start                   # Web UI at http://localhost:9210"
  if [ "$PNPM_STRATEGY" != "local" ]; then
    info "No global pnpm on this machine — prefix commands accordingly, e.g.:"
    case "$PNPM_STRATEGY" in
      corepack) info "  corepack pnpm start" ;;
      npx)      info "  npx -y pnpm@$PNPM_PIN start" ;;
    esac
  fi
else
  step "Done"
  info "Dependencies installed. Next:"
  info "  ./scripts/setup.sh app       # macOS desktop app"
  info "  ./scripts/setup.sh server    # headless server + Web UI"
fi
