#!/usr/bin/env bash
# scripts/sdk-update/run.sh — hourly cron entrypoint for the SDK updater.
#
# What this does:
#   1. Acquire a flock so two firings can't overlap (one upgrade run
#      may legitimately take hours).
#   2. Run `check.ts` — exits fast if there's no new SDK version.
#   3. If there is one, call `orchestrate.ts` which does branch +
#      Claude run + PR + CI watch + announce.
#
# Designed to be safe to run from cron on a headless server. No
# interactive prompts, no stdin reads. All logs go to STDOUT/STDERR
# so cron's MAILTO (or your log-shipper) catches them.
#
# ─── Install (on a Linux server) ─────────────────────────────────────
#
#   # one-time setup
#   cd /srv && git clone https://github.com/<owner>/claudius.git
#   cd claudius && bun install
#   mkdir -p .claudius/sdk-updater/logs
#
#   # env file — chmod 600
#   cat > .claudius/sdk-updater/env <<'EOF'
#   # Claude auth — uncomment ONE, or skip all three and use
#   # `claude /login` (the SDK reads ~/.claude/.credentials.json automatically):
#   # ANTHROPIC_API_KEY=sk-ant-...
#   # CLAUDE_CODE_OAUTH_TOKEN=...
#   GH_TOKEN=ghp_...                                # or rely on `gh auth login`
#   CHAT_SERVER_URL=https://chat.your-host.tld
#   CHAT_SERVER_ADMIN_TOKEN=...                     # matches the chat-server's token
#   SDK_UPDATE_ROOM_SLUG=sdk-update
#   # optional tuning:
#   # SDK_UPDATE_MODEL=sonnet
#   # SDK_UPDATE_MAX_TURNS=200
#   # SDK_UPDATE_MAX_WALL_MIN=360
#   # SDK_UPDATE_MAX_MINOR_JUMP=1
#   EOF
#   chmod 600 .claudius/sdk-updater/env
#
#   # crontab line — top of every hour
#   crontab -l > /tmp/cron.cur 2>/dev/null || true
#   echo "0 * * * * /srv/claudius/scripts/sdk-update/run.sh \
#     >> /srv/claudius/.claudius/sdk-updater/logs/cron.log 2>&1" >> /tmp/cron.cur
#   crontab /tmp/cron.cur
#
# ─── Required commands on PATH ───────────────────────────────────────
#   bun, git, gh, flock (util-linux). macOS doesn't ship flock — the
#   target deploy is Linux per the user's "remote server, not my Mac".

set -euo pipefail

# Repo root = parent of this script's directory (matches claudiusd).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT/.claudius/sdk-updater"
LOG_DIR="$STATE_DIR/logs"
LOCK_FILE="$STATE_DIR/run.lock"
ENV_FILE="$STATE_DIR/env"

mkdir -p "$STATE_DIR" "$LOG_DIR"

# Load env file if present. Don't fail when it's missing — operators
# may inject env via systemd unit / cron entry instead.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

