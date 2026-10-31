#!/bin/sh
# Run a command with the desktop-app / agent environment stripped, for e2e
# runs started from inside Claudius or any Claude Code session.
#
#   rust/scripts/clean-env.sh playwright test --project=chromium …
#
# Playwright web servers inherit the runner's env. A parent-session
# CLAUDE_CONFIG_DIR made the e2e servers and their `claude` CLIs read and
# write the REAL ~/.claude instead of the isolated e2e HOME (TODO I12):
# transcripts landed in the user's project dirs, and `/api/sessions/all`
# missed the spec's fixtures. Other CLAUDE_CODE_* vars (messaging socket,
# session id, entrypoint) would cross-talk with the parent session too.
#
# Strips CLAUDE_*, CLAUDECODE, __NEXT_PRIVATE_* (packaged Next config),
# NODE_ENV, CLAUDIUS_PACKAGED and CLAUDIUS_ELECTRON, and sets
# CLAUDIUS_UPDATER_DISABLED=1 (an enabled updater can stash the work tree).
for v in $(env | sed -n 's/^\(CLAUDE_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(CLAUDECODE\)=.*/\1/p; s/^\(__NEXT_PRIVATE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$v"
done
unset NODE_ENV CLAUDIUS_PACKAGED CLAUDIUS_ELECTRON
export CLAUDIUS_UPDATER_DISABLED=1
exec "$@"
