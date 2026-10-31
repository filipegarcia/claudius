#!/usr/bin/env bash
# SDK drift detector: the installed @anthropic-ai/claude-agent-sdk vs
# `claudius_agent::SDK_VERSION` and rust/scripts/sdk-snapshot.json. See
# sdk-diff.mjs for what's compared. Exits 1 on any drift.
#
#   rust/scripts/sdk-diff.sh [--update] [--sdk DIR]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# node@22 (brew) first, as in the rest of the repo's tooling.
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
exec node "$here/sdk-diff.mjs" "$@"
