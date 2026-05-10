.PHONY: install dev build start lint test test-ui ci site screenshots screenshots-full claudius-revert claudius-revert-all

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

test:
	bunx playwright install chromium
	bun run test:e2e

test-ui:
	bun run test:e2e:ui

ci: install lint test

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
