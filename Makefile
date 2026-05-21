.PHONY: help install dev build start lint unit test test-ui test-e2e-electron test-setup test-setup-local test-setup-docker test-install-public ci site screenshots screenshots-full claudius-revert claudius-revert-all run up down restart status logs electron electron-dev electron-build electron-dist electron-e2e-loop sdk-update-check sdk-update-run sdk-update-dry-run sdk-update-status sdk-update-logs sdk-update-install-cron sdk-update-uninstall-cron

# List every target, grouped by the section headers below.
help:
	@awk ' \
		/^# ── / { sub(/^# ── */, ""); sub(/ *──+ *$$/, ""); printf "\n\033[1m%s\033[0m\n", $$0; next } \
		/^[a-zA-Z][a-zA-Z0-9_-]*:([^=]|$$)/ { sub(/:.*$$/, ""); printf "  %s\n", $$0 } \
	' $(MAKEFILE_LIST)

install:
	bun install --frozen-lockfile

dev:
	bun run dev

build:
	bun run build

start:
	bun start

lint:
	bun run lint

# Vitest suite (Node-side unit/integration). Runs under node because
# better-sqlite3 doesn't load under bun yet — see vitest.config.ts.
unit:
	bun run test

# `make test` is what CI runs (.github/workflows/ci.yml → e2e job).
# --max-failures=15 short-circuits the suite once 15 *test cases* (NOT
# attempts — retries don't count toward the cap) have failed. On a
# healthy run nothing trips it; on a systemic regression (one root
# cause failing many specs) the suite bails after ~12 min of red
# instead of grinding through 90+ specs × 3 retries × ~30s ≈ 47 min.
# Local debugging still uses `bun run test:e2e` directly to see every
# failure.
test:
	bunx playwright install chromium
	bun run test:e2e --max-failures=15

test-ui:
	bun run test:e2e:ui

# Electron e2e suite — rebuilds better-sqlite3 for Node ABI, compiles
# dist-electron/, then runs the chromium-electron Playwright project.
test-e2e-electron:
	bun run test:e2e:electron

# ── Electron app ───────────────────────────────────────────────────────
# `make electron` is the recommended entry point: it probes
# `http://127.0.0.1:3000/` and either attaches Electron to a running
# `next dev` (fast iteration) or spawns a fresh next + electron pair.
# See scripts/electron-open.mjs for the full decision tree.
electron:
	bun run electron:open

# Always-from-scratch path: rebuilds native for Electron's ABI, compiles
# main, spawns Next, waits, then launches Electron. ~30s slower than
# `make electron` when a dev server is already up. Use when you're
# unsure of the current state.
electron-dev:
	bun run electron:dev

# Packaged build (no installer). Writes the standalone Next bundle + the
# compiled main into `.next/` and `dist-electron/`. electron-builder runs
# next; see `electron-dist` for installer output.
electron-build:
	bun run electron:build

# Full mac installer (DMG + ZIP). For Windows/Linux installers, see the
# `electron:dist:win` / `electron:dist:linux` npm scripts directly.
electron-dist:
	bun run electron:dist:mac

# Print the autonomous Electron e2e Ralph-loop prompt so you can paste
# it into `/ralph-loop:ralph-loop`. The loop reads
# tests/electron/COVERAGE.md, picks the least-covered category, writes
# a Playwright spec, runs it headed against Electron, then commits +
# pushes if it's green. Runs locally only — the chromium-electron
# project is intentionally NOT in `make ci`. See
# docs/electron-conversion/E2E_LOOP_PROMPT.md for the protocol.
electron-e2e-loop:
	@cat docs/electron-conversion/E2E_LOOP_PROMPT.md
	@echo ""
	@echo "▶ copy the prompt block above into Claude Code's"
	@echo "  /ralph-loop:ralph-loop slash command to start the loop."

# ── site/setup.sh tests ────────────────────────────────────────────────
# `test-setup-local` runs the installer against a throwaway $HOME on the
# current host (covers macOS quirks). `test-setup-docker` runs it on a
# clean Ubuntu container with bash/zsh/fish to catch Linux + shell-rc
# regressions. `test-setup` runs both.

test-setup-local:
	@site/test/test-local.sh

test-setup-docker:
	@site/test/test-docker.sh

# End-to-end smoke against the *public* setup.sh URL. Pulls setup.sh from
# gh-pages, clones the public repo at the current branch, runs `bun install`,
# boots `bun run dev` in a clean Ubuntu container, and curls /api/heartbeat
# + /api/heartbeatz to confirm the install actually works. The branch under
# test must already be pushed to GitHub. Override with SETUP_URL=… for a
# PR preview (e.g. raw.githubusercontent.com).
test-install-public:
	@site/test/test-install-public.sh

test-setup: test-setup-local test-setup-docker

ci: install lint unit test

# ── Production runtime ─────────────────────────────────────────────────
# `run` runs the production build in the foreground, logs to your terminal,
# Ctrl-C stops it. `up` runs it detached in the background, logs to
# .claudius/logs/claudius.log. Both bind to 127.0.0.1:3000 by default —
# override with PORT / HOST env vars (e.g. `HOST=0.0.0.0 make up` to expose
# on the LAN).
#
# Both auto-run `bun run build` first if no `.next` exists.

run:
	@bin/claudiusd run

up:
	@bin/claudiusd up

down:
	@bin/claudiusd down

restart:
	@bin/claudiusd restart

status:
	@bin/claudiusd status || true

logs:
	@bin/claudiusd logs

