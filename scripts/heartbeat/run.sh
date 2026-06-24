#!/usr/bin/env bash
# scripts/heartbeat/run.sh — daily cron entrypoint for the liveness +
# activity heartbeat. Posts ONE message to the community chat-server:
# "alive, all quiet" or "alive, N update(s)" with the PRs listed.
#
# Read-only and quick (a couple of `gh` calls + one HTTP POST), so it
# takes NO lock and never collides with the update pipelines — safe to
# run on its own daily schedule alongside the hourly update cron.
#
# ─── Install ─────────────────────────────────────────────────────────
#   make heartbeat-install-cron        # daily at 09:00 local
#
# ─── Required commands on PATH ───────────────────────────────────────
#   bun, gh (authenticated via GH_TOKEN in the env file, or `gh auth login`).
#   No flock, and — unlike the pipelines — no ~/.claude credential read,
#   so macOS Full Disk Access is NOT required for this job.

set -uo pipefail

# Repo root = two levels up (scripts/heartbeat/ → repo root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# cron/launchd run with a minimal PATH; make bun + gh findable on macOS
# (Homebrew) and Linux. Same rationale as scripts/update-pipeline.sh.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

STATE_DIR="$ROOT/.claudius/heartbeat"
ENV_FILE="$STATE_DIR/env"
mkdir -p "$STATE_DIR/logs"

# Load the heartbeat env file if present; otherwise fall back to the
# sdk-updater env (same CHAT_SERVER_* + GH_TOKEN — no need to duplicate).
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
elif [ -f "$ROOT/.claudius/sdk-updater/env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT/.claudius/sdk-updater/env"
  set +a
fi

exec bun run scripts/heartbeat/heartbeat.ts "$@"
