#!/usr/bin/env bash
# Live smoke: the Rust backend driving the REAL `claude` CLI (needs a working
# Claude login; costs a few cents on haiku). Not for CI.
#
#   rust/scripts/live-smoke.sh              # API smoke + React UI smoke
#   rust/scripts/live-smoke.sh --api-only   # HTTP/SSE only, no Next, no browser
#   rust/scripts/live-smoke.sh --keep       # keep the temp world for inspection
#
# What it does:
#   1. builds `claudius`, creates a throwaway world under /tmp: a project dir
#      and an isolated Claudius state home (CLAUDIUS_STATE_HOME) holding one
#      workspace (default permission mode, haiku). The CLI keeps the real HOME
#      and login.
#   2. starts the Rust front door (and, unless --api-only, `next dev` on the
#      gitignored `.next-e2e` dist dir for the UI), with a sanitized env:
#      packaged-app vars, account-pinning vars and nested-Claude-Code vars are
#      dropped so neither server inherits the desktop app's environment.
#   3. live/api.mjs: create → stream → PONG turn → permission round trip.
#      live/pong.mjs + live/permission.mjs: the same through the React UI.
#   4. always cleans up: stops the servers, deletes this run's session JSONL
#      dir from the CLI's real projects dir, removes the temp world.
#
# Env overrides: LIVE_RUST_PORT (3190), LIVE_NEXT_PORT (3191), LIVE_MODEL (haiku).
set -euo pipefail

api_only=0
keep=0
for arg in "$@"; do
  case "$arg" in
    --api-only) api_only=1 ;;
    --keep) keep=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
rust_port="${LIVE_RUST_PORT:-3190}"
next_port="${LIVE_NEXT_PORT:-3191}"
model="${LIVE_MODEL:-haiku}"

# ── environment hygiene ──────────────────────────────────────────────────────
unset_vars=(
  # packaged desktop app: makes `next dev` die with 'Invalid distDirRoot'
  __NEXT_PRIVATE_STANDALONE_CONFIG __NEXT_PRIVATE_ORIGIN NODE_ENV CLAUDIUS_PACKAGED CLAUDIUS_ELECTRON
  # desktop account pinning
  CLAUDE_CODE_ACCOUNT_UUID CLAUDE_CODE_USER_EMAIL CLAUDE_CODE_ORGANIZATION_UUID
  # running nested inside a Claude Code session
  CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_MESSAGING_SOCKET
  CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_EXECPATH
  CLAUDE_AGENT_SDK_VERSION CLAUDE_CODE_ENTRYPOINT
)
# Inside Claude Code / the Claudius desktop app, CLAUDE_CONFIG_DIR points at a
# managed per-account profile; drop it so the CLI uses the default login. In a
# normal terminal a user-set CLAUDE_CONFIG_DIR is respected.
if [[ -n "${CLAUDECODE:-}${CLAUDE_CODE_SESSION_ID:-}${CLAUDIUS_PACKAGED:-}" ]]; then
  unset_vars+=(CLAUDE_CONFIG_DIR)
  config_dir="$HOME/.claude"
else
  config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
fi
env_args=()
for v in "${unset_vars[@]}"; do env_args+=(-u "$v"); done
env_args+=(CLAUDIUS_UPDATER_DISABLED=1)
# Always start processes as a direct `env … cmd` (never via a shell function
# or a non-exec subshell): env execs in place, so `$!` is the real process and
# cleanup can signal it. Backgrounding a function forks a subshell instead,
# and killing that orphans the server underneath it.

for p in "$rust_port" $([[ $api_only == 1 ]] || echo "$next_port"); do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is in use (override with LIVE_RUST_PORT / LIVE_NEXT_PORT)" >&2
    exit 1
  fi
done

