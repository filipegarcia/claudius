# Claudius

Claude Code in the browser. A Next.js app that wraps the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and exposes a full session UI — chat, tool calls, permissions, MCP servers, plugins, hooks, agents, scheduling, and memory — alongside views for cost, usage, sessions history, files, and git.

## Stack

- Next.js 16 (App Router) + React 19
- Tailwind CSS v4
- `better-sqlite3` for local persistence (sessions, schedules, assets)
- `@anthropic-ai/claude-agent-sdk` for agent execution
- [Bun](https://bun.sh) as the package manager (CI runs on `oven/bun:1`)
- Playwright for end-to-end tests

## Getting started

```bash
bun install
bun run dev
```

Open <http://localhost:3000>.

If you don't have Bun yet: `curl -fsSL https://bun.sh/install | bash` (or `brew install bun`).

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Start the dev server |
| `bun run build` | Production build |
| `bun start` | Run the production build |
| `bun run lint` | ESLint |
| `bun run test:e2e` | Playwright end-to-end tests |
| `bun run test:e2e:ui` | Playwright in UI mode |

## Layout

- `app/` — App Router pages and `app/api/` routes (sessions, agents, MCP, plugins, schedule, hooks, permissions, memory, settings, workspaces, git, cost, files, …)
- `components/` — UI: chat, overlays, panels, navigation, files, git, cost, schedule, sessions, workspaces
- `lib/server/` — Node-only logic: session manager, scheduler, MCP, hooks, plugins, asset store, SQLite migrations
- `lib/client/` — React hooks and client utilities
- `lib/shared/` — Shared types and helpers
- `tests/e2e/` — Playwright specs

## Notes for contributors

This repo runs on Next.js 16, which has breaking changes from earlier versions. Check `node_modules/next/dist/docs/` and any deprecation notices before making framework-level changes — see `AGENTS.md`.