# ── Marketing site (site/) ─────────────────────────────────────────────
# `site` serves the static marketing page at http://localhost:4321.
# `screenshots` captures the no-API gallery shots (sessions, agents, mcp,
# cost, git, files, workspace) into site/screenshots/. `screenshots-full`
# additionally drives the agent to capture chat / todos / AskUserQuestion —
# needs ANTHROPIC_API_KEY and a few cents of budget.

site:
	bun run site:preview

screenshots:
	bunx playwright install chromium
	bun run site:screenshots

screenshots-full:
	bunx playwright install chromium
	bun run site:screenshots:full

# ── Self-modify revert (CLI escape hatch) ──────────────────────────────
# `claudius-revert` undoes the most recent active publish. Use it from a
# terminal when the running Claudius UI itself was broken by a bad publish —
# this script has no Claudius runtime dependency, only node:fs.
# `claudius-revert-all` rolls every active publish back, newest-first.

claudius-revert:
	bun bin/claudius-revert --last

claudius-revert-all:
	bun bin/claudius-revert --all

# ── SDK updater (scripts/sdk-update/) ──────────────────────────────────
# Hourly cron pipeline that watches npm for new @anthropic-ai/claude-agent-sdk
# releases, lets Claude do the upgrade, opens a PR, watches CI, and
# announces to the community channel. See scripts/sdk-update/README.md
# for the architecture + on-host setup.
#
# Targets are designed for a remote Linux server but most are safe to
# run locally for one-off testing. `sdk-update-install-cron` is the
# only one that mutates the user's crontab.
#
# Env (loaded from .claudius/sdk-updater/env if present, else inherited
# from the caller): ANTHROPIC_API_KEY, GH_TOKEN, CHAT_SERVER_URL,
# CHAT_SERVER_ADMIN_TOKEN, plus the SDK_UPDATE_* tunables.

# Dry-run probe: prints whether there's a new SDK version + what the
# orchestrator would do. Mutates state.json (updates lastCheckedAt /
# skipped) but does not touch git or open PRs. Safe to run locally.
sdk-update-check:
	bun run scripts/sdk-update/check.ts

# One-shot manual fire — same code path as cron. Reads check, then
# runs orchestrate if there's work. WILL create a branch, push, and
# open a PR if a new version is out, so don't run this on your laptop
# unless that's what you want.
sdk-update-run:
	@scripts/sdk-update/run.sh

# Local dry-run. Same as `sdk-update-run` through the gate, then stops
# before push / PR / CI watch / announce. Branch + Claude's commits
# stay on disk for inspection.
#
# Skip slow gate steps with SKIP (comma-separated of lint,unit,build,e2e).
# Common combo: SKIP=e2e make sdk-update-dry-run for fast prompt iteration.
sdk-update-dry-run:
	@SDK_UPDATE_DRY_RUN=1 \
		SDK_UPDATE_SKIP_GATES="$(SKIP)" \
		scripts/sdk-update/run.sh

# Status summary — last check time, current state, in-flight upgrade
# (if any), and skipped versions. Cheap, read-only.
sdk-update-status:
	@if [ -f .claudius/sdk-updater/state.json ]; then \
		echo "── state.json ─────────────────────────────────────"; \
		cat .claudius/sdk-updater/state.json; \
	else \
		echo "(no state file yet — updater has never run on this host)"; \
	fi
	@echo
	@if [ -f .claudius/sdk-updater/run.lock ] && command -v flock >/dev/null 2>&1; then \
		if ! flock -n -s .claudius/sdk-updater/run.lock -c true 2>/dev/null; then \
			echo "── lock ──────────────────────────────────────────"; \
			echo "run.lock is currently HELD — an upgrade is in flight"; \
		fi; \
	fi

# Tail the cron log. Pass FOLLOW=1 to stream (-f).
sdk-update-logs:
	@touch .claudius/sdk-updater/logs/cron.log
	@if [ "$(FOLLOW)" = "1" ]; then \
		tail -f .claudius/sdk-updater/logs/cron.log; \
	else \
		tail -n 200 .claudius/sdk-updater/logs/cron.log; \
	fi

# Install the hourly crontab line for the current user on the current
# host. Idempotent — refuses to add a duplicate. Use `crontab -e` to
# tweak the schedule afterwards.
sdk-update-install-cron:
	@ROOT="$$(pwd)"; \
	LINE="0 * * * * $$ROOT/scripts/sdk-update/run.sh >> $$ROOT/.claudius/sdk-updater/logs/cron.log 2>&1"; \
	mkdir -p "$$ROOT/.claudius/sdk-updater/logs"; \
	TMP="$$(mktemp)"; \
	crontab -l 2>/dev/null > "$$TMP" || true; \
	if grep -qF "scripts/sdk-update/run.sh" "$$TMP"; then \
		echo "✓ crontab already contains an sdk-update entry — leaving it alone"; \
	else \
		echo "$$LINE" >> "$$TMP"; \
		crontab "$$TMP"; \
		echo "✓ installed: $$LINE"; \
	fi; \
	rm -f "$$TMP"

# Remove the hourly crontab line. Matches by the script path so a
# manually-edited schedule (`30 * * * *`) is still removed.
sdk-update-uninstall-cron:
	@TMP="$$(mktemp)"; \
	crontab -l 2>/dev/null > "$$TMP" || true; \
	if grep -qF "scripts/sdk-update/run.sh" "$$TMP"; then \
		grep -vF "scripts/sdk-update/run.sh" "$$TMP" > "$$TMP.new"; \
		crontab "$$TMP.new"; \
		echo "✓ removed sdk-update entry from crontab"; \
		rm -f "$$TMP.new"; \
	else \
		echo "✓ no sdk-update entry in crontab — nothing to do"; \
	fi; \
	rm -f "$$TMP"
