# Claudius

Claude Code in the browser. A Next.js app that wraps the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and exposes a full session UI — chat, tool calls, permissions, MCP servers, plugins, hooks, agents, scheduling, and memory — alongside views for cost, usage, sessions history, files, and git.

## Stack

- Next.js 16 (App Router) + React 19
- Tailwind CSS v4
- `better-sqlite3` for local persistence (sessions, schedules, assets)
- `@anthropic-ai/claude-agent-sdk` for agent execution
- Playwright for end-to-end tests

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Run the production build |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run test:e2e:ui` | Playwright in UI mode |

## Layout

- `app/` — App Router pages and `app/api/` routes (sessions, agents, MCP, plugins, schedule, hooks, permissions, memory, settings, workspaces, git, cost, files, …)
- `components/` — UI: chat, overlays, panels, navigation, files, git, cost, schedule, sessions, workspaces
- `lib/server/` — Node-only logic: session manager, scheduler, MCP, hooks, plugins, asset store, SQLite migrations
- `lib/client/` — React hooks and client utilities
- `lib/shared/` — Shared types and helpers
- `tests/e2e/` — Playwright specs

## Notes for contributors

This repo runs on Next.js 16, which has breaking changes from earlier versions. Check `node_modules/next/dist/docs/` and any deprecation notices before making framework-level changes — see `AGENTS.md`.
