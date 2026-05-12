#!/usr/bin/env bash
# claudius — install script
# https://filipegarcia.gitlab.io/claudius/setup.sh
#
# Supported: macOS and Linux. Windows users: run this inside WSL.
#
# Usage:
#   curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash
#   curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash -s -- --prefix=$HOME/code/claudius
#
# Options (pass after `--`):
#   --prefix=DIR     Install destination (default: $HOME/claudius)
#   --branch=BRANCH  Git branch to clone (default: main)
#   --repo=URL       Source repo (overrides $CLAUDIUS_REPO)
#   --bin-dir=DIR    Where to drop the `claudius` launcher (default: $HOME/.local/bin)
#   --no-install     Skip `bun install` (clone only)
#   --no-start       Don't launch the dev server after install (default: do)
#   --start          (kept for backward-compat; starting is now the default)
#   -h, --help       Print this and exit
#
# Environment overrides:
#   CLAUDIUS_REPO    Git URL to clone     (default: GitLab upstream)
#   CLAUDIUS_PREFIX  Install destination  (default: $HOME/claudius)
#   CLAUDIUS_BRANCH  Git branch           (default: main)
#   CLAUDIUS_BIN_DIR Launcher destination (default: $HOME/.local/bin)
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
# After install we also drop a `claudius` launcher into --bin-dir so you can
# just type `claudius` from any shell to start the dev server and open the UI
# in your browser. If the bin dir isn't on PATH, we append it to your rc.
#
# To rebrand: change DEFAULT_REPO below to your fork. The marketed URLs
# in this header are cosmetic — they're just what gets printed by --help.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────
DEFAULT_REPO="https://gitlab.com/filipegarcia/claudius.git"
REPO="${CLAUDIUS_REPO:-$DEFAULT_REPO}"
PREFIX="${CLAUDIUS_PREFIX:-$HOME/claudius}"
BRANCH="${CLAUDIUS_BRANCH:-main}"
BIN_DIR="${CLAUDIUS_BIN_DIR:-$HOME/.local/bin}"
RUN_INSTALL=1
START_DEV=1

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
    --bin-dir=*)  BIN_DIR="${1#--bin-dir=}" ;;
    --no-install) RUN_INSTALL=0 ;;
    --no-start)   START_DEV=0 ;;
    --start)      START_DEV=1 ;;  # backward-compat; starting is now the default
    -h|--help)    usage ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ── Platform check ───────────────────────────────────────────────────────
# We support macOS and Linux. If someone pipes us through Git Bash, MSYS, or
# Cygwin on native Windows the Unix Bun installer won't work — bail early
# with a friendly pointer to WSL instead of dying halfway through.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    printf '\n%s✗ native Windows isn'\''t supported yet.%s\n\n' "$C_ERR" "$C_RST" >&2
    printf '  Claudius needs a POSIX shell and the Unix Bun installer,\n' >&2
    printf '  so Git Bash / MSYS / Cygwin won'\''t get you all the way there.\n\n' >&2
    printf '  %sEasiest path on Windows is WSL:%s\n\n' "$C_ACCENT" "$C_RST" >&2
    printf '    wsl --install -d Ubuntu\n' >&2
    printf '    # then, inside your WSL shell:\n' >&2
    printf '    curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash\n\n' >&2
    printf '  %sWant native Windows support? +1 on the tracker:%s\n' "$C_DIM" "$C_RST" >&2
    printf '  %shttps://gitlab.com/filipegarcia/claudius/-/issues%s\n\n' "$C_DIM" "$C_RST" >&2
    exit 1
    ;;
esac

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

# ── Install the `claudius` launcher ──────────────────────────────────────
# A tiny wrapper that boots the dev server from $PREFIX and opens the UI in
# the user's default browser once the port is bound. Re-running setup
# overwrites it, so the baked-in install path stays in sync.
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/claudius"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# claudius launcher — generated by setup.sh. Re-run setup to refresh.
# Override the install dir with CLAUDIUS_HOME, the port with PORT, and
# disable the auto-open with CLAUDIUS_NO_OPEN=1.
set -euo pipefail

CLAUDIUS_HOME="\${CLAUDIUS_HOME:-$PREFIX}"
PORT="\${PORT:-3000}"
URL="http://localhost:\${PORT}"

if [ ! -d "\$CLAUDIUS_HOME" ]; then
  printf 'claudius: install not found at %s\n' "\$CLAUDIUS_HOME" >&2
  printf '         re-run: curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash\n' >&2
  exit 1
fi

# Pick a browser opener for the host OS. Silent on headless boxes.
__claudius_open() {
  if [ "\${CLAUDIUS_NO_OPEN:-0}" = "1" ]; then return 0; fi
  if command -v open >/dev/null 2>&1; then open "\$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "\$1" >/dev/null 2>&1 || true
  fi
}

# Background: poll the port for up to 30s, then open the browser once.
(
  for _ in \$(seq 1 60); do
    if (echo >/dev/tcp/127.0.0.1/\$PORT) >/dev/null 2>&1; then
      __claudius_open "\$URL"
      exit 0
    fi
    sleep 0.5
  done
) &

cd "\$CLAUDIUS_HOME"
exec bun run dev
EOF
chmod +x "$LAUNCHER"
ok "launcher installed at $LAUNCHER"

# ── Make sure $BIN_DIR is on PATH ────────────────────────────────────────
# If it isn't, append the appropriate line to the user's login-shell rc.
# We also export PATH inline so `exec claudius` below works in this session.
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    SHELL_NAME="$(basename "${SHELL:-bash}")"
    case "$SHELL_NAME" in
      zsh)  RC="$HOME/.zshrc"; LINE="export PATH=\"$BIN_DIR:\$PATH\"  # added by claudius/setup.sh" ;;
      fish) RC="$HOME/.config/fish/config.fish"; LINE="fish_add_path $BIN_DIR  # added by claudius/setup.sh" ;;
      *)    RC="$HOME/.bashrc"; LINE="export PATH=\"$BIN_DIR:\$PATH\"  # added by claudius/setup.sh" ;;
    esac
    mkdir -p "$(dirname "$RC")"
    if [ ! -f "$RC" ] || ! grep -qF "$BIN_DIR" "$RC" 2>/dev/null; then
      printf '\n%s\n' "$LINE" >> "$RC"
      log "added $BIN_DIR to PATH via $RC (open a new shell to pick it up)"
    fi
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

# ── Done ─────────────────────────────────────────────────────────────────
printf '\n'
ok "claudius is ready at $PREFIX"
printf '\n%sNext:%s just type %sclaudius%s in any shell.\n' \
  "$C_ACCENT" "$C_RST" "$C_ACCENT" "$C_RST"
printf '       (it'\''ll run %sbun run dev%s and open http://localhost:3000.)\n' \
  "$C_DIM" "$C_RST"

if [ "$START_DEV" -eq 1 ]; then
  printf '\n%sStarting claudius...%s\n\n' "$C_DIM" "$C_RST"
  exec "$LAUNCHER"
fi
