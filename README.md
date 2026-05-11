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

If 3000 is taken, override the port with `PORT` (Next picks it up for both `dev` and `start`):

```bash
PORT=8080 bun run dev
```

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

## Running it day-to-day

For one-off hacking, `bun run dev` is fine. For something you want to keep running between shell sessions, use the Make targets — they wrap `bin/claudiusd`, a small PID-file daemon that handles start/stop/logs without needing PM2 or systemd.

Both modes auto-run `bun run build` the first time, so there's no separate build step to remember.

| Make target | Mode | Behaviour |
| --- | --- | --- |
| `make run` | Foreground | Logs stream to your terminal; Ctrl-C stops it. |
| `make up` | Background | Detached, logs append to `./.claudius/logs/claudius.log`. Survives the parent shell exiting. |
| `make down` | — | Stop the background process. SIGTERM, with SIGKILL fallback after 10 s. |
| `make restart` | — | `down` then `up`. |
| `make status` | — | Pid, port, last 10 log lines. Exit code 1 when not running. |
| `make logs` | — | `tail -F` the log file. |

Both bind to **`127.0.0.1:3000`** by default — Claudius drives the Claude Agent SDK with filesystem and tool access, so exposing it on your LAN is opt-in. Override via env:

```bash
PORT=8080 make up                  # different port, still loopback-only
HOST=0.0.0.0 PORT=8080 make up     # reachable from your LAN (careful)
```

To make the override stick across runs (dev and production), drop it in `.env.local` at the repo root — Next reads it automatically:

```
PORT=8080
HOST=127.0.0.1
```

Runtime state lives in `./.claudius/` (gitignored):

```
.claudius/
├── claudius.pid          # PID of the active background process
└── logs/claudius.log     # appended on every `make up`
```

If the log file ever gets unwieldy: `make down && rm .claudius/logs/claudius.log && make up`.

## Layout

- `app/` — App Router pages and `app/api/` routes (sessions, agents, MCP, plugins, schedule, hooks, permissions, memory, settings, workspaces, git, cost, files, …)
- `components/` — UI: chat, overlays, panels, navigation, files, git, cost, schedule, sessions, workspaces
- `lib/server/` — Node-only logic: session manager, scheduler, MCP, hooks, plugins, asset store, SQLite migrations
- `lib/client/` — React hooks and client utilities
- `lib/shared/` — Shared types and helpers
- `tests/e2e/` — Playwright specs

## Notes for contributors

This repo runs on Next.js 16, which has breaking changes from earlier versions. Check `node_modules/next/dist/docs/` and any deprecation notices before making framework-level changes — see `AGENTS.md`.
