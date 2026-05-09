.PHONY: install dev build start lint test test-ui ci site screenshots screenshots-full claudius-revert claudius-revert-all

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

start:
	npm start

lint:
	npm run lint

test:
	npx playwright install chromium
	npm run test:e2e

test-ui:
	npm run test:e2e:ui

ci: install lint test

# ── Marketing site (site/) ─────────────────────────────────────────────
# `site` serves the static marketing page at http://localhost:4321.
# `screenshots` captures the no-API gallery shots (sessions, agents, mcp,
# cost, git, files, workspace) into site/screenshots/. `screenshots-full`
# additionally drives the agent to capture chat / todos / AskUserQuestion —
# needs ANTHROPIC_API_KEY and a few cents of budget.

site:
	npm run site:preview

screenshots:
	npx playwright install chromium
	npm run site:screenshots

screenshots-full:
	npx playwright install chromium
	npm run site:screenshots:full

# ── Self-modify revert (CLI escape hatch) ──────────────────────────────
# `claudius-revert` undoes the most recent active publish. Use it from a
# terminal when the running Claudius UI itself was broken by a bad publish —
# this script has no Claudius runtime dependency, only node:fs.
# `claudius-revert-all` rolls every active publish back, newest-first.

claudius-revert:
	node bin/claudius-revert --last

claudius-revert-all:
	node bin/claudius-revert --all
