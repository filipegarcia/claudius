# Kiro Feature Gap — What kiro.dev Has That Claudius Doesn't

**Status:** Exploration / roadmap input (nothing implemented)
**Branch:** `main`
**Date:** 2026-09-15

> **TL;DR.** Kiro (AWS) is an agentic IDE + CLI + cloud + mobile product family.
> Fourteen capability areas are missing or thin in Claudius. Five are worth
> building because they fit Claudius's local-first, Claude-native positioning:
> **specs**, **chat-platform delivery for scheduled runs**, **file-change hook
> triggers + natural-language hook authoring**, **lazy activation for
> plugins/MCP**, and **PR-as-output for schedules**. Three should be
> deliberately declined: multi-model routing, a full IDE surface, and an
> enterprise SSO/admin layer — each cuts against what Claudius is for.

## 1. Method

Reviewed kiro.dev on 2026-09-15: the home page, docs for specs / steering /
hooks / powers / checkpoints / crew / web / CLI / mobile / enterprise, the
Powers registry (76 entries, 11 categories), and the changelog through
Sep 14 2026 (GPT-5.6 with 1M context, IDE 1.1, CLI 2.21.4, Crew 0.6.0, Kiro
Web GA, Cloud Configuration, ISO 27001 scope, OpenTelemetry export).

Cross-checked against Claudius's `README.md`, `app/`, `app/api/`,
`lib/server/`, `lib/client/`, and `components/` to avoid reporting gaps that
are already covered.

## 2. Gap table