log() {
  printf '[sdk-update/run %s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

# ── Concurrency guard ────────────────────────────────────────────────
# flock -n exits 1 immediately if the lock is held. We use a separate
# fd (200) so it lives for the duration of this process — when the
# script exits, the kernel releases the lock for us.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  log "another run is already in progress (lock held on $LOCK_FILE) — skipping"
  exit 0
fi

cd "$ROOT"

# ── Mode dispatch ────────────────────────────────────────────────────
# `run.sh fix-pr <number>` skips the npm version probe entirely: it
# checks out an existing PR's branch and re-runs Claude to fix it.
# Everything above this point (env loading, flock) is shared with the
# cron upgrade path below. Invoked by `make sdk-update-fix-pr PR=<n>`.
if [ "${1:-}" = "fix-pr" ]; then
  FIX_PR_NUM="${2:-}"
  if [ -z "$FIX_PR_NUM" ]; then
    log "fix-pr requires a PR number: run.sh fix-pr <number>"
    exit 2
  fi
  log "fix-pr mode for PR #$FIX_PR_NUM"
  ORCH_ARGS=(--fix-pr="$FIX_PR_NUM")
  if [ -n "${SDK_UPDATE_SKIP_GATES:-}" ]; then
    log "skipping gates: ${SDK_UPDATE_SKIP_GATES}"
    ORCH_ARGS+=("--skip-gates=${SDK_UPDATE_SKIP_GATES}")
  fi
  exec bun run scripts/sdk-update/orchestrate.ts "${ORCH_ARGS[@]}"
fi

# ── Check ────────────────────────────────────────────────────────────
# We hold the exclusive flock from here on (see the concurrency guard
# above). A live orchestrate would still be holding that lock — so the
# fact that we acquired it proves none is running. That means any
# `inFlight` marker check.ts finds in state.json is necessarily STALE,
# left behind by a run that was killed before its `finally` could clear
# it (Ctrl-C on an interactive `make sdk-update-run`, OOM, reboot).
# Tell check.ts to reclaim it immediately instead of bricking every
# firing for the 24h self-heal window.
export SDK_UPDATE_LOCK_HELD=1

log "checking for SDK updates"

# check.ts prints a single JSON line on stdout. Capture it for parsing.
# Use bun directly — we don't need package.json scripts for this.
CHECK_JSON="$(bun run scripts/sdk-update/check.ts 2>>"$LOG_DIR/check.stderr.log" || true)"

if [ -z "$CHECK_JSON" ]; then
  log "check.ts returned no output (see check.stderr.log) — aborting this firing"
  exit 1
fi

# Parse the check.ts envelope with bun (already a hard prereq, so no
# new dependency). One invocation extracts every field we care about
# and emits `name=value` lines — robust across macOS BSD tools and
# Linux GNU tools, and avoids the regex pain of multi-shell support.
EVAL_LINES="$(printf '%s' "$CHECK_JSON" | bun -e '
  const j = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  for (const k of ["kind", "installed", "latest", "previousVersion", "newVersion"]) {
    const v = j[k];
    if (v != null) process.stdout.write(`${k.toUpperCase()}=${v}\n`);
  }
')"
# shellcheck disable=SC2046
# Each line is a single shell-safe assignment (no spaces, no shell
# metachars in our value space — version strings + the enum kind).
# Eval rather than source so we don't need to spawn a subshell.
eval "$EVAL_LINES"

DECISION_KIND="${KIND:-}"

log "decision=$DECISION_KIND installed=$INSTALLED latest=$LATEST"

case "$DECISION_KIND" in
  noop|skip|in-flight)
    # `skip` and `in-flight` are already logged to state by check.ts.
    # Nothing more for this firing to do.
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
# PREVIOUSVERSION / NEWVERSION came out of the bun-eval block above.
PREV="${PREVIOUSVERSION:-}"
NEW="${NEWVERSION:-}"
if [ -z "$NEW" ]; then
  log "newVersion missing from check.ts payload — aborting"
  exit 1
fi

log "kicking off orchestrate for $PREV -> $NEW"

# Build the orchestrate.ts argv from env. Operators set:
#   SDK_UPDATE_DRY_RUN=1            — local-only run (no push/PR/announce)
#   SDK_UPDATE_SKIP_GATES=lint,e2e  — skip selected gate steps
# Both reachable via make targets (`make sdk-update-dry-run`,
# `SKIP=e2e make sdk-update-dry-run`).
ORCH_ARGS=(--previous="$PREV" --version="$NEW")
if [ "${SDK_UPDATE_DRY_RUN:-0}" = "1" ]; then
  log "DRY-RUN mode (SDK_UPDATE_DRY_RUN=1) — will not push/PR/announce"
  ORCH_ARGS+=(--dry-run)
fi
if [ -n "${SDK_UPDATE_SKIP_GATES:-}" ]; then
  log "skipping gates: ${SDK_UPDATE_SKIP_GATES}"
  ORCH_ARGS+=("--skip-gates=${SDK_UPDATE_SKIP_GATES}")
fi
exec bun run scripts/sdk-update/orchestrate.ts "${ORCH_ARGS[@]}"
