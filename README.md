# Claudius

**Claude Code in the browser.** Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

Every Claude Code surface — chat, tool calls, sub-agents, MCP, plugins, hooks, skills, scheduling, memory, cost — on the web. Runs on your machine. Your sessions stay yours.

> Claudius is an independent, open-source project and is not affiliated with, sponsored by, or endorsed by Anthropic, PBC. See [TRADEMARKS.md](./TRADEMARKS.md).

![Chat surface](site/screenshots/chat.png)

---

## What's inside

- **Chat** — streaming responses, tool calls, permission prompts, todos banner, `AskUserQuestion` forms, interrupt.
- **Workspaces** — switch project context without losing sessions, schedules, or MCP config. Each workspace has its own SQLite store.
- **Sub-agents** — define specialists (reviewer, planner, debugger) with their own system prompts, models, and tool sets. Launch them from chat.
- **MCP & plugins** — first-class Model Context Protocol support and a plugin system for extending the agent's tool surface. Install community plugins from any marketplace.
- **Skills** — short, opinionated playbooks Claude calls up when the moment is right. Write once, reuse forever.
- **Hooks** — run commands at any lifecycle event: pre-tool, post-tool, session start, stop. Per-workspace.
- **Schedule** — cron-driven agent runs. Wake up at 9am, check the deploy, file a ticket — without you there.
- **Cost & usage** — per-session, per-model, per-day spend. See where the tokens go before the bill arrives.
- **Git & files** — in-app file browser and git operations: stage, diff, commit, with AI-drafted commit messages.
- **Memory** — persistent notes Claude can read and update across sessions.
- **Community** — a shared room for everyone running Claudius. Bring your own server; institutions can self-host and point Claudius at it.
- **Local-first** — sessions, schedules, assets persisted on your machine. No cloud lock-in, no SaaS account required.

