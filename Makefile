.PHONY: help install dev build start lint unit test test-ui test-e2e-electron test-setup test-setup-local test-setup-docker test-install-public ci site screenshots screenshots-full claudius-revert claudius-revert-all run up down restart status logs electron electron-dev electron-build electron-icons electron-app electron-dist electron-dmg electron-e2e-loop update-run update-dry-run update-logs update-install-cron update-uninstall-cron sdk-update-check sdk-update-run sdk-update-fix-pr sdk-update-dry-run sdk-update-status sdk-update-logs sdk-update-install-cron sdk-update-uninstall-cron cc-parity-check cc-parity-run cc-parity-fix-pr cc-parity-dry-run cc-parity-status cc-parity-logs cc-parity-install-cron cc-parity-uninstall-cron debug-export recover documentation

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

# Diagnose + clean up when the browser shows an empty workspace rail
# (or any "Electron sees it, browser doesn't" symptom). The script
# reports the on-disk workspaces.json count, probes /api/workspaces on
# the running dev server, and clears `.next/` when it's safe to do so
# (no dev process listening on PORT). Pass `RESTART=1` to also stop the
# dev server, clear the cache, and re-launch `bun run dev` in one go.
#
#   make recover            # diagnostic + safe cleanup
#   make recover RESTART=1  # also stops dev, clears .next, restarts
#   PORT=3001 make recover  # non-default dev port
recover:
	@PORT="$(PORT)" bun run scripts/dev-recover.mjs $(if $(RESTART),--restart,)

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

# Regenerate the app icon set from scripts/make-icons.mjs: composes the
# terracotta-squircle SVG, rasterizes a 1024 master via headless chromium,
# then builds build/icons/icon.icns (mac) + linux PNGs. Re-run after
# tweaking the design. (Windows icon.ico is intentionally not generated.)
electron-icons:
	bun run electron:icons

# Unsigned, unpackaged `Claudius.app` for the host arch — the fastest way
# to get a launchable bundle without the DMG/notarization machinery. Output
# lands in `release/mac*/Claudius.app`. CSC_IDENTITY_AUTO_DISCOVERY=false
# (set in the npm script) keeps electron-builder from stalling on a missing
# signing identity. For the full distributable, use `electron-dist`.
electron-app:
	bun run electron:app

# Full mac installer (DMG + ZIP). For Windows/Linux installers, see the
# `electron:dist:win` / `electron:dist:linux` npm scripts directly.
electron-dist:
	bun run electron:dist:mac

# Alias for the macOS DMG path — same recipe as `electron-dist`, just named
# for what the user actually wants. Lands at
# `release/Claudius-<version>-mac-x64.dmg`; open it with `open release/*.dmg`.
electron-dmg: electron-dist

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

# ── Combined update pipeline (scripts/update-pipeline.sh) ──────────────
# ONE cron that runs BOTH the SDK updater and the cc-parity reviewer
# back-to-back in a single firing (SDK first; its combined mode absorbs a
# claude-code release when both moved, so cc-parity then noops — no double
# work). Portable lock + macOS-friendly PATH, so this is the recommended
# entrypoint on a Mac as well as a Linux server. See update-pipeline.sh.

# One-shot manual fire of BOTH pipelines — same code path as the cron.
# WILL create branches, push, and open PRs if there's a new release.
update-run:
	@scripts/update-pipeline.sh

# Local dry-run of BOTH pipelines: runs through the gates, then stops
# before push / PR / CI watch / announce. Skip slow gate steps with SKIP
# (comma-separated of lint,unit,build,e2e).
update-dry-run:
	@SDK_UPDATE_DRY_RUN=1 CC_PARITY_DRY_RUN=1 \
		SDK_UPDATE_SKIP_GATES="$(SKIP)" CC_PARITY_SKIP_GATES="$(SKIP)" \
		scripts/update-pipeline.sh

# Tail the combined cron log. Pass FOLLOW=1 to stream (-f).
update-logs:
	@mkdir -p .claudius/logs
	@touch .claudius/logs/update-pipeline.log
	@if [ "$(FOLLOW)" = "1" ]; then \
		tail -f .claudius/logs/update-pipeline.log; \
	else \
		tail -n 200 .claudius/logs/update-pipeline.log; \
	fi

# Install the SINGLE hourly crontab line that runs both pipelines.
# Idempotent. Warns if the older split per-pipeline cron lines are still
# present (run `make sdk-update-uninstall-cron cc-parity-uninstall-cron`
# to drop them — the combined line supersedes both).
update-install-cron:
	@ROOT="$$(pwd)"; \
	mkdir -p "$$ROOT/.claudius/logs"; \
	LINE="0 * * * * $$ROOT/scripts/update-pipeline.sh >> $$ROOT/.claudius/logs/update-pipeline.log 2>&1"; \
	TMP="$$(mktemp)"; \
	crontab -l 2>/dev/null > "$$TMP" || true; \
	if grep -qF "scripts/update-pipeline.sh" "$$TMP"; then \
		echo "✓ crontab already contains the combined update-pipeline entry — leaving it alone"; \
	else \
		echo "$$LINE" >> "$$TMP"; \
		crontab "$$TMP"; \
		echo "✓ installed: $$LINE"; \
	fi; \
	if grep -qE "scripts/(sdk-update|cc-parity)/run.sh" "$$TMP"; then \
		echo "⚠ note: the older split cron line(s) for sdk-update/cc-parity are still installed."; \
		echo "  The combined line supersedes them — remove with:"; \
		echo "    make sdk-update-uninstall-cron cc-parity-uninstall-cron"; \
	fi; \
	rm -f "$$TMP"

