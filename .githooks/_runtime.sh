# Shared runtime detection for git hooks. POSIX sh-compatible; meant to be
# `.`-sourced by `.githooks/pre-commit` and `.githooks/pre-push`.
#
# The problem this solves: git GUIs (Claudius's own panel, Tower, Fork, the
# Electron-app commit dialog, GitHub Desktop) launch hooks with a bare PATH
# that doesn't include `~/.bun/bin` or `/opt/homebrew/bin`. With `command -v
# bun` returning false, the hook falls through to `npm`/`npx` — which many
# developers on this project don't have installed. xargs then dies with
# `npm: No such file or directory`. The terminal works because shells source
# `~/.zprofile`/`~/.bashrc` and inherit a fuller PATH.
#
# Recovery: walk the known bun + node install locations and prepend the
# first hit to PATH. Idempotent and silent on success — only logs when
# nothing is found, so a developer with truly no tooling sees a useful
# error instead of a confusing xargs message.

# Standard install locations for bun + node on macOS / Linux. Earlier entries
# win when the same binary lives in two places (e.g. system + brew).
for _claudius_dir in \
  "$HOME/.bun/bin" \
  /opt/homebrew/bin \
  /usr/local/bin \
  "$HOME/.nvm/versions/node/current/bin" \
  "$HOME/.volta/bin" \
  "$HOME/.fnm/aliases/default/bin"
do
  if [ -d "$_claudius_dir" ]; then
    case ":$PATH:" in
      *":$_claudius_dir:"*) ;;
      *) PATH="$_claudius_dir:$PATH" ;;
    esac
  fi
done
unset _claudius_dir
export PATH

# Choose the runner. Prefer bun (matches the repo's tooling); fall back to
# npm/npx only if bun genuinely isn't installed.
if command -v bun >/dev/null 2>&1; then
  RUN="bun run"
  RUN_DIRECT="bunx"
elif command -v npx >/dev/null 2>&1; then
  RUN="npm run"
  RUN_DIRECT="npx --no-install"
else
  echo "▶ hook: neither bun nor npx is on PATH (searched: \$HOME/.bun/bin," \
    "/opt/homebrew/bin, /usr/local/bin, common Node version managers)." 1>&2
  echo "▶ hook: install bun (https://bun.com) or set CLAUDIUS_SKIP_PREPUSH=1" \
    "to bypass this push only." 1>&2
  exit 1
fi
