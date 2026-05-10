#!/usr/bin/env bash
# claudius — install script
# https://filipegarcia.gitlab.io/claudius/setup.sh
#
# Usage:
#   curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash
#   curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash -s -- --prefix=$HOME/code/claudius
#
# Options (pass after `--`):
#   --prefix=DIR     Install destination (default: $HOME/claudius)
#   --branch=BRANCH  Git branch to clone (default: main)
#   --repo=URL       Source repo (overrides $CLAUDIUS_REPO)
#   --no-install     Skip `bun install` (clone only)
#   --start          Run `bun run dev` after install (default: don't)
#   -h, --help       Print this and exit
#
# Environment overrides:
#   CLAUDIUS_REPO    Git URL to clone   (default: GitLab upstream)
#   CLAUDIUS_PREFIX  Install destination (default: $HOME/claudius)
#   CLAUDIUS_BRANCH  Git branch          (default: main)
#
# Re-running the script against an existing install pulls the latest commit
# on `--branch` and re-runs `bun install`. Local edits in the working tree
# block the pull (we never `git reset --hard` for you).
#
# Bun is the package manager. If it's not on PATH we install it for you via
# the official `https://bun.sh/install` curl one-liner — that drops a binary
# into ~/.bun/bin and edits the relevant rc file. Pass --no-install to skip
# the dependency step entirely if you'd rather wire up tooling yourself.
#
# To rebrand: change DEFAULT_REPO below to your fork. The marketed URLs
# in this header are cosmetic — they're just what gets printed by --help.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────
DEFAULT_REPO="https://gitlab.com/filipegarcia/claudius.git"
REPO="${CLAUDIUS_REPO:-$DEFAULT_REPO}"
PREFIX="${CLAUDIUS_PREFIX:-$HOME/claudius}"
BRANCH="${CLAUDIUS_BRANCH:-main}"
RUN_INSTALL=1
START_DEV=0

# ── ANSI helpers (gracefully degrade when stdout isn't a tty) ─────────────
if [ -t 1 ]; then
  C_DIM="$(printf '\033[2m')"
  C_RST="$(printf '\033[0m')"
  C_OK="$(printf '\033[32m')"
  C_ERR="$(printf '\033[31m')"
  C_ACCENT="$(printf '\033[38;5;209m')" # close to the brand orange
else
  C_DIM=""; C_RST=""; C_OK=""; C_ERR=""; C_ACCENT=""
fi

log()  { printf '%s%s%s\n' "$C_DIM" "$1" "$C_RST"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RST" "$1"; }
fail() { printf '%s✗%s %s\n' "$C_ERR" "$C_RST" "$1" >&2; exit 1; }

usage() {
  sed -n '2,/^set -euo/{/^set -euo/d;p;}' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Args ─────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix=*)   PREFIX="${1#--prefix=}" ;;
    --branch=*)   BRANCH="${1#--branch=}" ;;
    --repo=*)     REPO="${1#--repo=}" ;;
    --no-install) RUN_INSTALL=0 ;;
    --start)      START_DEV=1 ;;
    -h|--help)    usage ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
  shift
done

printf '%s𐌂 claudius%s — installing to %s%s%s\n\n' "$C_ACCENT" "$C_RST" "$C_ACCENT" "$PREFIX" "$C_RST"

# ── Prereqs ──────────────────────────────────────────────────────────────
need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing: $1 (please install and re-run)"
}
need git
ok "git $(git --version | awk '{print $3}')"

# Bun: prefer whatever's already on PATH; otherwise grab it via the official
# installer. The installer adds ~/.bun/bin to the user's rc file, but a piped
# bash session won't have re-sourced it — export it inline so the rest of
# this script (and the optional `--start` exec at the end) can find `bun`.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "bun $(bun --version)"
    return
  fi
  log "Bun not found — installing via https://bun.sh/install"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 \
    || fail "bun install failed (try installing manually: https://bun.sh/)"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 \
    || fail "bun installed but not on PATH — open a new shell and re-run"
  ok "bun $(bun --version) (just installed — restart your shell to pick up PATH)"
}
ensure_bun

# ── Fetch ────────────────────────────────────────────────────────────────
if [ -d "$PREFIX/.git" ]; then
  log "Updating existing checkout at $PREFIX"
  # Refuse to clobber local edits — print them and bail with guidance.
  if ! git -C "$PREFIX" diff --quiet || ! git -C "$PREFIX" diff --cached --quiet; then
    printf '%suncommitted changes in %s — commit or stash, then re-run%s\n' \
      "$C_ERR" "$PREFIX" "$C_RST" >&2
    git -C "$PREFIX" status --short >&2
    exit 1
  fi
  git -C "$PREFIX" fetch --quiet origin "$BRANCH"
  git -C "$PREFIX" checkout --quiet "$BRANCH"
  git -C "$PREFIX" pull --quiet --ff-only origin "$BRANCH"
  ok "updated to $(git -C "$PREFIX" rev-parse --short HEAD)"
elif [ -e "$PREFIX" ]; then
  fail "$PREFIX exists and isn't a git checkout. Move it aside or pass --prefix"
else
  mkdir -p "$(dirname "$PREFIX")"
  log "Cloning $REPO ($BRANCH) into $PREFIX"
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$PREFIX"
  ok "cloned $(git -C "$PREFIX" rev-parse --short HEAD)"
fi

# ── Install dependencies ─────────────────────────────────────────────────
if [ "$RUN_INSTALL" -eq 1 ]; then
  log "Running bun install (this can take a few seconds on first run)"
  ( cd "$PREFIX" && bun install --frozen-lockfile ) || fail "bun install failed"
  ok "dependencies installed"
fi

# ── Done ─────────────────────────────────────────────────────────────────
printf '\n'
ok "claudius is ready at %s" "$PREFIX"
printf '\n%sNext:%s\n  cd %s\n  bun run dev    # http://localhost:3000\n  bun run build && bun start\n' \
  "$C_ACCENT" "$C_RST" "$PREFIX"

if [ "$START_DEV" -eq 1 ]; then
  printf '\n%sStarting dev server%s\n' "$C_DIM" "$C_RST"
  exec env -C "$PREFIX" bun run dev
fi