See the [marketing site](https://filipegarcia.github.io/claudius/) for the full screenshot gallery.

---

## Install

One curl, then you're chatting:

```bash
curl -fsSL https://filipegarcia.github.io/claudius/setup.sh | bash
```

The script clones into `~/claudius`, runs `bun install`, drops a `claudius` launcher into `~/.local/bin`, and starts the dev server. Re-running pulls the latest commit on `main`. Requires `git`; [Bun](https://bun.sh) auto-installs if missing.

Flags (after `--`):

```bash
curl -fsSL https://filipegarcia.github.io/claudius/setup.sh | bash -s -- \
  --prefix=$HOME/code/claudius \
  --branch=main \
  --no-start
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--prefix=DIR` | `~/claudius` | Install destination |
| `--branch=BRANCH` | `main` | Git branch |
| `--bin-dir=DIR` | `~/.local/bin` | Where the `claudius` launcher lands |
| `--no-install` | — | Clone only, skip `bun install` |
| `--no-start` | — | Don't auto-start the dev server |

Prefer to read it first? `curl -o setup.sh …` then `less setup.sh && bash setup.sh`. Or skip the script and clone yourself:

```bash
git clone https://github.com/filipegarcia/claudius.git
cd claudius
bun install
bun run dev      # http://localhost:3000
```

---

## Run

After install, just type `claudius` from any shell — it starts the dev server and opens your browser.

For something you want kept running between shell sessions, use the Make targets. They wrap `bin/claudiusd`, a small PID-file daemon — no PM2, no systemd, no Docker. Both modes auto-run `bun run build` the first time.

| Target | Mode | Behaviour |
| --- | --- | --- |
| `make run` | Foreground | Logs stream to terminal; Ctrl-C stops it. |
| `make up` | Background | Detached, logs append to `.claudius/logs/claudius.log`. Survives shell exit. |
| `make down` | — | Stop. SIGTERM, SIGKILL fallback after 10s. |
| `make restart` | — | `down` then `up`. |
| `make status` | — | Pid, port, last 10 log lines. |
| `make logs` | — | `tail -F` the log file. |

Both bind to **`127.0.0.1:3000`** by default — Claudius drives the SDK with filesystem and tool access, so LAN exposure is opt-in:

```bash
PORT=8080 make up                  # different port, still loopback
HOST=0.0.0.0 PORT=8080 make up     # reachable from your LAN (be careful)
```

To make the override stick, drop it in `.env.local`:

```
PORT=8080
HOST=127.0.0.1
```

Runtime state lives in `./.claudius/` (gitignored): PID file and `logs/claudius.log`.

**Sandboxing.** Want the agent's `Bash`, edits, dev servers, and MCP calls boxed in? Run Claudius inside a container, devcontainer, or VM — the SDK spawns `claude` as a local subprocess, so keep Claudius and Claude in the same box, mount your workspace, and expose only `:3000`.

---

## Using Claudius

### Bring your own key

Claudius does not ship with Anthropic credentials and the maintainers do not relay traffic through any shared account. You supply credentials yourself:

- an **Anthropic API key**,
- an **Anthropic OAuth session** (via Claude Code), or
- a provider such as **Amazon Bedrock** or **Google Vertex AI**.

When using Anthropic's API you are bound by their [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Usage Policy](https://www.anthropic.com/legal/aup), and [Privacy Policy](https://www.anthropic.com/legal/privacy).

### Workspaces

A workspace is one project. Each has its own SQLite database (sessions, schedules, MCP config, hooks, skills, agents) under `~/.claude/.claudius/workspaces/<id>/`. Switching workspaces in the rail switches everything — chat history, scheduled jobs, the file tree the agent sees.

Add a workspace via **`/workspace`**; the rail surface-keeps your recent ones one click away.

### Chat

The main surface. Type, Claude streams a response, tool calls render inline, permission prompts pause for your call. When Claude needs a decision, it asks via `AskUserQuestion` and you pick from typed options. The todos banner shows multi-step plans as Claude works through them. Hit `Esc` (or the Stop button) to interrupt.

Every conversation is kept under **`/sessions`** — search, resume, duplicate, or export.

### Sub-agents

Define a sub-agent at **`/agents`** with a name, system prompt, tools, and model. Claude can hand off to it mid-conversation (`@code-reviewer`, `@migration-engineer`) or you can launch one directly. Useful for narrow, repeatable roles that benefit from a focused prompt.

### MCP servers

Plug in tools from anywhere. At **`/mcp`**, add stdio or SSE servers, set env vars, and watch the status badges go green when they connect. Once a server is registered for a workspace, its tools appear to Claude automatically. The `mcp-server-add` skill ships with the right shape for common servers (Linear, Slack, Postgres, …).

### Plugins

**`/plugins`** lets you install community plugins straight from any marketplace you trust. Each plugin can ship skills, sub-agents, MCP servers, hooks, and commands. Toggle per scope (user / workspace / project) and pull new ones without leaving the page.

### Skills

**`/skills`** holds short, opinionated playbooks scoped to a project. They're just markdown with a YAML front-matter trigger — Claude picks them up when a relevant request comes in. Great for "always do X this way in this repo" without rewriting your system prompt.

### Hooks

**`/hooks`** runs shell commands at lifecycle events — `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, etc. Use them for guardrails (block writes outside the repo), notifications (Slack ping when a job finishes), or automation (re-run the formatter after every edit).

### Schedule

Cron without leaving the browser. At **`/schedule`**, define a routine: a prompt or slash command, a cron expression, the workspace it runs in. Claudius wakes up, runs the agent, files the result. Good for daily standups, deploy checks, log triage. One-time runs ("remind me to look at this at 3pm tomorrow") work too.

### Cost & usage

**`/cost`** breaks down spend per session, per model, per day. Set warnings, spot which sub-agent is burning your budget, and export raw events for your own dashboards.

### Git & files

**`/git`** stages, diffs, commits — no shelling out. Stuck on a commit message? Hit "Draft" and Claude writes one from the diff. **`/files`** browses the project the agent is working in, with quick previews.

### Memory

Notes that persist across sessions, scoped per project or per user. Claude can read and write them, so "the user prefers tabs" or "the deploy script is at scripts/deploy.sh" sticks without re-explaining every conversation.

### Customize — edit Claudius from inside Claudius

This is the one that surprises people. Hit **New customization** and Claudius mirrors its own source into a private folder, opens a workspace pointing there, and spawns a preview on a separate port. Chat with the agent like normal — *it edits the mirror, not the running app*. When you're happy, hit **Publish**. If something breaks, **Revert** — or run `make claudius-revert` from a terminal if the UI itself is broken.

Every publish takes byte-level snapshots indexed in a plain JSON manifest under `~/.claude/.claudius/customizations/`. The revert CLI has zero runtime dependencies, so it works even when Claudius itself won't boot.

People have used this to build: a live data-pipeline DAG, a Docker monitor, a synthwave repaint, a DOOM-themed Cost page, Clippy, the Konami code, a Minecraft parkour player next to the thinking block. The full showcase is on the [site](https://filipegarcia.github.io/claudius/#customize).

---

## Dev commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev server on `:3000` |
| `bun run lint` | ESLint (scope by passing file paths) |
| `bun run test:e2e` | Playwright |

See `AGENTS.md` and `CLAUDE.md` for codebase conventions before contributing.

---

## License & trademarks

Claudius is released under the [MIT License](./LICENSE) — use it, modify it, fork it, ship it, just keep the copyright notice.

**Claude®**, **Claude Code®**, and the **Claude Agent SDK** are trademarks of Anthropic, PBC. References here are descriptive ([nominative fair use](https://en.wikipedia.org/wiki/Nominative_use)) — the same way a project might say "for Node.js" or "works with PostgreSQL." See [TRADEMARKS.md](./TRADEMARKS.md) for the full notice.
