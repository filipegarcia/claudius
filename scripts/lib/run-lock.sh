#!/usr/bin/env bash
# scripts/lib/run-lock.sh — portable single-instance lock.
#
# Replaces the old `flock`-on-fd-200 guard so the update pipelines run on
# macOS too (macOS ships no `flock`). `mkdir` is atomic on every POSIX
# filesystem, so a directory makes a fine mutex with no extra tooling.
#
# Usage (source it, then call):
#
#     . "$ROOT/scripts/lib/run-lock.sh"
#     run_lock_acquire "$ROOT/.claudius/run.lock.d" \
#       || { echo "lock held — skipping"; exit 0; }
#     # ... lock auto-released when THIS shell exits (EXIT trap) ...
#
# IMPORTANT: the release is an `EXIT` trap, which `exec` discards. The
# old flock survived `exec bun …` via the inherited fd; this lock does
# not. Callers must therefore run the final orchestrator as a plain
# `bun run …` (not `exec bun run …`) so the shell stays alive to fire
# the trap. See scripts/sdk-update/run.sh.
#
# Keep this file bash-3.2 clean — macOS /bin/bash is 3.2.

# Acquire the lock at $1 (a directory path). Returns 0 on success (and
# installs the auto-release trap), 1 if another LIVE process holds it.
run_lock_acquire() {
  lockdir="$1"
  pidfile="$lockdir/holder.pid"
  attempts=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Lock dir exists. Is the holder still alive?
    holder=""
    if [ -f "$pidfile" ]; then
      holder="$(cat "$pidfile" 2>/dev/null || true)"
    fi
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      return 1 # genuinely held by a running process — back off
    fi
    # Stale (holder dead) or half-created (mkdir won, pidfile not written
    # yet). Reclaim and retry. Bounded so a pathological race can't spin
    # forever. NOTE: there is a tiny theoretical window where two callers
    # both reclaim a dead lock and both proceed — impossible for hourly
    # cron (the wrapper runs the two pipelines sequentially, never
    # concurrently); only a human double-firing `make …-run` within the
    # same instant could trigger it. Acceptable, and self-heals next run.
    rm -rf "$lockdir" 2>/dev/null || true
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 10 ]; then
      return 1
    fi
    sleep 0.2
  done
  printf '%s\n' "$$" >"$pidfile"
  # Release on ANY exit of this shell (normal, error, or signal).
  # shellcheck disable=SC2064
  trap "rm -rf '$lockdir' 2>/dev/null || true" EXIT
  return 0
}