# Remove the combined crontab line.
update-uninstall-cron:
	@TMP="$$(mktemp)"; \
	crontab -l 2>/dev/null > "$$TMP" || true; \
	if grep -qF "scripts/update-pipeline.sh" "$$TMP"; then \
		grep -vF "scripts/update-pipeline.sh" "$$TMP" > "$$TMP.new"; \
		crontab "$$TMP.new"; \
		echo "✓ removed combined update-pipeline entry from crontab"; \
		rm -f "$$TMP.new"; \
	else \
		echo "✓ no combined update-pipeline entry in crontab — nothing to do"; \
	fi; \
	rm -f "$$TMP"

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

# Fix an existing SDK-update PR by number. Checks out the PR's branch,
# re-runs Claude with the failing CI checks + review comments as
# context, re-gates, pushes, and posts progress to the community
# channel. Marks the PR ready (and drops needs-human) if every gate
# goes green. WILL push to the PR's branch.
#
#   make sdk-update-fix-pr PR=123
#   make sdk-update-fix-pr PR=123 MSG="address the review note about session.ts"
#   make sdk-update-fix-pr PR=123 SKIP=e2e        # skip slow gate steps
sdk-update-fix-pr:
	@if [ -z "$(PR)" ]; then \
		echo "usage: make sdk-update-fix-pr PR=<number> [MSG=\"instruction\"] [SKIP=lint,e2e]"; \
		exit 2; \
	fi
	@SDK_UPDATE_FIX_INSTRUCTION="$(MSG)" \
		SDK_UPDATE_SKIP_GATES="$(SKIP)" \
		scripts/sdk-update/run.sh fix-pr "$(PR)"

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
	@if [ -f .claudius/run.lock.d/holder.pid ] && kill -0 "$$(cat .claudius/run.lock.d/holder.pid 2>/dev/null)" 2>/dev/null; then \
		echo "── lock ──────────────────────────────────────────"; \
		echo "run.lock.d is currently HELD by pid $$(cat .claudius/run.lock.d/holder.pid) — a pipeline is in flight (shared between sdk-update and cc-parity)"; \
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

# ── Claude Code parity (scripts/cc-parity/) ────────────────────────────
# Hourly cron pipeline that watches npm for new @anthropic-ai/claude-code
# releases, classifies each changelog entry A/B/C, and reimplements the
# bucket-B items in Claudius. Sibling to sdk-update; shares the same
# .claudius/run.lock.d so the two pipelines block each other on purpose.
# See scripts/cc-parity/README.md for the architecture + bucketing model.
#
# Env (loaded from .claudius/cc-parity/env if present, else falls back to
# the sdk-updater env file): no extra Anthropic credential needed beyond
# what sdk-update already uses; only the CC_PARITY_* tunables differ.

# Dry-run probe: prints whether there's a new claude-code release worth
# reviewing + what the orchestrator would do. Mutates state.json
# (updates lastCheckedAt / lastSeenVersion / skipped) but does not touch
# git. Safe to run locally.
cc-parity-check:
	bun run scripts/cc-parity/check.ts

# One-shot manual fire — same code path as cron. Reads check, then runs
# orchestrate if there's work. WILL create a branch, push, and open a
# PR if a substantive new release is out, so don't run this on your
# laptop unless that's what you want.
cc-parity-run:
	@scripts/cc-parity/run.sh

# Fix an existing cc-parity PR by number. Checks out the PR's branch,
# re-runs Claude with the failing CI checks + review comments as
# context, re-gates, pushes, and posts progress to the community
# channel. Marks the PR ready (and drops needs-human) if every gate
# goes green. WILL push to the PR's branch.
#
#   make cc-parity-fix-pr PR=123
#   make cc-parity-fix-pr PR=123 MSG="address the review note on the slash command"
#   make cc-parity-fix-pr PR=123 SKIP=e2e        # skip slow gate steps
cc-parity-fix-pr:
	@if [ -z "$(PR)" ]; then \
		echo "usage: make cc-parity-fix-pr PR=<number> [MSG=\"instruction\"] [SKIP=lint,e2e]"; \
		exit 2; \
	fi
	@CC_PARITY_FIX_INSTRUCTION="$(MSG)" \
		CC_PARITY_SKIP_GATES="$(SKIP)" \
		scripts/cc-parity/run.sh fix-pr "$(PR)"

