#!/usr/bin/env bash
# scripts/e2e-webserver.sh — instrumented wrapper around the Playwright
# e2e dev server.
#
# WHY THIS EXISTS: on the cron host the e2e `next dev` server has died
# mid-run (issue #128) — ~2/3 through the suite it stopped accepting
# connections and every later spec failed with connection-refused (both
# browser navigations and Node API calls). Playwright's own `[WebServer]`
# pipe shows the server's stdout/stderr but NOT why/when it exited, so the
# crash left no cause behind. This wrapper records that missing signal.
#
# OPT-IN: playwright.config.ts only routes the webServer through this
# wrapper when CLAUDIUS_E2E_WEBSERVER_LOG is set (the cron sets it in
# .claudius/sdk-updater/env). A normal `bun run test:e2e` and CI run the
# plain `next dev` command unchanged — this adds no layer for anyone else.
#
# What it captures to $CLAUDIUS_E2E_WEBSERVER_LOG (survives the run, separate
# from the giant pipeline log):
#   - start banner with timestamp + a memory snapshot
#   - the server's own stdout/stderr, tee'd through
#   - on ANY exit it can trap (normal crash, SIGTERM from Playwright
#     teardown): the exit code + timestamp + a final memory snapshot.
#     A SIGKILL/OS OOM-kill can't be trapped, but the periodic samples
#     below leave a trail right up to the moment of death.
#
# Usage: e2e-webserver.sh <port>   (run BY Playwright's webServer.command)
set -uo pipefail

PORT="${1:?usage: e2e-webserver.sh <port>}"
LOG="${CLAUDIUS_E2E_WEBSERVER_LOG:?CLAUDIUS_E2E_WEBSERVER_LOG must be set}"

mkdir -p "$(dirname "$LOG")"

# Portable "memory snapshot" line — macOS `vm_stat`, else Linux /proc.
mem_snapshot() {
  if command -v vm_stat >/dev/null 2>&1; then
    vm_stat 2>/dev/null | awk '
      /Pages free/         {f=$3}
      /Pages active/       {a=$3}
      /Pages wired down/   {w=$4}
      /Pages occupied by compressor/ {c=$5}
      END {printf "vm_stat pages free=%s active=%s wired=%s compressed=%s", f, a, w, c}'
  elif [ -r /proc/meminfo ]; then
    awk '/MemAvailable|MemFree|MemTotal/ {printf "%s=%s ", $1, $2}' /proc/meminfo
  else
    echo "mem: (no vm_stat or /proc/meminfo)"
  fi
}

ts() { date -u +%FT%TZ; }

{
  echo "──────────────────────────────────────────────────────────────"
  echo "[e2e-webserver $(ts)] START  port=$PORT pid=$$  $(mem_snapshot)"
} >> "$LOG"

# Periodic memory sampler — leaves a breadcrumb trail so even an
# untrappable OS OOM-kill has a "last known memory" line right before it.
# Killed in the trap below.
(
  while true; do
    sleep 30
    echo "[e2e-webserver $(ts)] sample pid=$$  $(mem_snapshot)" >> "$LOG"
  done
) &
SAMPLER_PID=$!

# Record the reason on any trappable exit (normal crash exit code OR the
# SIGTERM Playwright sends on teardown), then stop the sampler.
on_exit() {
  local code=$?
  kill "$SAMPLER_PID" 2>/dev/null || true
  {
    echo "[e2e-webserver $(ts)] EXIT   code=$code  $(mem_snapshot)"
    echo "──────────────────────────────────────────────────────────────"
  } >> "$LOG"
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Run the dev server in the foreground (NOT `exec` — exec would replace this
# shell and discard the traps). Tee its output into the persistent log AND to
# our stdout so Playwright's `[WebServer]` pipe still shows it live.
next dev -p "$PORT" 2>&1 | tee -a "$LOG"
# Propagate the server's real exit status, not tee's.
exit "${PIPESTATUS[0]}"
