@AGENTS.md

# Claudius

Next.js 16 (App Router) + React 19 app that wraps `@anthropic-ai/claude-agent-sdk` to put Claude Code in the browser. Local persistence via `better-sqlite3`. See `README.md` for the longer overview.

## Commands

- `npm run dev` — dev server on :3000
- `npm run lint` — ESLint (pass file paths to scope)
- `npm run test:e2e` — Playwright (`make test` installs the chromium binary first)
- `npm run build` — production build

## Layout

- `app/` — App Router pages + `app/api/` route handlers
- `lib/server/` — **Node-only**, never import from client code (SQLite, scheduler, session manager, MCP, hooks, plugins, asset store)
- `lib/client/` — React hooks and browser-safe utilities
- `lib/shared/` — types and helpers usable from either side
- `tests/e2e/` — Playwright specs

## Conventions

- SQLite migrations live in `lib/server/db-migrations/NNN_*.sql` and run on startup; add a new numbered file rather than editing existing ones.
- Tailwind v4 (no `tailwind.config.*` — config is in `app/globals.css` via `@theme`).
- After changes, run `npm run lint` scoped to the files you touched. Fix lint errors in those files; don't dismiss them as pre-existing.