# Local dry-run. Same as `cc-parity-run` through the gate, then stops
# before push / PR / CI watch / announce. Branch + Claude's commits
# stay on disk for inspection.
#
# Skip slow gate steps with SKIP (comma-separated of lint,unit,build,e2e).
cc-parity-dry-run:
	@CC_PARITY_DRY_RUN=1 \
		CC_PARITY_SKIP_GATES="$(SKIP)" \
		scripts/cc-parity/run.sh

# Status summary — last check time, current state, in-flight review
# (if any). Read-only. Also reports the SHARED lock state from
# .claudius/run.lock.d (held by either pipeline).
cc-parity-status:
	@if [ -f .claudius/cc-parity/state.json ]; then \
		echo "── state.json ─────────────────────────────────────"; \
		cat .claudius/cc-parity/state.json; \
	else \
		echo "(no state file yet — cc-parity has never run on this host)"; \
	fi
	@echo
	@if [ -f .claudius/run.lock.d/holder.pid ] && kill -0 "$$(cat .claudius/run.lock.d/holder.pid 2>/dev/null)" 2>/dev/null; then \
		echo "── lock ──────────────────────────────────────────"; \
		echo "run.lock.d is currently HELD by pid $$(cat .claudius/run.lock.d/holder.pid) — a pipeline is in flight (shared between sdk-update and cc-parity)"; \
	fi

# Tail the cron log. Pass FOLLOW=1 to stream (-f).
cc-parity-logs:
	@touch .claudius/cc-parity/logs/cron.log
	@if [ "$(FOLLOW)" = "1" ]; then \
		tail -f .claudius/cc-parity/logs/cron.log; \
	else \
		tail -n 200 .claudius/cc-parity/logs/cron.log; \
	fi

# Install the hourly crontab line for the current user. Fires at 15
# past the hour so it doesn't collide with the sdk-update line (00).
# Idempotent.
cc-parity-install-cron:
	@ROOT="$$(pwd)"; \
	LINE="15 * * * * $$ROOT/scripts/cc-parity/run.sh >> $$ROOT/.claudius/cc-parity/logs/cron.log 2>&1"; \
	mkdir -p "$$ROOT/.claudius/cc-parity/logs"; \
	TMP="$$(mktemp)"; \
	crontab -l 2>/dev/null > "$$TMP" || true; \
	if grep -qF "scripts/cc-parity/run.sh" "$$TMP"; then \
		echo "✓ crontab already contains a cc-parity entry — leaving it alone"; \
	else \
		echo "$$LINE" >> "$$TMP"; \
		crontab "$$TMP"; \
		echo "✓ installed: $$LINE"; \
	fi; \
	rm -f "$$TMP"

# Remove the cc-parity crontab line.
cc-parity-uninstall-cron:
	@TMP="$$(mktemp)"; \
	crontab -l 2>/dev/null > "$$TMP" || true; \
	if grep -qF "scripts/cc-parity/run.sh" "$$TMP"; then \
		grep -vF "scripts/cc-parity/run.sh" "$$TMP" > "$$TMP.new"; \
		crontab "$$TMP.new"; \
		echo "✓ removed cc-parity entry from crontab"; \
		rm -f "$$TMP.new"; \
	else \
		echo "✓ no cc-parity entry in crontab — nothing to do"; \
	fi; \
	rm -f "$$TMP"

# ── Debug export ────────────────────────────────────────────────────────
# Generates a portable debug bundle — `claudius-debug-YYYY-MM-DD.json` —
# in the current directory. The file is:
#   • A valid Claudius settings bundle (importable via Settings → Import)
#     so the maintainer can recreate your exact configuration.
#   • Annotated with diagnostic info (version, platform, workspace count)
#     that helps reproduce the problem without access to your machine.
#
# API keys and other secrets are redacted automatically.
# Claudius does NOT need to be running; the script reads from disk directly.
#
# Attach the generated file to your GitHub bug report.
# See docs/debug-export.md for full details.
debug-export:
	@bun run scripts/debug-export.ts

# ── Documentation ───────────────────────────────────────────────────────
# Generate (and maintain) docs/SITEMAP.md — a catalog of every UI screen,
# navigation menu, and HTTP endpoint in the app.
#
# The route *structure* is discovered from app/**, so it's always an exact
# reflection of what exists. Per-interface descriptions are written by Claude
# (via the same agent SDK the app uses for commit messages) and cached in
# docs/.sitemap-cache.json keyed by a hash of each interface's source — so
# re-running only re-describes the screens whose code actually changed. Uses
# the machine's existing Claude Code credentials; no API key required.
#
#   make documentation            # incremental: only re-describe changed screens
#   make documentation FORCE=1    # ignore the cache; regenerate everything
#   make documentation NO_AI=1    # structure only, no Claude calls (offline)
documentation:
	@node scripts/gen-docs.mjs $(if $(FORCE),--force,) $(if $(NO_AI),--no-ai,)
