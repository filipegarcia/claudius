#!/usr/bin/env bash
# End-to-end install smoke against the *public* setup.sh URL.
#
# This is a different scope from `test-docker.sh`:
#   - test-docker.sh    → rc-file detection semantics, stubs bun, no network
#   - test-install-public.sh → curls the real setup script off gh-pages,
#                              clones the public repo, runs `bun install`,
#                              boots `bun run dev`, then curls /api/heartbeat
#                              and /api/heartbeatz to confirm the install
#                              actually works.
#
# Run order matters: the branch you're testing must already be pushed to
# GitHub before this is useful — the in-container clone pulls *that* branch
# off the public repo. The setup.sh blob itself is always pulled from the
# gh-pages URL so we exercise the same path real users follow; pass
# SETUP_URL=... to override (e.g. a raw.githubusercontent.com URL for a PR
# preview).
#
# Reuses the cached image from `test-docker.sh`; FORCE_REBUILD=1 to bust it.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  printf 'test-install-public: docker is not on PATH — install Docker first\n' >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/site/test"
IMAGE="claudius-setup-test:latest"
BRANCH="${TEST_BRANCH:-$(git -C "$REPO_ROOT" branch --show-current || echo main)}"
SETUP_URL="${SETUP_URL:-https://claudius.network/setup.sh}"

if [ -z "$BRANCH" ]; then
  printf 'test-install-public: detached HEAD detected, please check out a branch first\n' >&2
  exit 1
fi

printf '── building %s ──────────────────────────────\n' "$IMAGE"
if [ "${FORCE_REBUILD:-0}" = "1" ]; then
  docker build --no-cache -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE" >/dev/null
else
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE" >/dev/null
fi

printf '── running public-install test in container ──\n'
printf '   setup.sh: %s\n' "$SETUP_URL"
printf '   branch:   %s\n' "$BRANCH"
docker run --rm \
  -v "$REPO_ROOT":/src:ro \
  -e TEST_BRANCH="$BRANCH" \
  -e SETUP_URL="$SETUP_URL" \
  "$IMAGE" \
  /src/site/test/test-install-public.inner.sh
