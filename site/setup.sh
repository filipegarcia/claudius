#!/usr/bin/env bash
# claudius — install script
# https://claudius.network/setup.sh
#
# Supported: macOS and Linux. Windows users: run this inside WSL.
#
# Usage:
#   curl -fsSL https://claudius.network/setup.sh | bash
#   curl -fsSL https://claudius.network/setup.sh | bash -s -- --prefix=$HOME/code/claudius
#
# Options (pass after `--`):
#   --prefix=DIR     Install destination (default: $HOME/claudius)
#   --branch=BRANCH  Git branch to clone (default: main)
#   --repo=URL       Source repo (overrides $CLAUDIUS_REPO)
#   --bin-dir=DIR    Where to drop the `claudius` launcher (default: $HOME/.local/bin)
#   --no-install     Skip `bun install` (clone only)
#   --start          Launch the dev server right after install. Default is a
#                    clean handoff instead: we print where claudius lives and
#                    the one command to start it, so the install summary isn't
#                    buried under dev-server logs.
#   --no-start       (kept for backward-compat; not starting is now the default)
#   -h, --help       Print this and exit
#
# Environment overrides:
#   CLAUDIUS_REPO    Git URL to clone     (default: GitHub upstream)
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
DEFAULT_REPO="https://github.com/filipegarcia/claudius.git"
REPO="${CLAUDIUS_REPO:-$DEFAULT_REPO}"
PREFIX="${CLAUDIUS_PREFIX:-$HOME/claudius}"
BRANCH="${CLAUDIUS_BRANCH:-main}"
BIN_DIR="${CLAUDIUS_BIN_DIR:-$HOME/.local/bin}"
RUN_INSTALL=1
# Default to a clean handoff (don't auto-start). Auto-starting dropped the user
# into a noisy foreground dev server that buried the "installed at / how to
# launch" summary; opt into it explicitly with --start.
START_DEV=0
BUN_JUST_INSTALLED=0

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
    --start)      START_DEV=1 ;;
    --no-start)   START_DEV=0 ;;  # backward-compat; not starting is now the default
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
    printf '    curl -fsSL https://claudius.network/setup.sh | bash\n\n' >&2
    printf '  %sWant native Windows support? +1 on the tracker:%s\n' "$C_DIM" "$C_RST" >&2
    printf '  %shttps://github.com/filipegarcia/claudius/issues%s\n\n' "$C_DIM" "$C_RST" >&2
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
  BUN_JUST_INSTALLED=1
  ok "bun $(bun --version) (just installed)"
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
#
# Boots the dev server quietly: the noisy Next/Turbopack output goes to a log
# file (\$CLAUDIUS_LOG), and the terminal only shows a short banner, a single
# "ready" line once the port binds, and — crucially — a clear notice when the
# server stops (crash or Ctrl-C) telling you how to relaunch.
#
# Env overrides: CLAUDIUS_HOME (install dir), PORT, CLAUDIUS_LOG (log path),
# CLAUDIUS_NO_OPEN=1 (don't auto-open the browser).
set -uo pipefail

CLAUDIUS_HOME="\${CLAUDIUS_HOME:-$PREFIX}"
PORT="\${PORT:-3000}"
URL="http://localhost:\${PORT}"
CLAUDIUS_LOG="\${CLAUDIUS_LOG:-\${TMPDIR:-/tmp}/claudius-dev.log}"

# ANSI helpers (degrade when stdout isn't a tty).
if [ -t 1 ]; then
  D="\$(printf '\033[2m')"; R="\$(printf '\033[0m')"
  A="\$(printf '\033[38;5;209m')"; G="\$(printf '\033[32m')"; E="\$(printf '\033[31m')"
else
  D=""; R=""; A=""; G=""; E=""
fi

if [ ! -d "\$CLAUDIUS_HOME" ]; then
  printf 'claudius: install not found at %s\n' "\$CLAUDIUS_HOME" >&2
  printf '         re-run: curl -fsSL https://claudius.network/setup.sh | bash\n' >&2
  exit 1
fi

# Locate bun. Order: PATH, then the standard installer path, then BUN_INSTALL.
# This lets \`claudius\` work in shells whose rc never picked up bun's PATH line.
if ! command -v bun >/dev/null 2>&1; then
  for candidate in "\${BUN_INSTALL:-\$HOME/.bun}/bin" "\$HOME/.bun/bin"; do
    if [ -x "\$candidate/bun" ]; then
      export PATH="\$candidate:\$PATH"
      break
    fi
  done
