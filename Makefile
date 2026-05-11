.PHONY: install dev build start lint unit test test-ui ci site screenshots screenshots-full claudius-revert claudius-revert-all run up down restart status logs

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

test:
	bunx playwright install chromium
	bun run test:e2e

test-ui:
	bun run test:e2e:ui

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
