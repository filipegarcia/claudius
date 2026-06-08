#!/usr/bin/env bash
# In-container end-to-end smoke for site/setup.sh.
#
# Invoked by site/test/test-install-public.sh inside the Ubuntu test image —
# the `.inner.sh` suffix marks this as the "runs inside the container" half
# of that pair. Don't run it directly on the host; it assumes a clean
# Ubuntu container with /src bind-mounted and an unprivileged $HOME.
# Unlike test-in-docker.sh (which stubs `bun` and uses --no-install --no-start
# to test rc-file detection), this one actually:
#
#   1. curls the *public* setup.sh from gh-pages (or $SETUP_URL override)
#   2. lets it install Bun + clone the public repo at $TEST_BRANCH
#   3. starts `bun run dev` in the background
#   4. polls /api/heartbeat until the server boots (Next compile can take ~60s)
#   5. asserts /api/heartbeatz also reports ok (i.e. SQLite + migrations OK)
#   6. tears the dev server down
#
# Exit code is 0 iff every step succeeds.
#
# Network required: the script pulls setup.sh, the Bun installer, the public
# git repo, and the npm registry via `bun install`. Skip this test on
# offline runners.

set -euo pipefail

BRANCH="${TEST_BRANCH:-main}"
SETUP_URL="${SETUP_URL:-https://claudius.network/install}"
PORT="${PORT:-3000}"
BOOT_TIMEOUT_SECS="${BOOT_TIMEOUT_SECS:-180}"

PREFIX="$HOME/claudius"
BIN_DIR="$HOME/.local/bin"
LOGFILE="$(mktemp -t claudius-dev.XXXXXX.log)"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

cleanup() {
  if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    # The launcher backgrounds a poller and execs bun; kill the whole pgrp.
    kill -- -"$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  # Bun's dev server forks a child renderer; sweep anything still on the port.
  pkill -f "next dev" 2>/dev/null || true
  pkill -f "bun run dev" 2>/dev/null || true
  if [ "${PRINT_LOG_ON_EXIT:-0}" = "1" ] && [ -s "$LOGFILE" ]; then
    printf '\n── dev-server log (%s) ──\n' "$LOGFILE" >&2
    tail -n 200 "$LOGFILE" >&2 || true
  fi
}
trap cleanup EXIT

printf '\n── step 1: download setup.sh from %s ─────\n' "$SETUP_URL"
SETUP_TMP="$(mktemp -t claudius-setup.XXXXXX.sh)"
curl -fsSL "$SETUP_URL" -o "$SETUP_TMP"
ok "fetched setup.sh ($(wc -c <"$SETUP_TMP" | tr -d ' ') bytes)"

printf '\n── step 2: install (branch=%s, prefix=%s) ─────\n' "$BRANCH" "$PREFIX"
# Run setup with --no-start: we want to control when (and how) the dev
# server boots so we can capture logs and time the readiness check.
bash "$SETUP_TMP" \
  --prefix="$PREFIX" \
  --bin-dir="$BIN_DIR" \
  --branch="$BRANCH" \
  --no-start
ok "claudius installed at $PREFIX"

if [ ! -x "$BIN_DIR/claudius" ]; then
  fail "launcher missing at $BIN_DIR/claudius"
  exit 1
fi

printf '\n── step 3: boot dev server in background ─────\n'
# `setsid` puts the dev server in its own process group so the trap can
# tear down the whole tree (Next forks a child renderer).
PRINT_LOG_ON_EXIT=1
export CLAUDIUS_NO_OPEN=1 PORT
setsid "$BIN_DIR/claudius" >"$LOGFILE" 2>&1 &
DEV_PID=$!
ok "launcher pid=$DEV_PID, logs=$LOGFILE"

printf '\n── step 4: poll /api/heartbeat (timeout=%ss) ─────\n' "$BOOT_TIMEOUT_SECS"
URL_HEARTBEAT="http://127.0.0.1:${PORT}/api/heartbeat"
URL_HEARTBEATZ="http://127.0.0.1:${PORT}/api/heartbeatz"

deadline=$(( $(date +%s) + BOOT_TIMEOUT_SECS ))
heartbeat_body=""
while :; do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    fail "dev server exited before /api/heartbeat returned 200"
    exit 1
  fi
  if heartbeat_body="$(curl -fsS --max-time 5 "$URL_HEARTBEAT" 2>/dev/null)"; then
    ok "/api/heartbeat → 200"
    printf '    %s\n' "$heartbeat_body"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "timeout after ${BOOT_TIMEOUT_SECS}s waiting for /api/heartbeat"
    exit 1
  fi
  sleep 2
done

printf '\n── step 5: curl /api/heartbeatz (DB readiness) ─────\n'
# Allow up to 30s for the first heartbeatz: heartbeat is statically compiled
# but heartbeatz triggers `better-sqlite3` + migrations on first hit.
heartbeatz_body=""
hb_deadline=$(( $(date +%s) + 30 ))
while :; do
  if heartbeatz_body="$(curl -fsS --max-time 10 "$URL_HEARTBEATZ" 2>/dev/null)"; then
    ok "/api/heartbeatz → 200"
    printf '    %s\n' "$heartbeatz_body"
    break
  fi
  if [ "$(date +%s)" -ge "$hb_deadline" ]; then
    fail "/api/heartbeatz did not return 200 within 30s"
    # surface the body even on non-2xx for debugging
    curl -sS -o /tmp/hbz.out -w 'http=%{http_code}\n' "$URL_HEARTBEATZ" >&2 || true
    cat /tmp/hbz.out >&2 || true
    exit 1
  fi
  sleep 2
done

PRINT_LOG_ON_EXIT=0
printf '\n\033[32m✓ public-install smoke passed\033[0m (branch=%s)\n' "$BRANCH"