fi
if ! command -v bun >/dev/null 2>&1; then
  printf 'claudius: bun not on PATH and not at ~/.bun/bin/bun\n' >&2
  printf '         install it: curl -fsSL https://bun.sh/install | bash\n' >&2
  exit 1
fi

# Pick a browser opener for the host OS. Silent on headless boxes.
__claudius_open() {
  if [ "\${CLAUDIUS_NO_OPEN:-0}" = "1" ]; then return 0; fi
  if command -v open >/dev/null 2>&1; then open "\$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "\$1" >/dev/null 2>&1 || true
  fi
}

# Stopped-notice. We deliberately DON'T \`exec\` the dev server — running it as a
# child means this EXIT trap fires when it dies (crash) or you stop it (Ctrl-C),
# so you're never left wondering whether claudius is still up. (Closing the
# terminal sends SIGHUP and leaves no tty to print to — that case is inherently
# uncatchable, and not what this guards.)
__claudius_stopped() {
  code=\$?
  printf '\n%s■ claudius stopped%s %s(exit %s)%s\n' "\$E" "\$R" "\$D" "\$code" "\$R"
  printf '  relaunch:     %sclaudius%s\n' "\$A" "\$R"
  printf '  installed at: %s\n' "\$CLAUDIUS_HOME"
  printf '  full logs:    %s\n' "\$CLAUDIUS_LOG"
}
trap __claudius_stopped EXIT

# Background: poll the port, then print one clean "ready" line + open browser.
(
  for _ in \$(seq 1 120); do
    if (echo >/dev/tcp/127.0.0.1/\$PORT) >/dev/null 2>&1; then
      printf '%s✓ claudius is ready%s — %s%s%s\n' "\$G" "\$R" "\$A" "\$URL" "\$R"
      __claudius_open "\$URL"
      exit 0
    fi
    sleep 0.5
  done
) &

printf '\n%s𐌂 claudius%s  %s%s%s\n' "\$A" "\$R" "\$D" "\$URL" "\$R"
printf '%sstarting dev server (logs → %s)%s\n' "\$D" "\$CLAUDIUS_LOG" "\$R"
printf '%spress Ctrl-C to stop%s\n\n' "\$D" "\$R"

cd "\$CLAUDIUS_HOME"
# Run as a child (not \`exec\`) with output to the log so the terminal stays
# quiet and the EXIT trap above can fire. The script exits with the dev
# server's code, so the trap reports it.
bun run dev >"\$CLAUDIUS_LOG" 2>&1
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
# Clean handoff. The whole point: after the install scrolls by, the LAST thing
# on screen is where claudius lives and the single command to start it — not a
# wall of dev-server output. Keep this block short and unmissable.
printf '\n'
ok "claudius installed"
printf '\n'
printf '  %slocation%s   %s\n' "$C_DIM" "$C_RST" "$PREFIX"
printf '  %sstart it%s   open a new terminal and run: %sclaudius%s\n' \
  "$C_DIM" "$C_RST" "$C_ACCENT" "$C_RST"
printf '  %sopens at%s   http://localhost:3000\n' "$C_DIM" "$C_RST"
printf '\n%sclaudius runs a dev server in the foreground — it prints a ready line,%s\n' "$C_DIM" "$C_RST"
printf '%sthen tells you if it ever stops. Ctrl-C to quit it.%s\n' "$C_DIM" "$C_RST"

# If we just installed bun, this shell still doesn't know about it — the
# installer edited an rc file, but a child process can't mutate the parent's
# PATH, so `bun` won't be callable in this terminal until they reload.
# The `claudius` launcher handles this itself; this note is only for users
# who want to invoke `bun` directly.
if [ "$BUN_JUST_INSTALLED" -eq 1 ]; then
  printf '\n%sTo use %sbun%s directly in %sthis%s shell:%s\n' \
    "$C_DIM" "$C_ACCENT" "$C_DIM" "$C_ACCENT" "$C_DIM" "$C_RST"
  printf '       %sexport PATH="$HOME/.bun/bin:$PATH"%s\n' "$C_ACCENT" "$C_RST"
  printf '       %s(new terminals will pick it up automatically.)%s\n' \
    "$C_DIM" "$C_RST"
fi

if [ "$START_DEV" -eq 1 ]; then
  printf '\n%sStarting claudius...%s\n\n' "$C_DIM" "$C_RST"
  exec "$LAUNCHER"
fi
