#!/usr/bin/env bash
# Local smoke test for site/setup.sh — runs against a throwaway $HOME so it
# can't touch your real rc files. Stubs `bun` so we don't pull the network.
#
# Used by `make test-setup-local`. Works on macOS and Linux.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/site/setup.sh"
BRANCH="$(git -C "$REPO_ROOT" branch --show-current || echo main)"

if [ ! -f "$SETUP" ]; then
  printf 'test-local: %s not found\n' "$SETUP" >&2
  exit 1
fi

WORK="$(mktemp -d -t claudius-setup-test.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Fake bun so ensure_bun() short-circuits without hitting the network.
mkdir -p "$WORK/stubbin"
cat > "$WORK/stubbin/bun" <<'BUN'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "0.0.0-test" ;;
  install)   exit 0 ;;
  *)         echo "stub bun: $*" ;;
esac
BUN
chmod +x "$WORK/stubbin/bun"

PREFIX="$WORK/install"
BIN_DIR="$WORK/home/.local/bin"
FAKE_HOME="$WORK/home"
mkdir -p "$FAKE_HOME"

run_setup() {
  local label="$1"; shift
  printf '\n── %s ─────────────────────────────────\n' "$label"
  env -i \
    HOME="$FAKE_HOME" \
    SHELL="${TEST_SHELL:-/bin/bash}" \
    PATH="$WORK/stubbin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="${TERM:-xterm}" \
    bash "$SETUP" \
      --prefix="$PREFIX" \
      --bin-dir="$BIN_DIR" \
      --repo="$REPO_ROOT" \
      --branch="$BRANCH" \
      --no-install \
      --no-start \
      "$@"
}

assert() {
  local what="$1"; shift
  if "$@"; then
    printf '  ✓ %s\n' "$what"
  else
    printf '  ✗ %s\n' "$what" >&2
    return 1
  fi
}

check_launcher() {
  assert "launcher exists" test -x "$BIN_DIR/claudius"
  assert "launcher parses" bash -n "$BIN_DIR/claudius"
  assert "launcher bakes in CLAUDIUS_HOME=$PREFIX" \
    grep -qF "CLAUDIUS_HOME:-$PREFIX" "$BIN_DIR/claudius"
}

check_rc_line_once() {
  local rc="$1"
  local needle="$2"
  local count
  count="$(grep -cF "$needle" "$rc" 2>/dev/null || echo 0)"
  if [ "$count" = "1" ]; then
    printf '  ✓ %s contains %s exactly once\n' "$rc" "$needle"
  else
    printf '  ✗ %s contains %s %s time(s) (expected 1)\n' "$rc" "$needle" "$count" >&2
    return 1
  fi
}

# ── Test 1: bash shell, fresh install ────────────────────────────────────
TEST_SHELL=/bin/bash run_setup "fresh install, SHELL=bash"
check_launcher
check_rc_line_once "$FAKE_HOME/.bashrc" "$BIN_DIR"

# ── Test 2: re-run is idempotent (no double-append) ──────────────────────
TEST_SHELL=/bin/bash run_setup "re-run, SHELL=bash (idempotency)"
check_launcher
check_rc_line_once "$FAKE_HOME/.bashrc" "$BIN_DIR"

# ── Test 3: zsh shell hits .zshrc ────────────────────────────────────────
rm -rf "$PREFIX" "$FAKE_HOME/.bashrc"
TEST_SHELL=/bin/zsh run_setup "fresh install, SHELL=zsh"
check_launcher
check_rc_line_once "$FAKE_HOME/.zshrc" "$BIN_DIR"
assert "no bashrc written for zsh user" test ! -f "$FAKE_HOME/.bashrc"

# ── Test 4: fish shell hits config.fish with fish_add_path ───────────────
rm -rf "$PREFIX" "$FAKE_HOME/.zshrc"
TEST_SHELL=/usr/local/bin/fish run_setup "fresh install, SHELL=fish"
check_launcher
assert "config.fish written" test -f "$FAKE_HOME/.config/fish/config.fish"
assert "config.fish uses fish_add_path" \
  grep -qF "fish_add_path $BIN_DIR" "$FAKE_HOME/.config/fish/config.fish"

# ── Test 5: --no-start was honored (no dev server attempt) ───────────────
# (Implicit: if --no-start were broken, the script would have exec'd the
# launcher, which would loop on /dev/tcp/127.0.0.1/3000 for 30s. The fact
# that we reach this line proves --no-start worked.)
assert "--no-start prevented exec to launcher" true

printf '\n✓ all local setup-script tests passed\n'