| # | Kiro feature | What it is | Claudius today | Verdict |
|---|---|---|---|---|
| 1 | **Spec-driven development** | Prompt → `requirements.md` (EARS user stories / acceptance criteria) → `design.md` → `tasks.md`, with approval gates between phases. "Quick spec" skips gates; "bugfix spec" variant captures current / expected / unchanged behaviour. Tasks are dependency-analysed and executed in parallel "waves" with live status. | Plan mode + todos banner via the SDK. No persistent spec artifacts, no phase gates, no spec-task runner. | **Build** |
| 2 | **Kiro Web / cloud sessions + autonomous mode** | Browser agent in cloud sandboxes bound to GitHub/GitLab repos; "delegate an outcome" mode plans → implements → opens a PR/MR (never auto-merges). Cron automations that open PRs. Task handoff IDE ↔ CLI ↔ Web with context. | Local-first by design. No hosted/remote session story beyond `HOST=0.0.0.0`. Schedule exists but doesn't produce PRs as an output. | **Build the local-first slice only** (PR-as-output) |
| 3 | **Mobile app (iOS)** | Start a session anywhere, steer/monitor it and review PRs from a phone; sessions + prefs sync. | None. | Decline for now (depends on #2's hosted half) |
| 4 | **Kiro Crew** (open-source persistent agent) | Always-on personal agent: jobs run in their own sessions, results delivered to Slack / Discord / Telegram / Teams / Webex / WeChat; "semantic memory" turns corrections and failures into durable lessons; remote gateway; Apps Launchpad; 4-hour turns. | Schedule + memory + auto-memory + in-app notification feed cover the scheduling half. No chat-platform channels (inbound or outbound), no lesson-learning loop. | **Build** (delivery channels) |
| 5 | **Property-based testing + code-correctness validation** | Agent generates property tests from spec acceptance criteria; automated-reasoning pass flags contradictory requirements before implementation. | Nothing equivalent. | Defer; only meaningful once #1 exists |
| 6 | **Powers** (76 in registry) | Plugin bundles (MCP config + skills + domain knowledge) that stay dormant until keyword-triggered, so dozens can be installed without context bloat. Curated registry, one-click install, cloud-synced. | `/plugins` installs Claude Code plugins from any marketplace (which also bundle skills/agents/MCP/hooks), so packaging is covered. Gap is lazy activation and a curated first-party registry. | **Build** (lazy activation) |
| 7 | **Multi-model + Auto mode** | Claude Opus/Sonnet/Haiku, GPT-5.6, DeepSeek v3.2, MiniMax M2.5; "Auto" picks a model per task by complexity/cost; per-model credit multipliers. | Claude-only via Anthropic / OAuth / Bedrock / Vertex. Inherent to wrapping the Claude Agent SDK. | Decline |
| 8 | **Enterprise layer** | SSO / IAM Identity Center, admin usage dashboards, OpenTelemetry per-user usage export, org-wide policy (tool + MCP allowlists), audit, IP indemnity, ISO 27001 scope. | Single-user, no admin/org surface (`/cost`, `/usage` are personal). | Decline |
| 9 | **Full IDE surface** | Code OSS editor, autocomplete, inline chat, codebase indexing, Open VSX extensions, VS Code settings import, in-editor diff review, native ARM64 builds. | `/files` is a browser with previews, not an editor. | Decline |
| 10 | **Agent Client Protocol (ACP)** | Other editors (Zed, JetBrains, …) drive the agent through an open protocol. | Not exposed. | Watch; cheap if the SDK grows ACP support |
| 11 | **Hook triggers: file create/save/delete, pre/post task execution; NL hook authoring** | 11 triggers incl. agent-file-change events. "Ask Kiro to create a hook" generates the JSON from a description. Hooks can be shell or an agent prompt. | `/hooks` exposes the SDK lifecycle events (Pre/PostToolUse, SessionStart/End, Stop, …). No file-level triggers, no describe-and-generate UX. | **Build** |
| 12 | **Steering inclusion modes** | Per-file rules with `always` / `fileMatch` / `manual (#name)` / `auto` (description-matched); workspace vs global vs cloud scope. | CLAUDE.md + rules + skills cover most of this (skills ≈ `auto`, rules with paths ≈ `fileMatch`). Minor gap: no unified UI over inclusion modes. | Minor; fold into a rules-page polish pass |
| 13 | **`.kiroignore`** | Declarative "never let the agent see these files". | Doable via permissions/hooks; no dedicated first-class control. | Small; consider as a `/permissions` addition |
| 14 | **Cloud Configuration sync** | Steering, custom agents, skills, powers, hooks synced across machines/surfaces without overwriting local files. | `settings-export.ts` / `settings-import.ts` exist but are manual, not sync. | Defer |

## 3. Already at parity — not gaps

- **Checkpoints / rewind** — `components/chat/RewindFilesButton.tsx` +
  `app/api/sessions/fork` cover both Kiro's "restore files + context" and
  "fork conversation" modes.
- **Custom agents / subagents, MCP, skills, core lifecycle hooks, memory,
  voice, session search/dashboard, image input, git worktrees, cost tracking**
  — all present.
- **Desktop app** — the Electron build exists; Kiro's is a full IDE, but
  "installable desktop" is covered.
- Claudius has things Kiro doesn't: self-modification via `/customize`, the
  Community room, the Docker monitor, per-workspace SQLite isolation.

## 4. Prioritised shortlist

Ordered by (value to a Claudius user) × (fit with existing modules) ÷ (effort).

### 4.1 Specs (gap #1) — L

The single defining Kiro feature and the most natural fit for the existing
todos/plan-mode UI. Shape:

- A `specs` table (new migration) per workspace: id, title, phase
  (`requirements` | `design` | `tasks` | `done`), kind (`feature` | `bugfix` |
  `quick`), created/updated.
- Artifacts live on disk under `.claude/specs/<slug>/{requirements,design,tasks}.md`
  so they're git-trackable and visible to the agent without Claudius.
- Phase gates are just chat turns with a fixed prompt + an approve/revise
  control; `AskUserQuestion` already renders the UI for that.
- The task runner reuses the todos banner: parse `tasks.md` checkboxes, run
  each as a session turn, tick on completion. Wave-parallelism can come later
  via worktrees + sub-agents.
- Touch points: `lib/server/session.ts` (prompt injection), a new
  `app/[workspaceId]/specs/` page, `lib/shared/slash-commands.ts` (`/spec`).

### 4.2 Chat-platform delivery for scheduled runs (gap #4) — M

Slack / Telegram / Discord delivery of schedule results is a small,
high-leverage add on top of `lib/server/notification-bus.ts`. Outbound only
first (webhook URL per channel, configured on `/schedule`); inbound (reply in
Slack to steer a run) is a separate, larger piece that needs a public
endpoint and is closer to gap #2.

### 4.3 File-change hook triggers + NL hook authoring (gap #11) — S/M

- File triggers: derive from `PostToolUse` on `Write` / `Edit` / `MultiEdit`
  and match the path glob server-side, so no SDK change is needed.
- NL authoring: a "Describe a hook" button on `/hooks` that opens a chat turn
  with a generator prompt and writes the resulting JSON into workspace hooks.
  The `update-config` skill already knows the hook schema.

### 4.4 Lazy activation for plugins/MCP (gap #6) — M

Solves real context-bloat pain. Keep a per-plugin/per-MCP "activate on
keywords" list; register the server with the SDK only when a prompt matches
(or when the user toggles it). Needs a session restart or the SDK's
runtime-MCP-add path — verify which is available before committing. A curated
registry is optional and can stay a marketplace URL.

### 4.5 PR-as-output for schedules (gap #2, local-first slice) — M

Schedule → fresh worktree (`lib/server/worktrees.ts`) → run → commit →
`gh pr create`. All the pieces exist; this is orchestration plus a "PR opened"
notification. Never auto-merge (match Kiro's stance).

## 5. Deliberately declined

- **Multi-model / Auto mode (#7)** — Claudius is a Claude-native UI on the
  Agent SDK; routing to other providers is a different product.
- **Full IDE (#9)** — a chat-first app with a file browser is the point;
  the editor race is Kiro/Cursor/VS Code's to run.
- **Enterprise SSO / admin (#8)** — single-user, local-first. If demand
  appears, OpenTelemetry export via the SDK's env vars is the cheapest partial.

## 6. Sources

- https://kiro.dev/
- https://kiro.dev/docs/
- https://kiro.dev/docs/specs/
- https://kiro.dev/docs/checkpoints/
- https://kiro.dev/docs/powers/
- https://kiro.dev/powers/
- https://kiro.dev/docs/crew/
- https://kiro.dev/docs/web/
- https://kiro.dev/docs/steering/
- https://kiro.dev/docs/hooks/
- https://kiro.dev/docs/cli/
- https://kiro.dev/docs/mobile/
- https://kiro.dev/changelog/
