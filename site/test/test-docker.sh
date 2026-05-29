#!/usr/bin/env bash
# Host-side driver for the Linux setup-script test rig.
#
# Builds site/test/Dockerfile and runs site/test/test-in-docker.sh inside
# it with the repo bind-mounted at /src. Reuses the cached image on repeat
# runs; pass FORCE_REBUILD=1 to bust it.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  printf 'test-docker: docker is not on PATH — install Docker or skip with `make test-setup-local`\n' >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/site/test"
IMAGE="claudius-setup-test:latest"
BRANCH="$(git -C "$REPO_ROOT" branch --show-current || echo main)"

if [ -z "$BRANCH" ]; then
  printf 'test-docker: detached HEAD detected, please check out a branch first\n' >&2
  exit 1
fi

printf '── building %s ──────────────────────────────\n' "$IMAGE"
if [ "${FORCE_REBUILD:-0}" = "1" ]; then
  docker build --no-cache -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE" >/dev/null
else
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE" >/dev/null
fi

printf '── running tests in container (branch=%s) ──\n' "$BRANCH"
docker run --rm \
  -v "$REPO_ROOT":/src:ro \
  -e TEST_BRANCH="$BRANCH" \
  "$IMAGE" \
  /src/site/test/test-in-docker.sh
