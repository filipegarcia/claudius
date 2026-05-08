---
name: screenshot-capture
description: Capture or refresh the marketing screenshots for site/. Drives the running Claudius instance via Playwright, snaps the canonical 10 routes (chat, todos, ask-user-question, sessions, agents, mcp, cost, git, files, workspace, skills), and writes PNGs to site/screenshots/. Use whenever the UI changes and the marketing gallery looks stale.
allowed-tools:
  - Read
  - Edit
  - Bash
  - Grep
  - Glob
---

# Marketing screenshot pipeline

The marketing site at `site/index.html` references PNGs in `site/screenshots/`. Those are populated by `tests/e2e/site-screenshots.spec.ts` — every shot is a real Playwright capture from the dev server, taken inside the `claudius` workspace.

## Run them

```bash
make screenshots         # 7 static routes — fast, no API key needed
make screenshots-full    # adds chat/todos/AskUserQuestion — uses real API, ~5 min
```

## What to do when

- **A page's chrome changed** (header, side nav, layout) — re-run `make screenshots`. Static shots are deterministic and cheap.
- **The chat surface changed** (todos banner, AskUserQuestion modal, prompt input) — re-run `make screenshots-full`. Costs a few cents in API calls.
- **A new page exists** that should be in the gallery — add a tuple to the `for` loop in the static-routes describe (in the spec), add a `<figure>` to `site/index.html`, then re-run.
- **The chat shot looks busy** (queued tabs, mid-stream content) — the spec uses `freshChatSession()` to open a clean `+` tab; if you're still seeing prior content, check that the dev server's open-tabs aren't sticky.

## Things that have bitten before

- The dev server resumes the last-active session on `/`. Any "chat" shot must call `freshChatSession()` first or land on a busy queued session.
- The Cost page reads from `/api/cost` — on a brand-new workspace, the chart looks empty. The spec injects a deterministic 60-day fixture via `page.route` for the marketing run only.
- Don't commit changes to existing screenshots without a corresponding PNG diff review — the gallery decides the first impression of the project.
