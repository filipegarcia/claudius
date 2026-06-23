#!/usr/bin/env bash
# scripts/cc-parity/run.sh — cron entrypoint for the cc-parity reviewer.
# Sibling to scripts/sdk-update/run.sh; shares the same portable lock at
# $ROOT/.claudius/run.lock.d so the two pipelines block each other on
# purpose. Normally both are run back-to-back in one firing by
# scripts/update-pipeline.sh (the recommended single cron).
#
# What this does:
#   1. Acquire the SHARED lock so an in-flight sdk-update OR cc-parity
#      run skips this firing cleanly.
#   2. Run `check.ts` — exits fast unless there's a new claude-code
#      release worth reviewing (and not just a bug-fix release).
#   3. If there is one, call `orchestrate.ts` which does branch +
#      Claude run + (no dep bump — see orchestrate.ts) + gate + draft
#      PR + CI watch + announce.
#
# Designed to be safe to run from cron on a headless server. No
# interactive prompts, no stdin reads. All logs go to STDOUT/STDERR
# so cron's MAILTO (or your log-shipper) catches them.
#
# ─── Install (on a Linux server) ─────────────────────────────────────
#
#   # one-time setup, assuming sdk-update is already deployed
#   mkdir -p .claudius/cc-parity/logs
#
#   # env file — optional; falls back to the sdk-updater env if missing.
#   cat > .claudius/cc-parity/env <<'EOF'
#   # Same auth + chat-server config as sdk-update — no extra Anthropic
#   # credential needed.
#   CC_PARITY_ROOM_SLUG=sdk-update    # same room; emoji disambiguates
#   # CC_PARITY_MAX_MINOR_JUMP=1
#   # CC_PARITY_MIN_HOURS_BETWEEN_RUNS=0   # RESERVED, not yet honored
#   EOF
#   chmod 600 .claudius/cc-parity/env
#
#   # Recommended: one cron that runs BOTH pipelines back-to-back.
#   make update-install-cron
#
# ─── Required commands on PATH ───────────────────────────────────────
#   bun, git, gh, curl. Locking is portable (scripts/lib/run-lock.sh),
#   so no flock is required — runs on macOS and Linux alike.

set -euo pipefail

# Repo root = parent of this script's directory (matches claudiusd).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT/.claudius/cc-parity"
LOG_DIR="$STATE_DIR/logs"
# SHARED lock — see the matching comment in scripts/sdk-update/run.sh.
# The two pipelines block each other on purpose so a long-running
# sdk-update doesn't have a cc-parity firing land mid-stream and
# clobber the working tree.
LOCK_DIR="$ROOT/.claudius/run.lock.d"
ENV_FILE="$STATE_DIR/env"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$ROOT/.claudius"

# Load env file if present. Fall back to the sdk-update env so an
# operator doesn't have to duplicate Claude/gh/chat-server credentials.
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

log() {
  printf '[cc-parity/run %s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

# ── Concurrency guard ────────────────────────────────────────────────
# Portable single-instance lock (works on macOS — no flock). Released
# via an EXIT trap, so the final orchestrate must be a plain `bun run`
# (NOT `exec bun run`): `exec` would replace this shell and discard the
# trap, leaking the lock dir. See scripts/lib/run-lock.sh.
# shellcheck source=scripts/lib/run-lock.sh
. "$ROOT/scripts/lib/run-lock.sh"
if ! run_lock_acquire "$LOCK_DIR"; then
  log "another pipeline is already in progress (lock held on $LOCK_DIR) — skipping"
  exit 0
fi

cd "$ROOT"

# ── Mode dispatch ────────────────────────────────────────────────────
# `run.sh fix-pr <number>` skips the npm version probe entirely: it
# checks out an existing PR's branch and re-runs Claude to fix it.
# Invoked by `make cc-parity-fix-pr PR=<n>`.
if [ "${1:-}" = "fix-pr" ]; then
  FIX_PR_NUM="${2:-}"
  if [ -z "$FIX_PR_NUM" ]; then
    log "fix-pr requires a PR number: run.sh fix-pr <number>"
    exit 2
  fi
  log "fix-pr mode for PR #$FIX_PR_NUM"
  ORCH_ARGS=(--fix-pr="$FIX_PR_NUM")
  if [ -n "${CC_PARITY_SKIP_GATES:-}" ]; then
    log "skipping gates: ${CC_PARITY_SKIP_GATES}"
    ORCH_ARGS+=("--skip-gates=${CC_PARITY_SKIP_GATES}")
  fi
  # Plain `bun run` (not `exec`) so the lock's EXIT trap still fires.
  bun run scripts/cc-parity/orchestrate.ts "${ORCH_ARGS[@]}"
  exit $?
fi

# ── Check ────────────────────────────────────────────────────────────
# We hold the exclusive lock from here on. A live orchestrate would
# still be holding that lock — so the fact that we acquired it proves
# none is running. Tell check.ts to reclaim any stale inFlight marker
# immediately instead of waiting 24h.
export CC_PARITY_LOCK_HELD=1

log "checking for claude-code updates"

CHECK_JSON="$(bun run scripts/cc-parity/check.ts 2>>"$LOG_DIR/check.stderr.log" || true)"

if [ -z "$CHECK_JSON" ]; then
  log "check.ts returned no output (see check.stderr.log) — aborting this firing"
  exit 1
fi

EVAL_LINES="$(printf '%s' "$CHECK_JSON" | bun -e '
  const j = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  for (const k of ["kind", "baseline", "latest", "previousVersion", "newVersion"]) {
    const v = j[k];
    if (v != null) process.stdout.write(`${k.toUpperCase()}=${v}\n`);
  }
')"
# shellcheck disable=SC2046
eval "$EVAL_LINES"

DECISION_KIND="${KIND:-}"

log "decision=$DECISION_KIND baseline=${BASELINE:-(none)} latest=${LATEST:-(none)}"

case "$DECISION_KIND" in
  noop|skip|in-flight)
    exit 0
    ;;
  run)
    : # fall through
    ;;
  *)
    log "unexpected decision kind: $DECISION_KIND — aborting"
    exit 1
    ;;
esac

# ── Orchestrate ──────────────────────────────────────────────────────
PREV="${PREVIOUSVERSION:-}"
NEW="${NEWVERSION:-}"
if [ -z "$NEW" ]; then
  log "newVersion missing from check.ts payload — aborting"
  exit 1
fi

log "kicking off orchestrate for $PREV -> $NEW"

# Build the orchestrate.ts argv from env. Operators set:
#   CC_PARITY_DRY_RUN=1            — local-only run (no push/PR/announce)
#   CC_PARITY_SKIP_GATES=lint,e2e  — skip selected gate steps
ORCH_ARGS=(--previous="$PREV" --version="$NEW")
if [ "${CC_PARITY_DRY_RUN:-0}" = "1" ]; then
  log "DRY-RUN mode (CC_PARITY_DRY_RUN=1) — will not push/PR/announce"
  ORCH_ARGS+=(--dry-run)
fi
if [ -n "${CC_PARITY_SKIP_GATES:-}" ]; then
  log "skipping gates: ${CC_PARITY_SKIP_GATES}"
  ORCH_ARGS+=("--skip-gates=${CC_PARITY_SKIP_GATES}")
fi
# Plain `bun run` (not `exec`) so the lock's EXIT trap releases the lock
# dir when the orchestrator returns. See the concurrency guard above.
bun run scripts/cc-parity/orchestrate.ts "${ORCH_ARGS[@]}"