# ── temp world ───────────────────────────────────────────────────────────────
world="$(mktemp -d /tmp/claudius-live.XXXXXX)"
world="$(cd "$world" && pwd -P)" # /tmp → /private/tmp on macOS: the CLI records the real path
proj="$world/proj"
state="$world/home"
mkdir -p "$proj" "$state/.claude/.claudius"
echo "# live smoke project" > "$proj/README.md"
ws_id="wks_$(printf '%012x' "$(( $(date +%s) * 1000 + RANDOM ))" | tail -c 12)"
now="$(($(date +%s) * 1000))"
cat > "$state/.claude/.claudius/workspaces.json" <<JSON
{
  "version": 1,
  "activeId": "$ws_id",
  "workspaces": [
    {
      "id": "$ws_id",
      "name": "live-smoke",
      "rootPath": "$proj",
      "icon": { "kind": "letter", "letter": "L", "color": "#d97757" },
      "createdAt": $now,
      "updatedAt": $now,
      "lastOpenedAt": $now,
      "defaults": { "permissionMode": "default", "model": "$model" }
    }
  ]
}
JSON
# The CLI's project-dir encoding: every non-alphanumeric char becomes '-'.
encoded="$(printf '%s' "$proj" | sed 's/[^a-zA-Z0-9]/-/g')"

rust_pid=""
next_pid=""
cleanup() {
  local status=$?
  # claudius first: on SIGTERM it ends every session and waits for each CLI to
  # exit, so the CLIs' last JSONL writes land BEFORE we delete their dir below.
  if [[ -n "$rust_pid" ]]; then
    kill "$rust_pid" 2>/dev/null || true
    wait "$rust_pid" 2>/dev/null || true
  fi
  if [[ -n "$next_pid" ]]; then
    pkill -P "$next_pid" 2>/dev/null || true # next dev's next-server child
    kill "$next_pid" 2>/dev/null || true
    wait "$next_pid" 2>/dev/null || true
  fi
  # Guarded: only ever delete this run's own encoded temp project dir.
  if [[ "$encoded" == *claudius-live-* && -d "$config_dir/projects/$encoded" ]]; then
    rm -rf "${config_dir:?}/projects/$encoded"
    echo "cleaned up $config_dir/projects/$encoded"
  fi
  if [[ $keep == 1 ]]; then
    echo "kept temp world: $world"
  else
    rm -rf "$world"
  fi
  if [[ $status == 0 ]]; then echo "LIVE SMOKE PASSED"; else echo "LIVE SMOKE FAILED (exit $status) — logs: $world (rerun with --keep)" >&2; fi
}
trap cleanup EXIT

wait_for() { # url, seconds, label, pid
  local url="$1" secs="$2" label="$3" pid="$4"
  for _ in $(seq 1 "$secs"); do
    curl -fs -o /dev/null --max-time 5 "$url" && return 0
    kill -0 "$pid" 2>/dev/null || { echo "$label exited during startup" >&2; return 1; }
    sleep 1
  done
  echo "$label not ready after ${secs}s" >&2
  return 1
}

# ── servers ──────────────────────────────────────────────────────────────────
echo "building claudius…"
cargo build -q --manifest-path "$repo/rust/Cargo.toml" -p claudius-server

next_flag=(--no-next)
if [[ $api_only == 0 ]]; then
  echo "starting next dev on :$next_port (.next-e2e)…"
  # exec: $! must be `next dev` itself (not a subshell) so cleanup's `pkill -P`
  # reaches its next-server child.
  (cd "$repo" && exec env "${env_args[@]}" HOME="$state" CLAUDE_CONFIG_DIR="$config_dir" \
    NEXT_DIST_DIR=.next-e2e NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next dev -p "$next_port" > "$world/next.log" 2>&1) &
  next_pid=$!
  wait_for "http://127.0.0.1:$next_port/api/workspaces" 180 "next dev" "$next_pid"
  next_flag=(--next "http://127.0.0.1:$next_port")
fi

echo "starting claudius on :$rust_port…"
env "${env_args[@]}" CLAUDIUS_STATE_HOME="$state" "$repo/rust/target/debug/claudius" \
  --port "$rust_port" "${next_flag[@]}" > "$world/rust.log" 2>&1 &
rust_pid=$!
wait_for "http://127.0.0.1:$rust_port/api/rust/health" 60 "claudius" "$rust_pid"

# ── checks ───────────────────────────────────────────────────────────────────
base="http://127.0.0.1:$rust_port"
echo "API smoke ($model, $proj):"
env "${env_args[@]}" node "$here/live/api.mjs" "$base" "$proj"
if [[ $api_only == 0 ]]; then
  echo "UI smoke — prompt + reload:"
  env "${env_args[@]}" node "$here/live/pong.mjs" "http://localhost:$rust_port" "$world"
  echo "UI smoke — permission card:"
  env "${env_args[@]}" node "$here/live/permission.mjs" "http://localhost:$rust_port" "$world" "$proj"
fi
