#!/usr/bin/env bash
# In-container assertions for site/setup.sh. Invoked by test-docker.sh
# inside the test image with /src bind-mounted to the host repo.
#
# Tests:
#   1. bash:  fresh install writes launcher, ~/.bashrc appended
#   2. bash:  re-run is idempotent (no double-append)
#   3. zsh:   ~/.zshrc gets the line, not bashrc
#   4. fish:  ~/.config/fish/config.fish uses `fish_add_path`
#   5. error: pre-existing non-git $PREFIX is rejected

set -euo pipefail

# Source repo: defaults to /src (our Docker rig bind-mounts here). GitLab CI
# can set TEST_SRC=$CI_PROJECT_DIR instead, since CI checks out somewhere
# under /builds. Either path needs site/setup.sh inside it.
SRC="${TEST_SRC:-/src}"
if [ ! -f "$SRC/site/setup.sh" ]; then
  printf 'test-in-docker: %s/site/setup.sh not found (set TEST_SRC?)\n' "$SRC" >&2
  exit 1
fi

BRANCH="${TEST_BRANCH:-main}"
SETUP="$SRC/site/setup.sh"

# Provision a stub `bun` so ensure_bun() short-circuits without networking.
# Self-contained: works whether or not the Dockerfile pre-staged one.
STUBBIN="$(mktemp -d -t claudius-stubbin.XXXXXX)"
cat > "$STUBBIN/bun" <<'BUN'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "0.0.0-test" ;;
  install)   exit 0 ;;
  *)         echo "stub bun: $*" ;;
esac
BUN
chmod +x "$STUBBIN/bun"
trap 'rm -rf "$STUBBIN"' EXIT

assert() {
  local what="$1"; shift
  if "$@"; then
    printf '  ✓ %s\n' "$what"
  else
    printf '  ✗ %s\n' "$what" >&2
    return 1
  fi
}

check_rc_line_once() {
  local rc="$1"
  local needle="$2"
  local count
  count="$(grep -cF "$needle" "$rc" 2>/dev/null || true)"
  [ -z "$count" ] && count=0
  if [ "$count" = "1" ]; then
    printf '  ✓ %s contains %s exactly once\n' "$rc" "$needle"
  else
    printf '  ✗ %s contains %s %s time(s) (expected 1)\n' "$rc" "$needle" "$count" >&2
    return 1
  fi
}

run_setup() {
  local label="$1"; shift
  printf '\n── %s ─────────────────────────────────\n' "$label"
  env -i \
    HOME="$FAKE_HOME" \
    SHELL="$TEST_SHELL" \
    PATH="$STUBBIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    TERM=xterm \
    bash "$SETUP" \
      --prefix="$PREFIX" \
      --bin-dir="$BIN_DIR" \
      --repo="$SRC" \
      --branch="$BRANCH" \
      --no-install \
      --no-start \
      "$@"
}

fresh_workdir() {
  WORK="$(mktemp -d)"
  FAKE_HOME="$WORK/home"
  PREFIX="$WORK/install"
  BIN_DIR="$FAKE_HOME/.local/bin"
  mkdir -p "$FAKE_HOME"
}

# ── 1. bash: fresh install ───────────────────────────────────────────────
fresh_workdir
TEST_SHELL=/bin/bash run_setup "bash: fresh install"
assert "launcher exists" test -x "$BIN_DIR/claudius"
assert "launcher bakes in CLAUDIUS_HOME=$PREFIX" \
  grep -qF "CLAUDIUS_HOME:-$PREFIX" "$BIN_DIR/claudius"
check_rc_line_once "$FAKE_HOME/.bashrc" "$BIN_DIR"

# ── 2. bash: re-run is idempotent ────────────────────────────────────────
TEST_SHELL=/bin/bash run_setup "bash: re-run (idempotency)"
check_rc_line_once "$FAKE_HOME/.bashrc" "$BIN_DIR"

# ── 3. zsh: writes to .zshrc only ────────────────────────────────────────
fresh_workdir
TEST_SHELL=/bin/zsh run_setup "zsh: fresh install"
assert "launcher exists" test -x "$BIN_DIR/claudius"
check_rc_line_once "$FAKE_HOME/.zshrc" "$BIN_DIR"
assert "no bashrc written for zsh user" test ! -f "$FAKE_HOME/.bashrc"

# ── 4. fish: uses fish_add_path in config.fish ───────────────────────────
fresh_workdir
TEST_SHELL=/usr/bin/fish run_setup "fish: fresh install"
assert "launcher exists" test -x "$BIN_DIR/claudius"
assert "config.fish written" test -f "$FAKE_HOME/.config/fish/config.fish"
assert "config.fish uses fish_add_path" \
  grep -qF "fish_add_path $BIN_DIR" "$FAKE_HOME/.config/fish/config.fish"

# ── 5. error path: pre-existing non-git prefix is rejected ───────────────
fresh_workdir
mkdir -p "$PREFIX"
echo "not a git repo" > "$PREFIX/marker"
printf '\n── error: non-git prefix is rejected ───────────────────\n'
if TEST_SHELL=/bin/bash run_setup "non-git prefix" 2>/dev/null; then
  printf '  ✗ expected setup to fail against a non-git prefix\n' >&2
  exit 1
else
  printf '  ✓ setup exits non-zero against non-git prefix\n'
fi

printf '\n✓ all docker setup-script tests passed\n'
