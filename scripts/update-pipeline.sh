#!/usr/bin/env bash
# scripts/update-pipeline.sh — single cron entrypoint that runs BOTH
# update pipelines back-to-back in one firing:
#
#   1. SDK updater (scripts/sdk-update/run.sh) — bumps
#      @anthropic-ai/claude-agent-sdk. Via the orchestrator's "combined
#      mode" it ALSO absorbs a claude-code parity tag-along when both
#      have a new release, shipping them as one PR.
#   2. CC parity   (scripts/cc-parity/run.sh)  — handles a standalone
#      claude-code release when there was no SDK bump to combine with.
#
# Order matters: SDK first. When BOTH have updates the SDK half does
# them together and advances cc-parity state, so the CC half then noops
# — no double work. When only claude-code moved, the SDK half noops and
# the CC half does the work.
#
# Concurrency: each child takes the SHARED single-instance lock itself
# (scripts/lib/run-lock.sh — portable, no flock, works on macOS), so a
# firing that runs long cleanly blocks the next hour's firing. This
# wrapper holds no lock of its own; it just runs the two children in
# sequence and always runs BOTH (one failing must not skip the other).
#
# ─── Install (one cron line for both) ────────────────────────────────
#   make update-install-cron        # 0 * * * * → this script
#
# ─── Required commands on PATH ───────────────────────────────────────
#   bun, git, gh, curl. macOS-friendly — no flock needed.

# NOT `set -e`: a non-zero exit from the first pipeline must not stop us
# from running the second. We capture and report each rc explicitly.
set -uo pipefail

# Repo root = parent of this script's directory (this file lives in
# scripts/, one level down — children live in scripts/<name>/, two down).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── macOS / cron PATH ────────────────────────────────────────────────
# cron and launchd run with a minimal PATH (/usr/bin:/bin). bun lives in
# ~/.bun/bin and Homebrew tools (gh, git) in /opt/homebrew/bin (Apple
# Silicon) or /usr/local/bin (Intel). Without this the hourly cron fires
# and silently finds no `bun`, doing nothing. The children inherit this.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

log() { printf '[update-pipeline %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ── Stale-process reaper ─────────────────────────────────────────────
# The gate steps now self-timeout (shStreamCapture), but a stall OUTSIDE
# a gate — a wedged git/gh/network call, or an orchestrate the OS froze
# across a sleep — can still leave a process running for hours. The
# run-lock only reclaims DEAD holders; an alive-but-wedged holder blocks
# every later firing, so nothing recovers (this is exactly what stranded
# cc-parity 2.1.197: a hung Playwright held the lock ~10h). This runs
# FIRST, before the lock is contended, and kills any of OUR pipeline
# processes older than RUN_STALL_MAX_AGE_SEC (default 6h — the same
# wall-clock budget the orchestrator gives Claude, so a healthy run is
# never near it). Portable: no GNU `timeout`, macOS bash-3.2 clean.
RUN_STALL_MAX_AGE_SEC="${RUN_STALL_MAX_AGE_SEC:-21600}"

_etime_to_secs() {
  # $1 = ps etime; formats: SS, MM:SS, HH:MM:SS, DD-HH:MM:SS
  awk -v e="$1" 'BEGIN{
    n=split(e, a, /[-:]/); s=0
    if (n==1) s=a[1]
    else if (n==2) s=a[1]*60+a[2]
    else if (n==3) s=a[1]*3600+a[2]*60+a[3]
    else if (n==4) s=a[1]*86400+a[2]*3600+a[3]*60+a[4]
    printf "%d", s
  }'
}

reap_stalled_pipeline() {
  victims=""
  while read -r pid pgid etime cmd; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" = "$$" ] && continue      # never reap this firing…
    [ "$pid" = "$PPID" ] && continue   # …or its launcher
    case "$cmd" in
      *scripts/sdk-update/orchestrate.ts*|*scripts/cc-parity/orchestrate.ts*|\
*scripts/sdk-update/run.sh*|*scripts/cc-parity/run.sh*|\
*scripts/update-pipeline.sh*|*"playwright test"*|*"run test:e2e"*) ;;
      *) continue ;;
    esac
    secs="$(_etime_to_secs "$etime")"
    [ "${secs:-0}" -gt "$RUN_STALL_MAX_AGE_SEC" ] || continue
    log "reaping STALLED pipeline pid=$pid pgid=$pgid age=${secs}s (>${RUN_STALL_MAX_AGE_SEC}s): $cmd"
    victims="$victims ${pid}:${pgid}"
  done <<EOF
$(ps -axo pid=,pgid=,etime=,command= 2>/dev/null)
EOF
  [ -z "$victims" ] && return 0
  # SIGTERM the whole process GROUP of each victim (children spawn as
  # detached groups, e.g. bun→bash→node→chromium), grace, then SIGKILL.
  for v in $victims; do kill -TERM "-${v#*:}" 2>/dev/null || true; done
  sleep 3
  for v in $victims; do
    p="${v%:*}"; pg="${v#*:}"
    if kill -0 "$p" 2>/dev/null; then
      kill -KILL "-${pg}" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true
    fi
  done
  # If we just freed a wedged lock holder, drop the now-orphaned lock dir
  # so this firing can acquire it instead of skipping.
  lockdir="$ROOT/.claudius/run.lock.d"
  if [ -d "$lockdir" ]; then
    lockpid="$(cat "$lockdir/holder.pid" 2>/dev/null || true)"
    if [ -z "$lockpid" ] || ! kill -0 "$lockpid" 2>/dev/null; then
      rm -rf "$lockdir" 2>/dev/null || true
      log "cleared stale run-lock after reaping its holder"
    fi
  fi
}

reap_stalled_pipeline

log "starting combined update run (sdk-update → cc-parity)"

sdk_rc=0
log "── sdk-update ─────────────────────────────────────"
scripts/sdk-update/run.sh || sdk_rc=$?
log "sdk-update finished (rc=$sdk_rc)"

cc_rc=0
log "── cc-parity ──────────────────────────────────────"
scripts/cc-parity/run.sh || cc_rc=$?
log "cc-parity finished (rc=$cc_rc)"

log "combined update run done (sdk-update rc=$sdk_rc, cc-parity rc=$cc_rc)"

# Surface a non-zero exit if EITHER half failed — but only after both ran.
if [ "$sdk_rc" -ne 0 ] || [ "$cc_rc" -ne 0 ]; then
  exit 1
fi
exit 0
