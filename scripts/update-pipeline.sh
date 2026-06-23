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
