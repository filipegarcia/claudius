# Claudius — Web Clone of Claude Code

## Context

You want a browser-based interface that mirrors Claude Code's CLI as completely as possible — typing prompts, watching streamed output (text, thinking, tool calls, results), answering interactive permission prompts, running slash commands, browsing session history, configuring hooks/MCP/settings, and using every other feature the CLI exposes. The working directory `/Users/filipegarcia/Projects/claudius/` is empty; this is greenfield.

**Goal**: a faithful, full-feature clone, running locally as a single-user web app, talking to Claude through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` for TypeScript). The SDK is required because `claude -p` subprocess mode cannot surface interactive permission prompts, slash commands, or hook outputs to a parent process — those are exactly the "select options" you want to keep.

**Non-goals (v1)**: multi-user/auth, hosted SaaS, mobile apps, billing.

---

## Architecture

### Stack
- **Frontend**: Next.js 15 (App Router) + React 19 + TypeScript + Tailwind CSS + shadcn/ui
- **Backend**: Next.js Route Handlers (same process), Node.js runtime (not Edge — needs filesystem + child processes)
- **Agent**: `@anthropic-ai/claude-agent-sdk` driving the conversation loop
- **Realtime**: Server-Sent Events (SSE) server→client; HTTP POST client→server (sufficient — no need for WebSockets)
- **Persistence**: rely on SDK's existing `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` JSONL files; add a thin SQLite (better-sqlite3) index only for fast session search/listing
- **Auth**: read `ANTHROPIC_API_KEY` from env or user's existing `~/.claude/.credentials.json` (no in-app login flow needed for local single-user)

### Process model
- One Next.js process. A server-side **SessionManager** singleton holds active `query()` AsyncIterables keyed by sessionId. A browser tab opens an SSE stream to a session; multiple tabs can read the same stream (broadcast).
- Permission prompts: SDK exposes a `canUseTool` callback. The server defers it via a Promise stored in the SessionManager; a `permission_request` event is pushed over SSE; the browser POSTs the decision; the server resolves the Promise.
- Interrupts: AbortController passed to `query()`; POST to `/interrupt` aborts.

### Endpoints
- `GET  /api/sessions` — list sessions (reads `~/.claude/projects/`)
- `POST /api/sessions` — create new session (cwd, model, options)
- `GET  /api/sessions/:id/stream` — SSE: emits all SDK message events
- `POST /api/sessions/:id/input` — send user message (queued if mid-response)
- `POST /api/sessions/:id/permission` — answer pending permission prompt (`allow_once|allow_always|deny|deny_with_feedback`)
- `POST /api/sessions/:id/interrupt` — abort current generation
- `POST /api/sessions/:id/fork` — branch session at message N
- `GET  /api/sessions/:id/transcript` — full JSONL
- `POST /api/sessions/:id/compact` — manual /compact equivalent
- `GET  /api/fs/*`, `POST /api/fs/*` — read/write files for editor panels (CLAUDE.md, settings.json, etc.)
- `GET  /api/mcp`, `POST /api/mcp/*` — MCP server CRUD + OAuth
- `GET  /api/settings`, `POST /api/settings` — settings.json read/write per scope
- `GET  /api/hooks`, `POST /api/hooks/*` — hooks CRUD + test invocation
- `GET  /api/cost` — token/cost stats from active session

---

## Project structure

```
claudius/
├── app/
│   ├── layout.tsx                     # Tailwind, theme provider, status line
│   ├── page.tsx                       # Main chat shell (3-pane: nav | chat | side panels)
│   ├── api/
│   │   ├── sessions/...               # endpoints above
│   │   ├── fs/...
│   │   ├── mcp/...
│   │   ├── settings/...
│   │   └── hooks/...
│   └── (panels)/
│       ├── settings/page.tsx
│       ├── mcp/page.tsx
│       ├── hooks/page.tsx
│       ├── memory/page.tsx
│       ├── permissions/page.tsx
│       ├── plugins/page.tsx
│       ├── agents/page.tsx
│       └── sessions/page.tsx          # full session browser
├── lib/
│   ├── server/
│   │   ├── session-manager.ts         # singleton; holds active queries, permission Promises
│   │   ├── sdk-bridge.ts              # wraps @anthropic-ai/claude-agent-sdk query()
│   │   ├── jsonl-reader.ts            # reads ~/.claude/projects JSONL files
│   │   ├── settings.ts                # read/write/merge settings.json hierarchy
│   │   ├── claudemd.ts                # CLAUDE.md hierarchy resolver
│   │   ├── mcp.ts                     # MCP config CRUD (.mcp.json)
│   │   ├── hooks.ts                   # hook execution + matcher engine (mirrors CLI semantics)
│   │   └── permissions.ts             # rule evaluator (allow/ask/deny patterns)
│   ├── shared/
│   │   ├── events.ts                  # SDK event type definitions
│   │   ├── slash-commands.ts          # registry of all built-in slash commands
│   │   └── keybindings.ts
│   └── client/
│       ├── store.ts                   # Zustand store (sessions, ui state)
│       ├── sse-client.ts
│       └── hotkeys.ts
├── components/
│   ├── chat/
│   │   ├── PromptInput.tsx            # multiline, @-mentions, !shell, slash-command picker
│   │   ├── MessageList.tsx
│   │   ├── AssistantMessage.tsx       # streaming text
│   │   ├── ThinkingBlock.tsx          # collapsible
│   │   ├── ToolCall.tsx
│   │   ├── ToolResult.tsx
│   │   ├── PermissionPrompt.tsx       # interactive allow/deny UI
│   │   ├── DiffViewer.tsx
│   │   ├── ContextGrid.tsx            # /context visualization
│   │   ├── TodoList.tsx
│   │   └── StatusLine.tsx
│   ├── nav/
│   │   ├── SessionPicker.tsx          # /resume, fuzzy search, branches, worktrees
│   │   ├── ProjectSwitcher.tsx
│   │   └── ModeIndicator.tsx          # plan / accept-edits / default / bypass
│   ├── editors/
│   │   ├── ClaudeMdEditor.tsx
│   │   ├── SettingsEditor.tsx
│   │   ├── HookEditor.tsx
│   │   └── McpServerEditor.tsx
│   ├── panels/
│   │   ├── TranscriptViewer.tsx       # Ctrl+O equivalent
│   │   ├── CostPanel.tsx              # /cost /usage /stats
│   │   ├── BackgroundTasks.tsx        # /tasks /bashes
│   │   └── SkillsList.tsx             # /skills
│   └── ui/...                         # shadcn primitives
├── public/themes/                     # built-in + custom themes (mirrors ~/.claude/themes/)
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── README.md
```

---

## Feature delivery phases

Each phase is independently shippable. The destination is the full feature set; phases prioritize the core loop first so you can use it as you build.

### Phase 0 — Foundation (1–2 days)
- Next.js scaffold, Tailwind, shadcn/ui installed
- Agent SDK installed, smoke test in a route that streams a "hello" reply via SSE
- Reads `ANTHROPIC_API_KEY` from env; falls back to `~/.claude/.credentials.json`
- Basic 3-pane layout shell (nav left, chat center, side panel right)

### Phase 1 — Core conversation loop (covers feature areas 1, 2, 13)
- **PromptInput**: multiline (Shift+Enter), character count, autocomplete stub
- **Streaming**: assistant text deltas, **thinking blocks** (collapsible, Ctrl/Alt+T toggle), tool_use cards, tool_result panels, system messages
- **Background tasks**: `Bash(run_in_background=true)` rendering as live-updating panel; BashOutput/Monitor/KillBash UI; `/tasks` panel
- Cancel/interrupt button (AbortController)
- Queue messages while assistant is responding (visual queue indicator)
- Markdown rendering with syntax highlighting (Shiki); code-block copy buttons

### Phase 2 — Permissions UX (covers area 3)
- `canUseTool` callback wired through SessionManager → SSE event → modal in browser → POST decision
- `PermissionPrompt` modal: **allow once / allow always (this session) / allow always (save rule) / deny / deny with feedback**
- Permission mode selector in header: `default | acceptEdits | plan | dontAsk | bypassPermissions`
- Mode cycle keybind (Shift+Tab equivalent)
- Permissions page: visual editor for `allow` / `ask` / `deny` rules with rule-syntax helper (`Bash(npm run *)`, `Read(./src/**)`, `WebFetch(domain:example.com)`, `mcp__server__tool`)
- Sandbox toggle (display-only on macOS for now; documents the OS-level effect)

### Phase 3 — Sessions & history (covers area 10)
- `SessionPicker`: fuzzy search across `~/.claude/projects/*/` JSONL files; preview pane (Space)
- Resume / continue / fork (Ctrl+B branch filter, Ctrl+W worktree filter, Ctrl+A all-projects)
- Rename session (`/rename`)
- Export to plain text (`/export`)
- Per-message rewind ("checkpoints") — re-issue session truncated to message N
- Session JSONL viewer (raw)
- `from-pr` import: take a GitHub PR URL, fetch diff, seed a new session

### Phase 4 — Slash commands (covers area 4)
- Registry: data-driven list of every built-in command from the inventory below
- `/`-trigger menu in PromptInput with fuzzy filter
- Implementations:
  - **Native** (handled in app code): `/clear /reset /new`, `/compact`, `/model`, `/cost /usage /stats`, `/context`, `/copy`, `/diff`, `/export`, `/fork /branch`, `/help`, `/init`, `/memory`, `/permissions /allowed-tools`, `/plan`, `/recap`, `/rename`, `/resume /continue`, `/rewind /checkpoint /undo`, `/sandbox`, `/skills`, `/status`, `/statusline`, `/theme`, `/tasks /bashes`, `/effort`, `/fast`, `/exit /quit`, `/keybindings`, `/btw`, `/insights`, `/release-notes`, `/feedback /bug`, `/heapdump`, `/doctor`, `/focus`
  - **Pass-through to SDK**: `/agents`, `/hooks`, `/mcp`, `/plugin`, `/reload-plugins`
  - **External / not applicable in v1** (hidden but listed): `/desktop /app`, `/mobile /ios /android`, `/chrome`, `/passes`, `/stickers`, `/install-github-app`, `/install-slack-app`, `/setup-bedrock`, `/setup-vertex`, `/teleport /tp`, `/upgrade`, `/voice`, `/web-setup`, `/remote-control /rc`, `/remote-env`, `/tui`
  - **Skill commands**: `/batch`, `/claude-api`, `/debug`, `/fewer-permission-prompts`, `/loop`, `/schedule`, `/simplify`, `/security-review`, `/review`, `/ultraplan`, `/ultrareview` — invoked through the SDK (skills are first-class to the agent)
- MCP prompts: `/mcp__<server>__<prompt>` autodiscovered

### Phase 5 — Memory & context (covers area 6)
- CLAUDE.md hierarchy viewer + editor: managed → user → project → local, with priority indicator
- `@path` import resolution (recursive, max 5 hops, cycle detection)
- `.claude/rules/` editor with `paths:` frontmatter glob testing
- `/memory` UI: browse `MEMORY.md` index, open individual memory files, toggle `autoMemoryEnabled`
- Auto-compaction warning at 90% context
- `/context` grid visualization (token allocation by category)
- `claudeMdExcludes` setting

### Phase 6 — MCP (covers area 7)
- MCP server list (read `.mcp.json` + user/managed `mcpServers`)
- Add server: stdio / http / sse, env vars, headers, OAuth config
- OAuth flow: browser-handled redirect, token storage in `~/.claude/.credentials.json`
- Server status (connected/disconnected/retry-N)
- Tool/resource/prompt browser per server
- Import from Claude Desktop / claude.ai (parse their config files)
- `--bare` mode toggle, `ENABLE_TOOL_SEARCH`, `alwaysLoad` per server
- Tool output limits (10k warn / 25k cap, configurable)
- Use Claude Code as MCP server: `claude mcp serve` shellout button

### Phase 7 — Hooks (covers area 8)
- Hook event registry covering all 24 event types (SessionStart/End/Setup, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest/Denied, SubagentStart/Stop, TaskCreated/Completed, FileChanged, ConfigChange, PreCompact/PostCompact, Notification, Elicitation/ElicitationResult, WorktreeCreate/Remove, etc.)
- HookEditor: matcher (string | pipe-list | regex), handler type (command | http | mcp_tool | prompt | agent), timeout, async/asyncRewake, once
- Live test runner: trigger a fake event, see hook output / exit code / blocking decision
- Visualize hook firing in transcript (PostToolUse output, blocked tools, etc.)
- `disableAllHooks` toggle

### Phase 8 — Subagents (covers area 5)
- `Task` tool calls render as nested mini-conversations (collapsible)
- Parallel agents: render side-by-side cards
- Background agents (`run_in_background`): live-updating background card with Monitor stream
- `/agents` page: list defined subagents (`.claude/agents/`), edit frontmatter (description, tools, model)
- Agent-to-agent messaging visualization

### Phase 9 — Settings & customization (covers area 9)
- SettingsEditor with scope tabs: managed (read-only) | user (`~/.claude/settings.json`) | project (`.claude/settings.json`) | local (`.claude/settings.local.json`)
- JSON-schema-validated form for every documented key (model, theme, permissionMode, outputStyle, statusLine, defaultMode, allow/ask/deny, additionalDirectories, hooks, mcpServers, autoMemoryEnabled, claudeMdExcludes, enabledPlugins, env, etc.)
- Theme picker: built-in (auto/light/dark/daltonized/ANSI) + custom themes from `~/.claude/themes/`
- Statusline: configure script command or pick from templates; live preview
- Keybindings editor: `~/.claude/keybindings.json` with chord support
- Output style picker
- Vim mode toggle for prompt input
- Effort level selector

### Phase 10 — Plan mode & special modes (covers area 12 and parts of 1)
- Plan mode entry: `/plan [desc]` or mode toggle
- Plan file viewer/editor (markdown) with inline-comment threads before acceptance
- ExitPlanMode flow: review → accept → automatic execute
- Fast mode toggle (`/fast`, Alt+O / Option+O)
- Voice dictation (Web Speech API as a stand-in for `/voice`)
- Side-question mode (`/btw`): one-shot, ephemeral, no tools, no history

### Phase 11 — File context & paste behavior (covers area 1, 11)
- `@`-mention picker: file/dir autocomplete, line ranges (`@file.ts#5-10`)
- Drag-drop files into prompt
- Paste images from clipboard (Ctrl+V/Cmd+V), positional reference
- File tree side panel for the project cwd (`additionalDirectories` aware)
- `/add-dir` UI

### Phase 12 — IDE / external integrations (covers area 11)
- VS Code extension URL handler (`vscode://file/...`) for "open in editor" buttons
- Cmd+click on PR links opens browser via `gh`
- IDE diagnostics: optional bridge to a running VS Code via existing IDE MCP server
- Deep-link handler `claudius://prompt?...` for browser bookmarks
- Drop-in HTML page that the macOS Desktop app could embed (future)

### Phase 13 — Plugins & marketplaces (covers parts of 9)
- `/plugin` UI: enable/disable, list `enabledPlugins`
- Marketplace config: `extraKnownMarketplaces`, `strictKnownMarketplaces`, `blockedMarketplaces`
- Plugin-bundled hooks/MCP/skills surface in their respective panels with provenance badge
- Reload plugins button

### Phase 14 — Cost, auth, providers (covers areas 14, 15)
- `/cost /usage /stats` panel: session cost (from SDK message metadata), plan-limit indicator, activity stats (messages/tools/tokens)
- Token-counter live in status line
- Provider switcher: Anthropic API | Bedrock (CLAUDE_CODE_USE_BEDROCK) | Vertex (CLAUDE_CODE_USE_VERTEX) | Foundry (CLAUDE_CODE_USE_FOUNDRY) — each shows env-var helper, never stores secrets in code
- Logout button (clears credentials file)

### Phase 15 — Worktrees & multi-cwd (covers area 16)
- Worktree picker (parses `git worktree list`)
- Spawn isolated session per worktree (mirrors `claude --worktree <branch>`)
- Worktree filter in session picker

### Phase 16 — Polish (covers area 16, parts of 1)
- Notifications: browser Notification API on session idle / Stop / permission request
- Prompt suggestions (context-aware follow-ups)
- Recap on return after 3+ min idle
- Release notes viewer (`/release-notes`)
- `/insights` report generator
- `/team-onboarding` doc generator
- `/doctor` health check page
- `/heapdump` (Node `process.report.writeReport`)

---

## Critical files to create

(All new — directory is empty.)

- `lib/server/session-manager.ts` — heart of the system; holds active SDK queries, brokers permission prompts, broadcasts SSE
- `lib/server/sdk-bridge.ts` — thin wrapper around `query()` from `@anthropic-ai/claude-agent-sdk` that normalizes events, attaches the `canUseTool` and hook callbacks
- `lib/shared/slash-commands.ts` — single source of truth for all slash commands (label, description, scope, handler kind)
- `lib/server/jsonl-reader.ts` — reads `~/.claude/projects/<encoded-cwd>/<id>.jsonl`; produces a unified message stream identical to live SDK events (so resume "just works")
- `components/chat/PermissionPrompt.tsx` — the interactive permission UI (this is the centerpiece of the "select options" experience)
- `app/api/sessions/[id]/stream/route.ts` — SSE handler; the live edge between server agent and browser
- `app/page.tsx` — top-level layout

---

## Reusable prior art (not to reinvent)

- **Agent SDK** does the agent loop, tool execution, MCP, hooks, permission callbacks, streaming, JSONL persistence, compaction, subagents, Bash backgrounding, web search/fetch — we wrap, we do not reimplement.
- **shadcn/ui** + **Tailwind** for components (dialogs, popovers, tabs, command palette).
- **Shiki** for syntax highlighting (matches VS Code).
- **react-diff-viewer-continued** for the diff panel.
- **react-markdown** + **remark-gfm** for assistant text.
- **xterm.js** if we want a real embedded terminal for `/teleport` / shell-mode output.
- **better-sqlite3** for the session index (optional; pure-JSONL reads are fine to start).
- **zod** for validating settings.json against schema.

---

## Verification

End-to-end sanity tests for each phase:
1. **Phase 0**: prompt "hi", see streamed reply.
2. **Phase 1**: ask Claude to read a file → see Tool_use card with parameters and live tool_result.
3. **Phase 2**: ask Claude to write a file → permission modal pops; deny; observe Claude reacts. Allow-always; second write proceeds silently.
4. **Phase 3**: kill the server mid-conversation, restart, open `/resume`, see the session, click it, full transcript renders, continue prompting.
5. **Phase 4**: type `/`, see the full slash-command palette; run `/cost`, `/context`, `/clear`, `/compact`, `/memory`, `/model claude-sonnet-4-6` — each does the right thing.
6. **Phase 5**: edit project CLAUDE.md in-app, ask Claude a question that depends on it, see the answer use the new content.
7. **Phase 6**: add an MCP server (e.g. local stdio echo server), see its tools appear, invoke one.
8. **Phase 7**: configure a `PreToolUse` hook that blocks `Bash(rm -rf *)`; trigger; observe blocked tool in transcript.
9. **Phase 8**: ask Claude to delegate to a Task subagent; render the nested conversation.
10. **Phase 9**: change theme; change permissionMode; restart; verify persistence to correct settings file scope.
11. **Phase 10**: enter plan mode; observe plan file editor; accept; agent executes.
12. **Phase 14**: run a session, observe `/cost` updates live during streaming.
13. **Cross-cutting**: side-by-side compare the same conversation in real `claude` CLI and in Claudius — message-for-message parity is the definition of "faithful."

---

## Out of scope for v1 (deferred but documented)

- Multi-user auth, billing, hosted SaaS
- Full mobile clients (mobile-responsive web is in scope; native is not)
- Re-implementing things that are inherently terminal-only (true PTY, real `/tui` renderer, voice with hold-Space)
- Re-implementing the actual `claude` CLI binary or the agent loop itself
- Extras tied to Anthropic's hosted product surface (`/passes`, `/stickers`, `/install-github-app` deep flows, `/desktop` handoff) — surfaced as "open in browser" links

---

## Key risks

1. **SDK API drift**: the Agent SDK is moving. Pin a version; abstract behind `lib/server/sdk-bridge.ts` so a future swap (CLI subprocess, direct API) is contained.
2. **Permission UX latency**: SSE→browser→POST round-trip for every permission can feel slow. Mitigation: heavy use of "allow always" rules; optimistic UI; the existing `acceptEdits` and `bypassPermissions` modes still work.
3. **JSONL format changes**: `~/.claude/projects/.../*.jsonl` is not a public contract. Defensive parsing; tolerate unknown event types.
4. **Hook execution model**: re-implementing the matcher/exec semantics exactly is non-trivial. Lean on the SDK's hook callbacks rather than parsing settings.json into our own executor.
5. **Scope**: this plan covers ~1000 features across 16 areas. Phases 0–4 are the usable product; everything after is value-add. Ship early, iterate.

---

## Pending tasks

### Add a "create memory" affordance to `/memory` ✓ shipped earlier in session



**Goal** — On the `/memory` page (the right-hand "Auto-memory" section), add UI to create a new auto-memory file without leaving the page. The form should write a new file under `~/.claude/projects/<encoded-cwd>/memory/`, then update `MEMORY.md` (the index) with a one-line pointer. Currently the section is read-only — files can be listed and viewed but not created.

**Why** — Auto-memories are written by Claude into a per-project directory. There is no UI path to add one manually; users today have to drop a file by hand and remember the frontmatter shape. We want parity with the read-side affordances already present.

**Files involved**

- `app/memory/page.tsx` — `AutoMemorySection` is the right pane (file list + viewer). Add the create-form UI here.
- `app/api/memory/auto/route.ts` — currently only handles `GET` (list + read-one). Add `POST` for creation.
- `lib/server/auto-memory.ts` — has `autoMemoryDir`, `listAutoMemory`, `readMemoryFile`. Add `writeMemoryFile` + index-append helpers.
- `lib/client/useAutoMemory.ts` — hook exposes `{ dir, files, refresh, readFile }`. Add a `createMemory(...)` action.

**UX**

Place an "Add memory" affordance at the top of the file-list column in `AutoMemorySection` (next to the "Auto-memory ({count})" header — a `+` icon button from `lucide-react`). Clicking it reveals an inline form above the file list (or replaces the viewer pane until cancelled — your call, but inline is preferred to match the page's tight layout). Form fields:

| Field | Control | Notes |
|---|---|---|
| `type` | select | one of `user`, `feedback`, `project`, `reference` |
| `name` | text | the human-readable memory name (frontmatter `name`) |
| `description` | text | one line; used as both frontmatter `description` and `MEMORY.md` hook |
| `filename` | text | auto-derived as `<type>_<slug(name)>.md`; user can override; must match `^[\w.\-]+\.md$` |
| `body` | textarea | markdown body; for `feedback`/`project` types, hint at the **Why:** / **How to apply:** structure |

Submit button: disabled until required fields are filled. Show inline error from API on failure. On success: clear form, call `refresh()`, and `setActive(newFilename)` so the new file shows in the viewer.

**Server contract**

`POST /api/memory/auto?cwd=<absPath>` — JSON body:

```ts
{ filename: string, type: "user"|"feedback"|"project"|"reference",
  name: string, description: string, body: string }
```

Behavior:

1. Validate `filename` against `^[\w.\-]+\.md$` (matches the existing read whitelist) — reject any path traversal (`..`, `/`).
2. Resolve target path via `autoMemoryDir(cwd)`; ensure the directory exists (`fs.mkdir({ recursive: true })`).
3. Write the file with `fs.writeFile(path, content, { flag: "wx" })` so existing files return 409 instead of being overwritten. Content shape (matches the auto-memory format exactly — including the blank line after the closing `---`):

   ```markdown
   ---
   name: <name>
   description: <description>
   type: <type>
   ---

   <body>
   ```

4. Update `MEMORY.md` in the same directory: create it if absent (no frontmatter — it is an index), then append `- [<name>](<filename>) — <description>` if a line referencing `<filename>` is not already present (idempotent).
5. Respond `201` with `{ name: filename, path }`. Errors: `400` (validation), `409` (file exists), `500` (IO).

Keep `runtime = "nodejs"` and the `NextResponse` pattern already in `route.ts`.

**Acceptance criteria**

- [ ] Clicking the new "+" reveals a form; submitting creates the file and the user immediately sees it selected and rendered in the viewer.
- [ ] File contents exactly match the frontmatter shape above; round-trip through `readMemoryFile` returns identical bytes.
- [ ] `MEMORY.md` gains exactly one new line per new file; submitting twice with the same filename returns 409 and does not double-append.
- [ ] Path-traversal attempts (`../escape.md`, `/etc/x.md`, `subdir/x.md`) are rejected with 400 by the server even if the client is bypassed.
- [ ] All four `type` values produce valid frontmatter.
- [ ] The page still reads existing memories correctly (no regression on the GET path).
- [ ] `npx tsc --noEmit` passes (note: the pre-existing `StatusLine` error in `app/page.tsx:19` is unrelated and may remain).

**Out of scope**

- Editing or deleting existing memories.
- Editing `MEMORY.md` directly through the UI.
- Reordering, tagging, or filtering.
- Hooking creation into the running Claude session — this is a manual-authoring tool only.

**Gotchas**

- This repo's Next.js has breaking changes from public docs; before adding the route handler, check `node_modules/next/dist/docs/` if anything in the route signature looks off (per `AGENTS.md`).
- Filename slug derivation should be deterministic and conservative — lowercase, replace non-`[a-z0-9]` runs with `_`, trim leading/trailing `_`, fall back to `memory` if empty.
- `autoMemoryDir(cwd)` may not exist yet on a fresh project; create it before writing.
- The existing list sorts by `modifiedMs` descending, so a freshly written file naturally lands at the top — no sort changes needed.
- Do not call `process.cwd()` from the client; the page already resolves `cwd` from `/api/sessions` and passes it down — reuse that.

### Send queued messages reliably when Claude finishes ✓ shipped earlier in session



**Goal** — While Claude is generating, the user should be able to type follow-up messages that are held back and dispatched once the current turn finishes. The skeleton for this exists; close the remaining gaps so the behavior is reliable, visible, and recoverable.

**Why** — Today the user can hit Enter mid-response and the message is silently appended to a queue. Drain happens on the SDK `result` event. But: (a) the queueing is invisible — the only on-screen button while pending is "interrupt", so the user has to *guess* that Enter still works; (b) drain only fires on `result`, so an interrupt or permission deny mid-turn leaves the queue stranded; (c) on a flush-time POST failure the loop falls through to the next message without backoff; (d) reloading the page wipes the queue. Each of these has bitten in real use.

**Current state — do not reinvent**

- `lib/client/use-session.ts` — `send()` auto-queues when `pendingRef.current` is true (line 711); `enqueue()` (line 734), `cancelQueued()` (line 742), and `flushQueue()` (line 151) already exist; `flushQueue()` is invoked from the SDK `result` handler (line 424).
- `components/chat/QueueIndicator.tsx` already renders queued items with cancel buttons.
- `components/chat/PromptInput.tsx` already shows the queue hint placeholder when `pending` is true.

**Files involved**

- `lib/client/use-session.ts` — fix flush triggers, flush-error handling, and add persistence hooks.
- `components/chat/PromptInput.tsx` — make the "queue while running" affordance explicit (visible button, not only Enter).
- `components/chat/QueueIndicator.tsx` — add edit + reorder controls.
- `lib/client/types.ts` — extend `QueuedMessage` if needed (e.g. `createdAt`, ordinal).

**Required changes**

1. **Visible queue button while pending.** In `PromptInput`, when `pending` is true, do *not* replace the send button with the interrupt button — render both: a primary "Queue ↵" button (e.g. `Hourglass` or `ArrowUpToLine` icon) for adding to the queue and a secondary interrupt button. Enter key keeps working too. Adjust the placeholder copy to confirm queueing on submit ("Queued — will send after current response").
2. **Flush on every transition out of `pending`, not just `result`.** Centralize: any code path that does `setPendingTracked(false)` should also `void flushQueue()`. That covers `interrupt()`, `error` events, and any future paths. (Keep the existing `result`-handler flush as belt-and-suspenders.)
3. **Robust flush loop.** In `flushQueue()`, if the POST fails, *stop draining* — re-prepend the failed message to the front of `queueRef`, surface the error, and do not auto-retry until the user takes action. Today the `while` falls through to the next message after a failure, which can double-send.
4. **Per-session persistence.** Persist `queueRef` to `sessionStorage` keyed by `sessionId` on every change; rehydrate on `bindToSession`. Wipe the entry on `resetState` for a different session. (Use `sessionStorage`, not `localStorage` — the queue should not survive a tab close.)
5. **Edit queued messages.** Clicking a queued chip in `QueueIndicator` populates the prompt textarea with its text *and removes it from the queue*. Implement via a new `editQueued(id)` action on the hook that returns the text and calls `cancelQueued`.
6. **Reorder queued messages.** Add up/down arrow buttons on each queued chip (HTML5 drag-drop is overkill). Hook action: `reorderQueued(id, dir: -1 | 1)`.
7. **Don't drain while a permission prompt is open.** If `pendingPermission` is non-null, treat the session as still busy — `flushQueue()` must check `pendingPermission == null` in addition to `!pendingRef.current`. Re-fire `flushQueue()` from `resolvePermission`'s success path.

**Out of scope**

- Coalescing multiple queued messages into one combined send (interesting but a separate UX call).
- Persisting across full browser close (localStorage) — explicitly excluded above.
- Server-side queue mirroring — keep the queue purely client-side for now.
- Editing/reordering a queued message *after* its POST has been initiated.

**Acceptance criteria**

- [ ] While `pending` is true, the prompt area shows both a visible "Queue" send affordance and the interrupt button; clicking Queue (or pressing Enter) appends to the queue and clears the input.
- [ ] Interrupting mid-response drains the queue automatically once `pending` flips to false.
- [ ] Resolving a permission prompt while messages are queued continues to drain them in order after the next `result`.
- [ ] If a `flushQueue` POST fails, the failed message is re-prepended to the queue, an error is shown, and *no further* queued messages are sent until the user retries (e.g. by interacting again).
- [ ] Reloading the page on the same session restores the queue exactly as it was; switching to a different session shows that session's queue (or empty).
- [ ] Clicking a queued chip moves its text into the prompt input and removes it from the queue list.
- [ ] Up/down arrows on a queued chip change its order; the next flush honors the new order.
- [ ] `npx tsc --noEmit` passes (the pre-existing `StatusLine` error in `app/page.tsx:19` is unrelated and may remain).

**Gotchas**

- `pendingRef` and `pending` are intentionally tracked as both ref and state via `setPendingTracked` — keep using that helper; don't introduce a parallel ref.
- The SDK can emit a `result` event with `subtype !== "success"` (e.g. error subtypes). The current code already calls `flushQueue` unconditionally in the `result` branch — preserve that behavior.
- `flushQueue` is async and re-entrant via the closure on `setPendingTracked`. Make sure the new "stop on failure" logic does not leave `pendingRef` true after a failed POST; the existing code already sets it false on error — keep that.
- This Next.js fork has breaking changes vs. public docs (`AGENTS.md`); no route handlers are added here, but if any are needed, check `node_modules/next/dist/docs/` first.

### Inline `[Image #N]` tokens in the prompt (Claude Code parity) ✓ shipped earlier in session



**Goal** — Match Claude Code's behavior: when an image is attached (paste / drop / picker), insert a `[Image #N]` token *at the caret* in the textarea. The token is the user-visible reference to that image inline in the prompt. The thumbnail preview row stays. On send, the message preserves the tokens in the text and the image bytes are passed alongside, so the model sees a multi-modal content array with text and image blocks interleaved at the right positions.

**Why** — Today the prompt's text and its attached images are decoupled: thumbnails sit above the textarea with no inline reference, and the user-message rendering shows a trailing `_(N images attached)_` badge. That diverges from Claude Code, where `[Image #N]` markers in the prompt tell the user (and the model) *where* in the message each image belongs. Without inline tokens, prompts like "compare A to B" with two images attached lose their ordering. Parity is the project's stated goal (see "Cross-cutting" verification, todo.md).

**Current state — do not reinvent**

- `components/chat/PromptInput.tsx` — paperclip button, drop, paste, and `<input type="file">` handlers all funnel through `ingestFiles()` (line 132); thumbnails render in a row above the textarea (line 187); `removeImage(i)` deletes by index (line 178).
- `lib/client/types.ts:131` — `AttachedImage = { data: string; mediaType: string }`. No id, no ordinal.
- `lib/client/use-session.ts:758` — `send(text, images)` POSTs `{ text, images }` as-is and renders the user message as `text + "_(N images attached)_"` badge (line 771).
- `app/api/sessions/[id]/input/route.ts` — passes `text` and `images` straight to `session.sendInput(text, images)`.

**Files involved**

- `components/chat/PromptInput.tsx` — token insertion, atomic delete, thumbnail/token sync.
- `lib/client/types.ts` — extend `AttachedImage` with a stable `id` and `ordinal`.
- `lib/client/use-session.ts` — keep tokens in `text` on send; replace the trailing badge with inline thumbnail rendering for the user message.
- `components/chat/UserMessage.tsx` (whichever component renders user `text` blocks) — split rendered text on `[Image #N]` and inline a thumbnail per token.
- `lib/server/session.ts` (or wherever `sendInput` shapes the SDK message) — translate `[Image #N]` markers in `text` into a multi-block Anthropic content array (`[{type:"text", text:"…before…"}, {type:"image", source:{…}}, {type:"text", text:"…after…"}]`). If the project already has a helper for SDK content shaping, extend it; otherwise add one.

**Required behavior**

1. **Token insertion at caret.** When an image is added via paste, drop, or picker, insert `[Image #N]` at the textarea's current caret position (with a single trailing space, mirroring Claude Code). Do *not* append at the end of the value. After insertion, place the caret immediately after the inserted token + space. If multiple files are added in one drop/paste, insert each token in order separated by spaces.
2. **Stable, monotonic numbering per prompt.** Each prompt has its own counter that starts at 1 and never decrements within that prompt's lifetime — removing image #2 does *not* renumber #3 down to #2. After the prompt is sent (or cleared), the counter resets. (This matches the screenshot: a single attached image showing `[Image #2]` after a prior #1 was removed.)
3. **Atomic token deletion.** Treat each `[Image #N]` substring as an atomic glyph. If the user presses Backspace with the caret immediately after a `]` of a known token, delete the entire token *and* remove the corresponding image from the attachments. Same with Delete when the caret sits immediately before `[`. Selecting across a token boundary deletes the whole token. (Implementation: an input-change handler that, after each keystroke, diffs the previous text against the new text — any of the tracked tokens that disappeared in full should drop their image; partial deletions inside a token's brackets should be auto-completed back to a full delete to keep state consistent.)
4. **Thumbnail X removes the token from text.** Today `removeImage(i)` only mutates the `images` array. It must also strip the matching `[Image #N]` substring (and a single neighboring space) from `value`.
5. **Bidirectional state.** `images` and the tokens in `value` must stay in sync. Source of truth: `images` is the canonical list (each with `id`, `ordinal`, `data`, `mediaType`); `value` references them by ordinal. Add an invariant assertion in dev: every `[Image #N]` in `value` corresponds to a known ordinal, and every `images[i].ordinal` appears at most once in `value`.
6. **Send shape.** On submit, send `{ text, images }` exactly as today *without stripping tokens* — the text the server receives literally contains `[Image #1]`, etc. Client-side `images` carries `id`, `ordinal`, `data`, `mediaType`.
7. **Server splits into multi-block content.** In `sendInput`, parse `text` for `[Image #N]` tokens, look up the corresponding image by ordinal in the `images` payload, and produce an Anthropic content array that interleaves text and image blocks in order. Tokens whose ordinal is not present in `images` are left as literal text (so a user typing `[Image #2]` manually doesn't break — fail-safe to text). Trailing/leading empty text segments are dropped.
8. **User-message rendering.** In the chat view, render the user message by splitting on `[Image #N]` and inlining a small thumbnail (similar style to the prompt's preview row, ~48px) where each token sits. Drop the existing `_(N images attached)_` trailing badge.
9. **Counter reset on send and on clear.** After `submit()`, after `setValue("")`, and after the prompt is queued (queue path) or cleared, reset the per-prompt counter to 1.
10. **Plays nicely with queueing.** A queued message keeps its tokens *and* its image payload until it's flushed (today the queue stores only `text` — extend `QueuedMessage` to optionally carry `images` so flushed messages remain multi-modal).

**Acceptance criteria**

- [ ] Pasting an image into an empty textarea produces `[Image #1] ` with the caret after the space; the thumbnail row shows one preview.
- [ ] Typing `I would like this `, then pasting an image, yields `I would like this [Image #1] ` (matches the second screenshot's pattern).
- [ ] Attaching two images in one drop yields `[Image #1] [Image #2] ` at the caret in that order.
- [ ] Removing an image via the thumbnail X removes its token from the text and leaves remaining tokens unchanged in numbering.
- [ ] Backspace immediately after a token's `]` removes the entire `[Image #N]` token and drops the matching image.
- [ ] Sending the prompt POSTs `text` containing the literal `[Image #N]` markers; the server emits an Anthropic content array of interleaved text + image blocks in order.
- [ ] Manually typing `[Image #99]` (with no matching attachment) is left as plain text on the wire and renders as plain text in the user message.
- [ ] The user-message bubble renders inline thumbnails at the token positions, not a trailing "_(N images attached)_" badge.
- [ ] Queueing a message-with-images while Claude is running, then letting it flush, sends the same text+images shape as a direct send would.
- [ ] `npx tsc --noEmit` passes (the pre-existing `StatusLine` error in `app/page.tsx:19` is unrelated and may remain).

**Out of scope**

- Drag-to-reorder thumbnails (with the matching token swap) — useful but a separate task.
- Inline image rendering inside *assistant* messages (this task only addresses user-authored prompts).
- Image compression / resizing client-side; keep the existing 20 MB cap.
- Persisting attached images in the per-session queue across page reload (the queue persistence task already in this file does not yet cover image payloads — call out and defer).

**Gotchas**

- Token regex: `/\[Image #(\d+)\]/g`. Match exactly; do not be tolerant of surrounding whitespace (Claude Code is precise here).
- The textarea is a controlled component — token insertion must use the current `selectionStart`/`selectionEnd` from the DOM ref, not assume end-of-value. After mutation, restore selection inside `requestAnimationFrame` to play nicely with React batching, mirroring the existing `insertAtMention` pattern in `PromptInput.tsx:100`.
- The `onChange` diff has to ignore IME composition events, otherwise mid-composition keystrokes can falsely "remove" a token. Gate the diff on `compositionend`-or-not.
- Clipboard pastes with `e.preventDefault()` already happen for image files (line 173); when there are also text items in the clipboard, fall through to the default text paste path so users can paste a URL alongside an image.
- The pre-existing `_(N images attached)_` badge is added in `use-session.ts:771` — replace it (don't dual-render).
- Multi-modal SDK content: confirm the exact shape the agent SDK expects for `image` blocks (`{type:"image", source:{type:"base64", media_type, data}}` per Anthropic spec). Per `AGENTS.md`, this Next.js fork has breaking changes — for SDK shape questions, check `node_modules/@anthropic-ai/claude-agent-sdk` types directly rather than public docs.

### Loop / Schedule — cron-driven prompt runs with output history ✓ shipped earlier in session



**Goal** — A first-class scheduling feature inside the web app. Users can define recurring jobs (a prompt or slash command + a cron expression), see them in a dedicated nav page, and inspect each run's output and status history. Mirrors the behavior the user already has from the host's `loop` / `schedule` skills, but lives inside Claudius and is independent of the harness.

**Why** — Today `/loop` and `/schedule` exist *only* as slash-command stubs in `lib/shared/slash-commands.ts:166-167` (`handler: "sdk"`, `category: "skill"`). They pass through to the SDK and have no UI surface, no persistence, no run history, no executor. The user wants a real, first-class scheduler with a friendly cron editor and visible history — not just a slash command that disappears into the chat transcript.

**Current state — do not reinvent**

- `lib/shared/slash-commands.ts:166` — `/loop` (argsHint `[interval] [prompt]`).
- `lib/shared/slash-commands.ts:167` — `/schedule` (alias `/routines`).
- `lib/server/session-manager.ts` — singleton holding live SDK queries; reuse to spawn one-shot sessions per scheduled run.
- `lib/server/sessions-store.ts` — JSONL/disk persistence patterns to mirror for jobs and run history.

**Files involved (new + modified)**

- `app/schedule/page.tsx` — new page (job list + editor + run history viewer).
- `app/api/schedule/route.ts` — CRUD: `GET` (list), `POST` (create).
- `app/api/schedule/[id]/route.ts` — `GET` (one), `PATCH` (update), `DELETE`.
- `app/api/schedule/[id]/runs/route.ts` — `GET` (run history for a job).
- `app/api/schedule/[id]/run-now/route.ts` — `POST` (fire immediately).
- `lib/server/scheduler.ts` — singleton: parses cron, schedules, dispatches a one-shot SDK session per fire, writes run records.
- `lib/server/scheduler-store.ts` — JSON-file persistence: jobs and runs (one file per job's history; capped).
- `lib/shared/cron.ts` — pure helpers: validate, describe, next-N-fires.
- `components/schedule/CronEditor.tsx` — friendly cron input with validation, human-readable description, and a "next 5 fires" preview.
- `components/schedule/JobList.tsx`, `components/schedule/RunHistory.tsx`, `components/schedule/RunDetail.tsx`.
- `components/nav/SideNav.tsx` — add a `Schedule` (Calendar / Clock icon) entry pointing to `/schedule`.

**Required behavior**

1. **Job model.** `Job = { id, name, cron, prompt, slashCommand?, model?, cwd, enabled, createdAt, updatedAt, lastRunAt?, nextRunAt?, lastStatus? }`. `cron` is a 5-field expression (`m h dom mon dow`); presets: every 5 min, hourly, daily 9am, weekdays 9am.
2. **Cron editor.** Single-line input + a row of preset chips that prefill it. Below the input, render two read-outs: a human-readable description ("Every 5 minutes, Mon–Fri, 9 AM–5 PM") and a list of the next 5 fire times in the user's local timezone. Invalid expressions show an inline error and disable Save. Use a small dependency for parsing — `cron-parser` (preferred, MIT, no native deps) for next-fire computation, and `cronstrue` for the human-readable description. Both must be added to `package.json` runtime deps.
3. **Scheduler runtime.** Singleton in `lib/server/scheduler.ts` initialized from a Next.js instrumentation hook (`instrumentation.ts` `register()`) so it boots once with the Next process. For each enabled job: compute next fire via `cron-parser`, set a `setTimeout` to that delta, on fire spawn a one-shot SDK session in the job's `cwd` with the configured prompt or slash-command, capture all events to a run record, then schedule the next fire. Re-arm timers on create/update/delete/enable/disable.
4. **Run record.** `Run = { id, jobId, startedAt, endedAt?, status: "running"|"success"|"error"|"cancelled", costUsd?, inputTokens?, outputTokens?, transcript: ServerEvent[] }`. Persisted under `~/.claude/projects/<encoded-cwd>/schedule/<jobId>/runs.jsonl` (append-only). Capped at 200 runs per job; older entries are rotated into `runs.archive.jsonl`.
5. **Run history UI.** Right pane on `/schedule` after selecting a job: timeline list of last N runs (status pill, started-at, duration, cost). Clicking a run opens a transcript viewer (reuse the chat `MessageList` rendering from a snapshot of `ServerEvent[]`).
6. **Run-now button.** On each job, a `▶ Run now` action calls `POST /api/schedule/:id/run-now`, which fires the dispatcher synchronously without disturbing the cron schedule.
7. **Enable/disable toggle.** Per-job switch on the list. Disabled jobs do not arm a timer.
8. **Crash recovery.** On scheduler boot, for each job recompute `nextRunAt` from `cron-parser` and arm. Do not back-fill missed runs (cron should be idempotent of process restarts).
9. **Concurrency.** Per-job mutex: if a previous run is still in progress when the next fire is due, mark a "skipped" run record with reason `previous_run_in_progress` rather than running two in parallel.
10. **Server contract.**
    - `POST /api/schedule` body: `{ name, cron, prompt | slashCommand, model?, cwd?, enabled? }`. Validates cron against `cron-parser`. 400 on invalid.
    - `PATCH /api/schedule/:id` body: any subset of editable fields.
    - `DELETE /api/schedule/:id` — also clears the job's runs file.
    - `GET /api/schedule/:id/runs?limit=50` — newest first.
    - `POST /api/schedule/:id/run-now` — 202 with the new `runId`.

**Acceptance criteria**

- [ ] New "Schedule" entry in `SideNav` opens `/schedule` with a list of jobs and an empty-state CTA when none exist.
- [ ] The cron editor shows a human-readable summary and the next 5 fires in local time; invalid input is flagged and Save is disabled.
- [ ] Creating a job persists it; restarting the dev server re-arms it without manual action.
- [ ] At fire time, a one-shot session runs in the configured `cwd`, captures all SDK events to a run record, and the result appears at the top of the job's run history within ~2s of completion.
- [ ] Clicking a run shows its full transcript using the existing chat rendering.
- [ ] `▶ Run now` dispatches a run immediately; the next scheduled fire still occurs at its original time.
- [ ] Disabling a job removes its timer; enabling re-arms it from "now".
- [ ] If a fire arrives while a previous run is in progress, a `skipped` record is written and the next fire is scheduled normally.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Multi-process / clustered schedulers — single Next.js process is the assumption (matches the rest of Claudius).
- Distributed locks. Per-process in-memory mutex is enough.
- Hard quotas on cost or tokens per job (defer to a later "spending limits" task — feeds into the Cost task below).
- Importing the host's existing `~/.claude/agents/routines/...` into Claudius.
- Per-run streaming UI — viewer only renders after the run completes.

**Gotchas**

- `cron-parser` parses 5-field expressions by default; document this in the editor (no seconds field). Reject 6-field input cleanly.
- Use `Intl.DateTimeFormat` with the browser's locale + tz for the next-fires preview (server returns ISO strings; client formats).
- `setTimeout` clamps at ~24.85 days. For sparse jobs, schedule a "rearm-only" wake at 24h max and recompute on each tick.
- Booting the scheduler from `instrumentation.ts` (Next 15): `runtime` must be `nodejs`. Confirm against `node_modules/next/dist/docs/` since this fork has breaking changes (`AGENTS.md`).
- Be careful spawning many sessions — reuse the existing `SessionManager` patterns to ensure `query()` AbortControllers are wired so a job can be cancelled mid-run.

---

### Cost — left-nav section with cross-session totals and a graph ✓ shipped earlier in session



**Goal** — A dedicated "Cost" nav entry with full-page detail: cumulative spend across *all* sessions in this project, a time-series chart of cost by day, a per-session breakdown table (sortable), a per-model breakdown, and live "today / week / month" tiles. Per-session cost is already tracked; this task aggregates it across the project and surfaces it as its own first-class page.

**Why** — Cost data is captured today only at the session level: `SessionUsage` accumulates from each SDK `result` event in `lib/client/use-session.ts:412-437`, the `CostOverlay` shows it per-session, and `StatusLine` shows the live `$X.XX`. Users have no way to see *project-level* spend, no chart over time, no comparison across sessions, and no breakdown by model. The user's intent is a left-pane "Cost" page that is fully populated with a graph and aggregate stats — a project-wide funds view, not just the current chat's tally.

**Current state — do not reinvent**

- `lib/client/types.ts:92-103` — `SessionUsage = { totalCostUsd, numTurns, durationMs, durationApiMs, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, modelUsage? }`.
- `lib/client/use-session.ts:412-437` — accumulates usage from SDK `result` events on the active session.
- `components/overlays/CostOverlay.tsx` — modal with the per-session breakdown (reuse the `Stat` component and `fmtUsd`/`fmtTokens`/`fmtMs` helpers).
- `components/chat/StatusLine.tsx:79-90` — clickable cost chip in the active chat.
- `lib/server/sessions-store.ts` — server-side sessions registry; the canonical place to derive cross-session totals from each session's persisted JSONL.

**Files involved (new + modified)**

- `app/cost/page.tsx` — new page.
- `app/api/cost/route.ts` — `GET` returns `{ totalUsd, byDay, bySession, byModel, todayUsd, weekUsd, monthUsd }`.
- `lib/server/cost-aggregate.ts` — reads `~/.claude/projects/<encoded-cwd>/*.jsonl`, scans for SDK `result` records, sums `total_cost_usd` and tokens, groups by ISO date and by `modelUsage` keys.
- `lib/client/useCost.ts` — fetches `/api/cost`, polls every 30s while the page is mounted.
- `components/cost/CostChart.tsx` — time-series bar/line chart of daily spend.
- `components/cost/SessionCostTable.tsx` — sortable list of sessions with `id`, `firstSeen`, `lastSeen`, `numTurns`, `totalCostUsd`, click-through to that session.
- `components/cost/ModelBreakdown.tsx` — per-model totals with input/output/cache token columns.
- `components/nav/SideNav.tsx` — add a `Cost` entry (DollarSign or BarChart3 icon).
- `components/overlays/CostOverlay.tsx` — add a "View all cost →" footer link to `/cost`.

**Required behavior**

1. **Aggregate source.** Walk every `*.jsonl` under `~/.claude/projects/<encoded-cwd>/` (mirrors how `sessions-store` already discovers sessions). For each file, stream-parse line by line (do not load whole file) and sum `total_cost_usd` and `usage.*` fields off `result` events. Group by the calendar date (`YYYY-MM-DD`) of the result event's timestamp in the server's local timezone.
2. **Cache.** Cache aggregation by `{ filePath, mtime, size }`. On `GET /api/cost`, only re-scan files whose mtime/size changed since last scan. Persist the cache to `~/.claude/projects/<encoded-cwd>/.claudius-cost-cache.json`.
3. **API response.**
   ```ts
   {
     totalUsd: number,
     todayUsd: number,
     weekUsd: number,            // rolling 7 days
     monthUsd: number,           // rolling 30 days
     byDay: { date: "YYYY-MM-DD", usd: number, inputTokens: number, outputTokens: number }[],
     bySession: { sessionId, firstSeenMs, lastSeenMs, numTurns, totalUsd, model? }[],
     byModel: { model: string, usd: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }[],
   }
   ```
4. **Page layout.** Single column, max width ~6xl:
   - **Top tiles** (4-up grid): Total · Today · Last 7d · Last 30d. Each shows the USD figure prominently and a faint sparkline below.
   - **Daily chart** (~280px tall): bars for `byDay` USD over the last 60 days, with hover tooltip showing tokens. Use a tiny dep (`recharts`, MIT) — already in the React 19 ecosystem; alternative is a hand-rolled SVG if we want zero extra deps. Pick `recharts` for v1 unless bundle-size is a stated concern.
   - **Per-session table**: paginated, sortable on each column, click row to open that session in the chat (`/?session=<id>`).
   - **Per-model breakdown**: small grid of cards.
5. **Side nav entry.** New "Cost" item between "Memory" and "Agents" with a `DollarSign` icon (or `BarChart3` if we want to avoid loaded symbolism). Wire it in the same `items` array used by `SideNav.tsx`.
6. **Linkage from existing surfaces.** The `CostOverlay` (the per-session modal) gets a footer link "View all cost →" that closes the overlay and routes to `/cost`. The `StatusLine` cost chip gains a right-click / shift-click affordance that goes to `/cost` (left-click still opens the per-session overlay, unchanged).
7. **Accuracy.** The page's "current session" row, when present, must reflect the same `SessionUsage` numbers shown by the live `CostOverlay` for that session — i.e. include in-flight cost, not just persisted JSONL. Mechanism: client merges `useCost()` aggregate with the live `useSession().usage` for the active `sessionId`.
8. **Empty state.** When no sessions have a cost record yet, show a tasteful empty card: "No spend recorded yet — your first turn will appear here."
9. **Account-wide usage link.** The page's figures are necessarily project-local (we aggregate this machine's JSONL files; the SDK does not expose account-wide spend — see the Admin API note below). To bridge that gap, surface a clearly-labelled external link to `https://claude.ai/settings/usage` for the user's full account usage. Place it in two spots: (a) a header chip on `/cost` next to the page title — "View account usage ↗" with `ExternalLink` icon, opening in a new tab (`target="_blank"` + `rel="noopener noreferrer"`); (b) a footer line under the per-model breakdown reading "Numbers above are this project, on this machine. For account-wide totals, see [your Anthropic usage dashboard ↗](https://claude.ai/settings/usage)." The Admin API (`sk-ant-admin...`) is the only programmatic source for account-wide totals and is gated to organization admins, so the link is the right answer for individual accounts; do not attempt to scrape or proxy it.

**Acceptance criteria**

- [ ] Clicking "Cost" in the side nav opens `/cost` and shows non-zero figures within ~1s for a project with prior sessions.
- [ ] The four tiles (Total, Today, 7d, 30d) sum correctly against a hand-checked subset of `*.jsonl` files.
- [ ] The daily chart renders ≥1 bar per day on which any session had a `result` event with `total_cost_usd > 0`; hovering shows that day's tokens.
- [ ] The per-session table is sortable on every column and rows link to the session.
- [ ] The per-model breakdown groups correctly for projects that have used multiple models in one or more sessions.
- [ ] On a 200-session project, `/api/cost` returns in under 500ms warm (cache hit) and under ~3s cold (full scan).
- [ ] Modifying or adding a session triggers an incremental re-scan only of changed files (verified by logging or by mtime tracking).
- [ ] The active session's contribution to today's total is live (matches `useSession().usage.totalCostUsd` for that session).
- [ ] The header chip and footer line both link to `https://claude.ai/settings/usage`, open in a new tab, and use `rel="noopener noreferrer"`.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Per-tool cost attribution (the SDK doesn't surface this granularly).
- Forecasting / projections.
- Hard spend limits or budgets (will be its own task; ties into the Schedule task's per-job quotas).
- Export to CSV (nice-to-have; defer).
- Cross-project (multi-cwd) aggregation. This page is project-scoped, mirroring the rest of Claudius.

**Gotchas**

- Some old `result` events may not have `total_cost_usd` populated — treat missing as 0, not as null/skip.
- `modelUsage` shapes have changed across SDK versions; defensively read `Object.entries(modelUsage)` and treat each value as `{ inputTokens?, outputTokens?, costUsd? }` with all fields optional.
- Calendar-day grouping must use a consistent timezone (server local) — document this on the page so users don't get confused when comparing to the SDK's UTC timestamps.
- `recharts` adds ~100 KB gzipped; if that's unacceptable, swap for a hand-rolled `<svg>` bars component (rectangles + axis ticks). Decision: start with `recharts` for shipping speed, revisit if bundle size budget is tightened.
- The cache file (`.claudius-cost-cache.json`) lives inside `~/.claude/projects/<encoded-cwd>/` — make sure it's filtered out of session listings in `sessions-store.ts` so it doesn't appear as a phantom session.

### Favicon — Old Italic 𐌂 on the accent badge ✓ shipped earlier in session



**Goal** — Replace the default Create-Next-App favicon with a tile that matches the in-app brand mark: the orange (`--accent` `#d97757`) rounded square already used in the side nav, with the Old Italic letter 𐌂 (U+10302) centered in white. Reference: the user-provided `image-cache/.../3.png` mockup. The tile should be visually identical to the static-state badge rendered by `AnimatedGlyph` in `components/nav/SideNav.tsx`.

**Why** — Today the tab favicon is the stock Next.js scaffold icon (`app/favicon.ico`, untouched since `Initial commit from Create Next App`, see `git log f20c0c2`). The product already has a deliberate brand mark in the side nav; the favicon should match so browser tabs, history, and bookmarks read as Claudius rather than Next.

**Files involved**

- Delete: `app/favicon.ico` (legacy stub).
- New: `app/icon.svg` — primary tile, used at all sizes by modern browsers. Keep it ~64×64 viewport with the path data so OS rasterizers downscale crisply to 16/32/48.
- New: `app/apple-icon.png` (180×180) — iOS home-screen tile, generated once from the SVG at design time and committed (PNG with alpha; iOS still ignores transparency on home screen and fills its own background, but PNG is the format Next looks for at this filename).
- No `app/layout.tsx` change — Next 15 auto-discovers `app/icon.{svg,png,…}` and `app/apple-icon.{png,jpg}` (see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md` for the exact filename rules in this fork).

**Required behavior**

1. **Tile.** Solid `#d97757` background, full-bleed; corner radius ~22% of side length (matches the side-nav badge's rounded-md feel scaled to a square tile). No drop shadow, no border, no inner padding — the rounded square is the whole asset.
2. **Glyph.** The Old Italic letter 𐌂 (U+10302), centered both axes, white (`#ffffff`), occupying ~55–60% of the tile height. **Render it as a `<path>` outline, not as a `<text>` glyph** — favicons are fetched as standalone assets and rasterized by browsers/OSes that may not have a font with Plane-1 (Old Italic) coverage; a `<text>` element will tofu on those systems. Hand-trace or export the path from a font that ships 𐌂 (Noto Sans Old Italic, OFL — see `https://fonts.google.com/noto/specimen/Noto+Sans+Old+Italic`); the glyph is morphologically a "C" with a slight asymmetry — keep that asymmetry in the trace so it doesn't read as a generic Latin C.
3. **SVG shape.**
   ```svg
   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
     <rect width="64" height="64" rx="14" ry="14" fill="#d97757"/>
     <path d="… 𐌂 outline …" fill="#ffffff"/>
   </svg>
   ```
   Keep the `viewBox` 64×64 so corner radius math (rx=14 ≈ 22%) is easy to read.
4. **Apple icon.** Render the same SVG at 180×180 to PNG once (e.g. via `sharp` or any rasterizer of choice — *not* a runtime build step) and commit `app/apple-icon.png`. Do *not* round the corners on the PNG — iOS applies its own mask. Solid `#d97757` to the edges.
5. **No dynamic route.** Use the static-file form (`app/icon.svg`), not `app/icon.tsx` with `ImageResponse`. Reasons: (a) `next/og`'s ImageResponse server-side rasterizes via a font subsetter and reliably struggles with Plane-1 codepoints; (b) the asset is static — there's no runtime input to justify dynamic generation; (c) static SVG caches forever and renders crisply at every size.

**Acceptance criteria**

- [ ] Browser tab shows the orange 𐌂 tile in Chrome, Firefox, and Safari at 16×16 and 32×32.
- [ ] On a freshly cleared cache, no Next.js scaffold favicon appears anywhere; `app/favicon.ico` is removed from the repo.
- [ ] The favicon's color, corner radius, and glyph proportion visually match the static-state badge in `SideNav.tsx` when the side nav and a browser tab are placed side-by-side.
- [ ] The 𐌂 glyph renders as the historic Old Italic letter (slight asymmetric C), not a generic Latin C, on a system without an Old Italic font installed (verify in a clean container/VM if possible — the path-based approach is what guarantees this).
- [ ] iOS "Add to Home Screen" produces an icon with a solid orange tile and the 𐌂 glyph (no transparent corners visible after iOS's mask is applied).
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Light/dark theme variants of the favicon (browsers don't switch by theme; one mark for both).
- Animated favicon (the side-nav animation while Claude is running stays in-app only — animating the tab icon would be visually noisy).
- A separate "maskable" PWA icon manifest entry. If/when a `manifest.json` is added (PWA work is not currently in `todo.md`), revisit.
- Re-doing the SideNav badge — leave `AnimatedGlyph` and its CSS alone. This task only touches favicon assets.

**Gotchas**

- Per `AGENTS.md`, this Next.js fork has breaking changes vs. public docs — confirm the exact icon-file conventions in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md` before relying on filenames or behavior from training data.
- Do not commit a copy of the upstream Next favicon as a "fallback" — the legacy `app/favicon.ico` takes precedence over `app/icon.svg` in some toolchains, so it must be deleted, not overwritten.
- When tracing 𐌂 from Noto Sans Old Italic, preserve OFL attribution in a comment at the top of `app/icon.svg` (the path is a derivative work). One short HTML comment is enough; don't ship the full license text in the asset.
- 16×16 rendering is the toughest size — if the path's stroke/curve detail muddies at that scale, simplify the trace until the C-form reads cleanly. A 1–2 px hinted nudge on the inner curve endpoints is fine.

### Files / Assets — content-addressed store with a SQLite index ✓ shipped earlier in session



**Goal** — A new "Files" left-nav section that lists every image and file the user has ever uploaded, scoped two ways: **Project** (just this cwd) and **Account** (every project under `~/.claude/projects/*/` on this machine). Each asset shows preview, size, dimensions, first/last seen, and the sessions it appears in (click-through). Underpins this with a small local SQLite database used as a *metadata index* (not source-of-truth) and a content-addressed file store on disk.

**Why** — Today every uploaded image is inlined as base64 directly in the SDK's JSONL transcripts (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`). That has three problems: (a) no way to *list* what you've uploaded short of scanning every JSONL byte-for-byte, (b) every duplicate paste of the same screenshot is stored again at full size — JSONL transcripts bloat fast, (c) cross-session and cross-project queries ("show me all PDFs I've sent this month") are O(scan-everything). A separate content-addressed store with a thin SQL index gives us a list page, dedupe, and fast cross-cutting queries — without changing the SDK's persistence.

**Architecture decision — DB as index, not source-of-truth**

- **Source of truth stays the filesystem.** Each unique upload is written once to `~/.claude/projects/<encoded-cwd>/assets/<sha[:2]>/<sha>.<ext>` (content-addressed by SHA-256). JSONL transcripts continue to contain the inlined base64 (we don't mutate SDK output). Deleting the DB at any time and rebuilding from the JSONLs + the assets/ directory must produce identical results.
- **SQLite is purely an index.** Use `better-sqlite3` (already flagged in the original plan, line 285 of this file). Synchronous, embedded, zero-config, fast for our scale (≤100k rows). One DB file per project: `~/.claude/projects/<encoded-cwd>/.claudius.db`.
- **Account-scope is a fan-out, not a separate DB.** "Account" view reads each project's `.claudius.db` in turn (or, if absent, walks the JSONL and ingests on the fly with a progress UI). No global DB.
- **Why not Drizzle/Prisma/Kysely.** They each add toolchain weight (migrations runner, codegen, schema DSL) for what is at most three tables. Prepared statements via raw `better-sqlite3` are clearer here.

**Files involved (new + modified)**

- `lib/server/db.ts` — singleton `Database` instance per project cwd; runs migrations on open.
- `lib/server/asset-store.ts` — write-by-hash to disk, read by hash, list, delete.
- `lib/server/asset-ingest.ts` — extract assets from an incoming `sendInput` payload; record uses; backfill scanner that walks a session's JSONL.
- `lib/server/db-migrations/001_init.sql` (or inline in `db.ts`) — schema below.
- `app/api/sessions/[id]/input/route.ts` — call `assetIngest.recordSendUses(...)` after `session.sendInput(...)` succeeds.
- `app/api/assets/route.ts` — `GET ?scope=project|account&type=image|file&q=…&limit=…&cursor=…` returns paged metadata.
- `app/api/assets/[hash]/route.ts` — `GET` streams the raw file (with `Content-Type` from `mediaType`); `DELETE` removes it from disk + the index.
- `app/api/assets/[hash]/uses/route.ts` — `GET` returns `{ sessionId, messageUuid, occurredMs }[]` for the modal "appears in" list.
- `app/files/page.tsx` — the new page.
- `components/files/FileGrid.tsx`, `components/files/FileDetail.tsx` — grid view + detail modal.
- `lib/client/useAssets.ts` — hook fetching `/api/assets`.
- `components/nav/SideNav.tsx` — add "Files" entry (icon: `Image` or `Folder`) between "Memory" and "Cost".

**Schema (SQLite)**

```sql
CREATE TABLE IF NOT EXISTS assets (
  hash         TEXT PRIMARY KEY,           -- sha256 hex of raw bytes
  media_type   TEXT NOT NULL,              -- e.g. "image/png", "application/pdf"
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,                    -- images only; null for PDFs/etc
  height       INTEGER,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_last_seen ON assets(last_seen_ms DESC);
CREATE INDEX IF NOT EXISTS idx_assets_media     ON assets(media_type);

CREATE TABLE IF NOT EXISTS asset_uses (
  asset_hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  message_uuid TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,           -- the [Image #N] ordinal in that message
  occurred_ms  INTEGER NOT NULL,
  PRIMARY KEY (asset_hash, session_id, message_uuid, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_uses_session    ON asset_uses(session_id);
CREATE INDEX IF NOT EXISTS idx_uses_occurred   ON asset_uses(occurred_ms DESC);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- key='version' tracks current migration applied
-- key='last_jsonl_scan_<sessionId>' tracks last (mtime,size) per session for incremental ingest
```

**Required behavior**

1. **Ingest path on send.** When `POST /api/sessions/:id/input` receives `{ text, images: [{data, mediaType}] }`, after a successful `session.sendInput`, run `assetIngest.recordSendUses({ sessionId, messageUuid, images })`: SHA-256 each `data`, write to the content-addressed store if absent, decode `width/height` for images via a tiny header parser (or a small dep — `image-size`, MIT, no native deps — preferred), upsert the `assets` row, insert one `asset_uses` row per image with ascending `ordinal`. Failures here must *not* fail the send — log + continue.
2. **Backfill.** First time the Files page is opened for a project, run a one-shot scanner that walks every `*.jsonl` under that project, finds image content blocks (`type:"image", source.data:<base64>`), and ingests them. Track per-session `last_jsonl_scan` `(mtime, size)` in `schema_meta` so subsequent opens only re-scan changed files. Emit progress over SSE while running; the page renders incrementally.
3. **List API.** `GET /api/assets?scope=project|account&type=image|file&q=&limit=60&cursor=` returns `{ items: AssetRow[], nextCursor? }` ordered by `last_seen_ms DESC`. `q` matches the asset hash prefix or session id (cheap LIKE). `account` scope iterates every project DB (open read-only, union, sort, paginate in JS — 60-row pages keep this trivially fast even at 100+ projects).
4. **Detail.** Click a tile → modal with preview (image inline; PDF as a "Open ↗" link), metadata (hash, size, dimensions, first/last seen), and "Appears in" — list of sessions with timestamp, click-through to `/?session=<id>&at=<messageUuid>`.
5. **Delete.** `DELETE /api/assets/:hash` removes the file from disk and the row from the index. *Does not* mutate JSONL transcripts (those still contain the base64 — deleting the local asset just discards the dedup blob and the index entry; if a session is later resumed, the SDK has the bytes inline and will work, but our gallery will re-ingest the asset on next backfill). Note this clearly in the delete confirmation: "Removes from your file gallery. Conversations that included this file are unaffected."
6. **Side nav.** New "Files" entry with `Image` icon (or `Folder` if we want to imply non-image too). Active when `/files` route matches.
7. **Empty / loading states.** Empty: "No files yet — paste or drop images into a chat to see them here." Loading: shimmer grid while the first scan runs; show a subtle progress strip ("Indexing 12 / 47 sessions…").
8. **Generalize beyond images.** PDF and other file types are sometimes supported by Anthropic models (document content blocks). Today the prompt only accepts images (`f.type.startsWith("image/")` in `PromptInput.tsx:136`); this task does *not* expand the prompt input — it just structures the storage so a future "accept PDFs" task only has to flip the input filter, with no further plumbing. Schema column `media_type` and the type filter on the page anticipate this.

**Acceptance criteria**

- [ ] New "Files" item in `SideNav` opens `/files`. Empty-state copy renders for fresh projects.
- [ ] Sending a prompt with one or more images results in (a) the file present in `assets/<sha[:2]>/<sha>.<ext>`, (b) one `assets` row per unique hash, (c) one `asset_uses` row per occurrence with the right `ordinal`.
- [ ] Sending the *same* image twice produces only one file on disk and one `assets` row, but two `asset_uses` rows.
- [ ] Opening the Files page on a project with prior sessions (no DB yet) backfills correctly: total tile count equals the number of unique image hashes across all that project's JSONLs.
- [ ] Re-opening the Files page after the backfill is fast (< 200ms) — no JSONL is re-scanned unless its mtime/size changed.
- [ ] Toggling "Account" scope shows files from every project under `~/.claude/projects/*/` that has been opened in Claudius (i.e., has a `.claudius.db`); projects without a DB show a "Click to index" affordance.
- [ ] The detail modal lists the sessions an asset appears in and clicking a row navigates to `/?session=<id>&at=<messageUuid>`.
- [ ] Deleting an asset removes the file and its index rows, but the source session can still be opened and renders without errors (the inline base64 in the JSONL is still intact).
- [ ] DB lives at `~/.claude/projects/<encoded-cwd>/.claudius.db`; deleting it and re-opening the Files page rebuilds the index identically.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Cloud sync of assets across machines.
- Editing or annotating assets.
- Server-side resizing / thumbnail generation (browsers handle this well at gallery sizes via `<img>`+CSS for the file sizes we expect).
- A full ORM or migration runner — keep migrations as numbered SQL files run in order on `Database` open.
- Re-writing the SDK's JSONL persistence to point at the asset store. The SDK is opaque; we layer on top.
- Encrypting assets at rest. Defer to OS-level disk encryption.

**Gotchas**

- **`better-sqlite3` is a native module.** It must build for the running Node version on `npm install`. CI image / docker image needs a toolchain (`make`, `python`, `g++`). On Apple Silicon dev machines this is fine out of the box. Document this in `package.json` install hooks if it bites.
- **Concurrency.** `better-sqlite3` is synchronous; multiple Next route handlers running in parallel will serialize through the DB. That's actually desirable for our scale and avoids a connection pool. Use a single shared `Database` instance per project, opened lazily on first request.
- **Account-scope cross-project reads.** Open each project's DB in `readonly` mode for the account view to prevent accidental writes through the wrong DB handle.
- **Hash collisions.** SHA-256 is fine; do not switch to a shorter hash for "performance" — the file path uses the first two hex chars as a directory shard, so the full hash is the actual filename and identity.
- **Backfill on huge JSONLs.** Stream-parse line by line (we already do this for cost aggregation); never `JSON.parse` the whole file. For each line, only extract image content blocks and discard the rest immediately so memory stays flat.
- **Per `AGENTS.md`, this Next.js fork has breaking changes** — confirm route handler patterns and `runtime: "nodejs"` requirements in `node_modules/next/dist/docs/` before adding the new routes.
- **Privacy framing in copy.** The Files page exposes everything ever uploaded across every project on this machine. Add a one-line disclaimer at the top of the Account tab: "Local to this machine. Nothing is uploaded — these are the files Claudius has indexed from `~/.claude/projects/`."

> **Naming overlap with the Workspaces task below:** rename this task's user-facing label from "Files" to **"Assets"** to free "Files" for the workspace-scoped filesystem browser introduced in the next task. Internal route and code paths can stay as-is or migrate to `/assets` for clarity — implementer's call.

### Workspaces — Slack-style switcher pane scoping sessions, files, and everything else ✓ shipped earlier in session



**Goal** — A new leftmost vertical pane (à la Slack's workspace switcher) where each entry is a project root. Selecting a workspace scopes everything in the app: new sessions are created with that workspace's root as `cwd`, the Sessions list shows only sessions for that root, the Cost / Assets / Memory pages aggregate within that root, and a new "Files" entry in the existing side nav opens a filesystem browser for the workspace. Each workspace has a name, a root folder, and an icon — either an uploaded image or a letter rendered on a colored tile (defaults to first letter of the name on a deterministic color).

**Why** — Today Claudius has an implicit single workspace: whatever `process.cwd()` happens to be when `next dev` is run (or whatever cwd the user passes per session). There is no way to switch projects without restarting, no UI to manage multiple roots, and every cross-cutting page (Cost, Memory, Assets) silently scopes itself to the active cwd with no chrome saying which one. A first-class Workspaces concept makes "open a session in `~/work/foo`" and "switch to `~/work/bar`" a one-click affordance, and gives every other scoped feature a clear "this workspace / all workspaces" toggle.

The plumbing is half-built: `CreateSessionRequest` already accepts `{ cwd }` (`lib/shared/events.ts:53`), `POST /api/sessions` forwards it (`app/api/sessions/route.ts:15`), and listed sessions already carry `cwd` (`app/api/sessions/route.ts:29`). Workspaces are essentially "named, persistent, switchable cwds with an icon."

**Files involved (new + modified)**

- `lib/server/workspaces-store.ts` — registry CRUD; persists to `~/.claude/.claudius/workspaces.json`.
- `lib/server/active-workspace.ts` — read/write the active workspace id from a `claudius.workspace` cookie.
- `app/api/workspaces/route.ts` — `GET` (list), `POST` (create).
- `app/api/workspaces/[id]/route.ts` — `GET`, `PATCH` (rename, change icon, change root), `DELETE`.
- `app/api/workspaces/[id]/select/route.ts` — `POST` sets the cookie to this workspace id.
- `app/api/workspaces/[id]/files/route.ts` — `GET ?path=&depth=` returns a directory listing (lazy / depth-limited).
- `app/api/workspaces/[id]/icon/route.ts` — `POST` accepts an image upload (multipart or base64), stores it under `~/.claude/.claudius/workspace-icons/<workspaceId>.<ext>`; `GET` streams it.
- `lib/client/useWorkspaces.ts` — list, create, rename, set-active hook.
- `components/nav/WorkspaceSwitcher.tsx` — the new leftmost pane.
- `components/workspaces/WorkspaceForm.tsx` — create / edit modal (name, root path with picker, icon).
- `components/workspaces/WorkspaceIcon.tsx` — renders image or letter-on-color tile; reused everywhere a workspace appears.
- `components/files/FileTree.tsx` — workspace-scoped filesystem browser (the new "Files" side-nav entry).
- `app/files/page.tsx` — page that hosts the tree.
- `components/nav/SideNav.tsx` — add "Files" entry (icon: `FolderTree` or `Folder`); badge the existing entries when active workspace is set.
- `app/page.tsx` — re-do the layout so the order is `WorkspaceSwitcher | SideNav | main`.
- `lib/server/session-manager.ts` (and `app/api/sessions/route.ts`) — when creating a session without an explicit `cwd`, fall back to the active workspace's root *before* falling back to `process.cwd()`.
- `app/api/sessions/route.ts` — accept `?workspaceId=` to filter the list to sessions whose `cwd === workspace.rootPath`.

**Storage shape**

```jsonc
// ~/.claude/.claudius/workspaces.json
{
  "version": 1,
  "activeId": "wks_abc",                          // hint only; cookie is authoritative
  "workspaces": [
    {
      "id": "wks_abc",
      "name": "Claudius",
      "rootPath": "/Users/filipegarcia/Projects/claudius",
      "icon": { "kind": "letter", "letter": "C", "color": "#d97757" },
      // OR: { "kind": "image", "ext": "png" }   // file at workspace-icons/<id>.png
      "createdAt": 1746576000000,
      "updatedAt": 1746576000000,
      "lastOpenedAt": 1746576000000
    }
  ]
}
```

The directory `~/.claude/.claudius/` is the "this app's user-scoped state" home — distinct from `~/.claude/projects/<encoded-cwd>/` which the SDK owns. Create it lazily.

**Required behavior**

1. **Layout.** Three-column shell: `WorkspaceSwitcher` (~56 px) on the left, the existing `SideNav` (~56 px) next, then the chat. The switcher is always visible; the SideNav's items operate on the *active* workspace.
2. **Switcher contents.** Vertical list of workspaces (top to bottom), each rendered via `WorkspaceIcon` at ~40 px squared with rounded corners. Active workspace shows a thin accent-color bar on the left (Slack-style indicator). Below the list: a `+` button to create a new workspace. Hover tooltip per tile shows name + root path. Drag-to-reorder is *out of scope* for v1 (call out).
3. **Icons.**
   - **Image**: PNG/JPG/WebP under 2 MB. Stored at `~/.claude/.claudius/workspace-icons/<id>.<ext>`. Served via `GET /api/workspaces/:id/icon`. The form previews the image before save.
   - **Letter**: defaults to first non-whitespace character of `name` (uppercased), color picked deterministically from a fixed 8-color palette via `hash(id) % 8`. User can override letter and color in the form.
   - `WorkspaceIcon` accepts the workspace object and chooses image-or-letter automatically. Same component used in the switcher, in the form preview, in the Sessions list rows, and anywhere else a workspace is referenced.
4. **Active workspace = cookie.** `claudius.workspace=<id>` cookie set on `POST /api/workspaces/:id/select`. Server reads it via `cookies()` from `next/headers` to provide a default `cwd` for session creation and to filter list endpoints. Cookie is httpOnly: false so the client can read it for optimistic UI; SameSite=Lax. Surviving page reload is the whole point.
5. **Session creation default.** When `POST /api/sessions` body has no `cwd`, look up the active workspace from the cookie and use its `rootPath`. If no active workspace and no cwd, fall back to `process.cwd()` (today's behavior). Document that fallback explicitly in the route handler.
6. **Sessions list filter.** `GET /api/sessions` accepts `?workspaceId=`. Filters to sessions whose `cwd === workspace.rootPath`. The Sessions page passes the active workspace id by default; an "All workspaces" toggle removes the filter.
7. **Files tree page.** New `/files` page (the user-facing label for the side-nav entry). Renders a lazy directory tree rooted at the active workspace's `rootPath`. `GET /api/workspaces/:id/files?path=&depth=1` returns `{ entries: [{ name, kind: "file"|"dir", sizeBytes?, modifiedMs }] }`. Click a directory to expand (separate request for that subpath). Click a file to preview if text/image, otherwise show metadata. **Read-only in v1** — no editing, renaming, or moving. Use the existing `@`-mention infra (`AtMentionPicker` already walks the cwd) as a reference for traversal patterns; do *not* reuse the picker UI directly.
8. **Path safety.** All `?path=` parameters in `/api/workspaces/:id/files` must be `path.resolve`'d against the workspace's `rootPath` and **rejected with 400 if the resolved path is outside the root**. Symlinks: follow within-root, refuse cross-root. This is the security boundary; do not skimp.
9. **First-run experience.** On first launch with no `workspaces.json`, auto-create a single workspace named after the basename of `process.cwd()`, with `rootPath = process.cwd()` and a letter icon. Mark it active. This preserves the current "just works" feel.
10. **Cross-cutting integration.** The Cost task and the Assets task (renamed above) both have `scope: project | account` toggles in their specs. Re-frame those to `scope: workspace | all` so the language matches the new chrome. Same data, clearer copy.

**Server contract**

- `POST /api/workspaces` body: `{ name, rootPath, icon }`. Validates `rootPath` exists and is a directory. 400 if not.
- `PATCH /api/workspaces/:id` body: any subset of `{ name, rootPath, icon }`. Renaming the root is allowed but warned in the UI (existing sessions are *not* moved; they remain bound to their original cwd, so they'll appear in the workspace under the *old* root and disappear after rename — surface this in the confirm dialog).
- `DELETE /api/workspaces/:id` removes the registration only; *does not* touch the folder or `~/.claude/projects/<encoded-cwd>/`. If the deleted workspace was active, server clears the cookie and the next request falls back to first-in-list.
- `POST /api/workspaces/:id/select` writes the cookie. Idempotent.
- `GET /api/workspaces/:id/files?path=&depth=1` — see Path safety above. Default `depth=1`. Hard-cap at `depth=3` to avoid runaway tree responses.

**Acceptance criteria**

- [ ] On a fresh install, opening Claudius shows a single auto-created workspace whose root is `process.cwd()` and whose icon is the basename's first letter on a deterministic palette color.
- [ ] Clicking `+` opens a form to create a new workspace; supplying a name, picking a folder, and saving makes the new workspace appear in the switcher and become active.
- [ ] Switching workspaces (clicking a different tile) reloads the chat shell with: an empty/new session bound to that workspace's root, the Sessions list filtered to that root, and the active indicator on the new tile.
- [ ] Creating a new session without specifying a cwd uses the active workspace's `rootPath`.
- [ ] The Sessions list filter respects `?workspaceId=` and shows only sessions with the matching `cwd`.
- [ ] The new "Files" entry in the side nav opens a directory tree rooted at the active workspace; clicking directories lazy-loads children; trying to traverse outside the root via `..` returns 400.
- [ ] Uploading a 1 MB PNG as an icon stores it under `~/.claude/.claudius/workspace-icons/<id>.png` and the switcher tile shows the image.
- [ ] Removing the icon (or never setting one) falls back to the deterministic letter+color tile.
- [ ] Cookie `claudius.workspace` survives a hard reload and selects the same workspace as before.
- [ ] Deleting a workspace removes only the registration; `~/.claude/projects/<encoded-cwd>/` is untouched and re-creating a workspace with the same root makes the old sessions reappear.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Drag-to-reorder workspaces in the switcher.
- Multiple users / shared workspaces / sync across machines.
- Editing files in the tree (read-only browser only — write features are a separate task).
- Auto-detecting projects on disk and offering them as workspaces ("scan `~/work/` and propose entries"). Nice-to-have, defer.
- Per-workspace settings overrides (model, permission mode). Today these are session-level; a per-workspace defaults layer is a follow-up task.
- Worktree integration (`git worktree list`) — already a phase 15 item in this file; layer on top of workspaces later.

**Gotchas**

- Cookie scope is per-origin. If the user runs Claudius on multiple ports, each is a separate active-workspace state. Probably fine; document it.
- `workspaces.json` is shared across processes if the user runs two Claudius instances pointing at different ports. Read-modify-write must be atomic — use a temp-file + rename pattern, and handle `ENOENT` on read.
- Session bound-to-cwd is permanent (the SDK encodes cwd into the JSONL filename via `encodeProjectDir`, see `lib/server/auto-memory.ts:10`). Renaming a workspace's `rootPath` therefore *strands* its existing sessions under the old encoding. Either disable root edits in v1 (simplest), or warn explicitly and let the user choose. Spec above takes the warn-and-allow path.
- The `ProfilePicker` icon-upload form should sanitize image MIME (`image/png|jpeg|webp`) and re-extension on save based on detected type, not the upload's filename — guards against `.png` files that are actually HTML.
- Per `AGENTS.md`, this Next.js fork has breaking changes — confirm `cookies()` API and route-handler conventions in `node_modules/next/dist/docs/` before wiring the cookie machinery.
- The new layout adds 56 px of left chrome on top of the existing 56 px side nav. On narrow viewports (≤1024 px) consider auto-collapsing the switcher to a hamburger; spec it later but don't paint yourself into a corner now.

### Session open — anchored at bottom, paginated upward (reverse infinite scroll) ✓ shipped 2026-05-08



**Goal** — When a session is opened (or resumed), only the **last 20 messages** are rendered, the view is scrolled to the bottom, and the prompt is in focus. As the user scrolls up, additional pages of **50 older messages** load progressively until the head of the transcript is reached. Pagination is server-driven (the SDK transcript stays on the server; the client never holds the whole thing). Live SSE messages continue to land at the bottom. The viewport must not jump when older messages are prepended.

**Why** — Today on session open the server replays the *entire* transcript via SSE and the client renders all of it as a flat list. Two bugs follow: (a) on long sessions (hundreds of messages, sometimes thousands) the open is slow and memory-heavy; (b) `MessageList.tsx:31-33` auto-scrolls to the bottom with `behavior: "smooth"` on *every* message/pending/system-entries change — so during a resume replay the view is constantly chasing the tail and the user sees a long animated scroll instead of an instant "I'm at the bottom of my last conversation" feel. The user wants an instant bottom-anchored open, with older history available on demand by scrolling up.

**Current state — do not reinvent**

- `lib/client/use-session.ts:88` — `messages: DisplayMessage[]` is the single client array; SSE handlers append to it.
- `lib/client/use-session.ts:472` — comment "Surface user messages from a resumed transcript so the chat shows history" confirms full-transcript SSE replay on resume.
- `components/chat/MessageList.tsx:30-33` — single `endRef` + `scrollIntoView({ behavior: "smooth" })` on every prop change.
- `lib/server/session.ts` already exposes a session object backed by the SDK; the SDK persists the transcript as `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. Tail-N reads on that file are cheap.

**Files involved (new + modified)**

- `lib/server/session-manager.ts` and/or `lib/server/session.ts` — add a "tail mode" for new SSE bindings: instead of replaying the whole JSONL, replay only the last N messages.
- `app/api/sessions/[id]/stream/route.ts` — accept `?tail=20` query param; default 20.
- `app/api/sessions/[id]/transcript/route.ts` — new endpoint: `GET ?before=<uuid|messageIndex>&limit=50` returns an older page of messages plus a cursor.
- `lib/client/use-session.ts` — add `loadOlder()` action, `hasMoreAbove: boolean`, dedupe-on-prepend by uuid, and `bindToSession` passes `?tail=20` on stream open.
- `components/chat/MessageList.tsx` — sentinel for "load older", scroll-anchor preservation, "near bottom" tracking, "↓ N new messages" pill, kill the smooth-scroll-on-every-render behavior.
- `lib/client/types.ts` — extend `ChatState` with `hasMoreAbove`, `loadingOlder`; extend `ChatActions` with `loadOlder()`.

**Required behavior**

1. **Initial replay = tail 20.** On session open, the SSE stream replays only the last 20 *user/assistant* messages from the JSONL (system entries and tool_results that belong to those messages come along). Server emits a `replay_done` event when the tail is finished so the client can mark "ready, anchored". Page count `tail` is configurable but defaults to 20.
2. **Bottom-anchored open.** When the SSE stream emits `replay_done`, the client immediately jumps to the bottom **without animation** (`behavior: "auto"`, not `"smooth"`) and focuses the prompt input. No "scroll chasing the tail" during replay.
3. **`loadOlder()` action.** Client method that calls `GET /api/sessions/:id/transcript?before=<oldestUuidInState>&limit=50`. Server returns `{ messages: DisplayMessage[], systemEntries: SystemEntry[], hasMore: boolean }` ordered oldest-first. Client *prepends* them to `messages`/`systemEntries`, deduping by uuid (an SSE message and a JSONL message with the same uuid is the SSE one — preserve `streaming` flags etc.).
4. **Trigger via IntersectionObserver.** Place a sentinel `<div ref={topSentinel} aria-hidden style="height:1px"/>` at the top of the rendered list. An `IntersectionObserver` with `rootMargin: "200px 0px 0px 0px"` fires `loadOlder()` when the sentinel enters or is about to enter the viewport. Disarm the observer while a load is in flight or once `hasMoreAbove === false`.
5. **Scroll-anchor preservation on prepend.** Before prepending older messages, capture `scrollHeight` and `scrollTop` of the scroll container. After React commits the prepend, in `useLayoutEffect`, set `scrollTop = newScrollHeight - oldScrollHeight + oldScrollTop`. The user's visible content must not move by a single pixel. (Don't rely solely on CSS `overflow-anchor` — it's inconsistent for programmatically-prepended content.)
6. **Auto-scroll-to-bottom only when near bottom.** Track `isNearBottom` via the scroll container's listener (within 80 px of `scrollHeight - clientHeight`). Live SSE appends auto-scroll to bottom *only if* `isNearBottom` is true. Otherwise, increment a "new messages while scrolled up" counter and show a floating pill: `↓ N new` — clicking jumps to bottom.
7. **Kill the existing always-scroll effect.** The unconditional `endRef.current?.scrollIntoView` on every prop change in `MessageList.tsx:31-33` must be replaced with: (a) one-shot bottom-jump when `replay_done` first arrives, (b) conditional bottom-jump on streaming deltas only when `isNearBottom`.
8. **Streaming-while-paginating coexistence.** The user can be reading old messages (scrolled up) while Claude is mid-response. Streaming deltas update the *existing* assistant message in place — don't move scroll, don't double-scroll. The "↓ N new" pill increments only on *new* messages, not on deltas to a message already in state.
9. **Loading + end-of-history affordances.** While a `loadOlder()` is in flight, the top sentinel renders a thin shimmer / "Loading older messages…" line. When `hasMoreAbove === false`, the sentinel is replaced with a one-line "Start of conversation" pill.
10. **Cursor format.** Server-side cursor is the **uuid** of the oldest message currently in client state (preferred — uuids are stable; integer indices are not, since the SDK can rewrite earlier turns on `/rewind`). Server walks the JSONL and returns the 50 messages strictly *before* that uuid. If `before` is omitted, returns the latest 50 (used by the initial replay path internally).

**Server contract**

- `GET /api/sessions/:id/stream?tail=20` — initial SSE bind. Server tails the JSONL for the last `tail` user/assistant messages (and their associated tool calls/results, system entries scoped to them), pushes them as `sdk` events in the same shape used today, then emits a `{ type: "replay_done", count: <n>, hasMoreAbove: <bool> }` event. Live events follow normally afterward.
- `GET /api/sessions/:id/transcript?before=<uuid>&limit=50` — returns `{ messages, systemEntries, hasMore }`. 404 if session unknown. 400 if `before` is malformed. Caps `limit` at 200 server-side regardless of input.

**Acceptance criteria**

- [ ] Opening a session with 500+ messages renders ≤ 20 user/assistant messages immediately and the view is at the bottom (`scrollTop === scrollHeight - clientHeight`) within one frame.
- [ ] No "smooth scroll chasing" animation occurs during the initial replay; the user perceives an instant anchor at the latest message.
- [ ] Scrolling up triggers exactly one `loadOlder()` request when the top sentinel approaches the viewport; a second trigger does not fire while the first is in flight.
- [ ] After older messages are prepended, the previously-visible message has not moved by more than 1 px on screen.
- [ ] Reaching the head of the transcript replaces the sentinel with a "Start of conversation" pill and stops further requests.
- [ ] While scrolled up reading old messages, an assistant response arriving via SSE does not move the scroll; a "↓ N new" pill appears at the bottom and increments correctly. Clicking it jumps to bottom and clears the pill.
- [ ] When the user is already at the bottom, new live messages auto-scroll to keep the latest visible (existing behavior preserved).
- [ ] Streaming deltas (text appended into an existing assistant message) do not increment the "↓ N new" counter and do not move scroll for the user reading older content.
- [ ] `/rewind` followed by a new turn still works: messages after the rewind point are removed and the view re-anchors at the new bottom.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Virtualized rendering of the full message list (windowing). Spec keeps all loaded messages in DOM; ~200 messages is fine for now. If a user scrolls back N pages and DOM size becomes a problem, a follow-up task can add bottom-trimming + re-fetch on scroll-down.
- Search within the transcript.
- Jump-to-message-by-uuid deep links beyond what `/?session=&at=` already does.
- Bidirectional pagination on a *fork* point — opening a forked session still loads tail 20 of the fork.
- Bisecting historical messages by date — pagination is purely "next 50 older."

**Gotchas**

- `MessageList`'s scroll container is currently the wrapper in `app/page.tsx` (`<div className="flex-1 overflow-y-auto scroll-thin">`), not `MessageList` itself. The IntersectionObserver `root` and the scroll-anchor math both must target *that* container — pass it down via ref or move the overflow boundary into `MessageList`. Pick one; don't have two scroll containers.
- React 19 still prepends commits in batched flushes — wrap the prepend + scroll-anchor restore in `flushSync` if you observe a flash of jump on prepend. `useLayoutEffect` should usually be enough, but verify.
- `replay_done` is a new event type. Add it to `lib/shared/events.ts` and handle it in `applyEvent`. Treat unknown event types as no-ops (the existing dispatcher pattern), so older clients connecting to a newer server don't break.
- Tool results that arrive *after* their tool_use is already in client state must still bind correctly when the tool_use was loaded via pagination — the existing `extractToolResult` path in `use-session.ts:53-68` matches by `tool_use_id` and is order-insensitive, so this should already work. Verify with a manual test.
- Dedupe on prepend is **mandatory**: if a paginated page overlaps with messages already in state (race between SSE replay finishing and `loadOlder` firing), prepend only the messages whose uuids are not already present.
- Per `AGENTS.md`, this Next.js fork has breaking changes — confirm route-handler conventions for the new `/transcript` route in `node_modules/next/dist/docs/`.
- The smooth-scroll behavior in `MessageList.tsx:32` (`behavior: "smooth"`) intersects badly with the new "bottom-anchored open" — change to `"auto"` for the initial-jump path; the conditional auto-scroll path can keep `"smooth"` for live tail follows if desired.

**v1 gaps (deferred):** the paginated-older synthesizer in `lib/client/use-session.ts` only emits top-level user/assistant `DisplayMessage`s with tool_results folded into matching `tool_use` blocks. It does **not**: (a) populate `subagentMessages` for older Task delegations — nested mini-conversations will only appear for traffic in the live tail; (b) populate `systemEntries` for older init/compact/hook events — older system pills (model swaps, hook fires, compact boundaries) will be absent. Both are acceptable for v1 since the "load older" UX is a backstop for long sessions; the live tail (last 20 turns) is where the rich rendering matters. If users complain, extend the synthesizer to walk the same `applyEvent` switch in a "prepend mode" that builds parallel collections and merges them onto state.

### IA review — system vs workspace, then split the side nav ✓ shipped 2026-05-08



**Goal** — Audit every entry in the existing single `SideNav` (today: 13 items, all workspace-scoped chrome) and split them into two groups: **system / global** (live in the leftmost pane below the Workspaces switcher) and **workspace-scoped** (stay in the second pane, which now operates strictly within the active workspace). Then implement the split. The leftmost pane currently holds only Workspaces (per the prior task); after this task it also holds the global tools that don't change when you switch workspace. The middle pane becomes a "what you do *inside* this workspace" surface.

**Why** — Today everything sits in one strip with no signal about scope. With Workspaces (prior task) we have an axis to organize against — but that axis is wasted if global tools (Settings, Plugins, account-level Usage) re-render their own state every time the user switches workspace, and conversely workspace-scoped tools (Sessions, Files, Memory, Assets, Cost) appear "global" when they're really cwd-bound. The user's screenshot shows the bug: workspace switcher on the left, but identical full nav on the right, with no acknowledgement that some of those entries (Settings, Plugins) are global state that doesn't move when you switch.

**Phase 1 — review (deliverable: a one-page decision doc)**

Produce a short table in this `todo.md` file (or `docs/ia-review.md` if you prefer to keep todo.md tight) classifying every item against three criteria. Don't ship code until the table is done and committed; the implementation phase reads from it.

For each of the 13 items, fill three columns:

| Item | Storage scope | Behavior scope | Verdict |
|---|---|---|---|
| Chat | session-in-cwd | per-workspace | **workspace pane** |
| Sessions | `~/.claude/projects/<cwd>/*.jsonl` | per-workspace | **workspace pane** |
| Files | workspace filesystem | per-workspace | **workspace pane** |
| Memory | `~/.claude/CLAUDE.md` (user) **+** `<cwd>/CLAUDE.md` (project) | both | **workspace pane**, with a `Scope: Workspace \| Account` toggle inside |
| Assets | per-project SQLite + per-cwd files (already specced both scopes) | both | **workspace pane**, scope toggle |
| Cost | per-project JSONL aggregation (already specced both scopes) | both | **workspace pane**, scope toggle |
| Agents | `.claude/agents/` (project) **+** `~/.claude/agents/` (user) | both | **workspace pane**, scope toggle |
| MCP | `.mcp.json` (project) **+** user `mcpServers` | both | split — system MCP servers (user) on **left**, project `.mcp.json` on **workspace pane** |
| Hooks | `~/.claude/settings.json` **+** `.claude/settings.json` | both | **workspace pane**, scope toggle (hooks are usually authored globally but matchers run per-cwd) |
| Schedule | per-workspace jobs (jobs hold a `cwd`) | per-workspace | **workspace pane** |
| Permissions | user / project / local rules | both | **workspace pane**, scope toggle |
| Plugins | `~/.claude/` enabledPlugins, marketplaces | global | **system pane** |
| Settings | settings.json hierarchy spans user → project → local | both, but the chrome itself is global | **system pane** (the editor exposes scope tabs internally — already specced in phase 9 of this file) |

**Decisions baked into the table above (defend or override before implementing):**

1. **System pane** (leftmost, below Workspaces switcher) gets: **Settings**, **Plugins**, plus a new **Account** / Usage tile (the existing `app/usage/page.tsx`). These are the items where switching workspace changes nothing.
2. **Everything else stays in the workspace pane**, but features with dual scope grow a `Scope: Workspace | Account` toggle inside the page itself rather than splitting their entry across two panes. This keeps the nav from doubling and matches the language already specced for Cost (rule 9) and Assets (Account tab).
3. **MCP is the one exception** — system-level MCP servers (configured in `~/.claude/settings.json`) are conceptually closer to plugins than to project state, so they get a tile on the left; the project `.mcp.json` editor stays in the workspace pane. Two entries, deliberately. Re-evaluate after talking to a real MCP user; if the split is annoying, fold MCP into the workspace pane with a scope toggle like the others.
4. **Side-nav order** in the workspace pane after the split (top to bottom): Chat → Sessions → Files → Memory → Assets → Cost → Agents → MCP (project) → Hooks → Schedule → Permissions. Settings, Plugins, and Account/Usage are gone from this pane.

If the implementer's audit pushes back on any of these, edit the table here and the order list before writing code.

**Phase 2 — implementation**

**Files involved**

- `components/nav/SideNav.tsx` — drop Settings, Plugins, Account/Usage entries; reorder remaining items per the table.
- `components/nav/WorkspaceSwitcher.tsx` (from the prior Workspaces task) — add a divider below the workspace list, then a small "system" group: Account avatar (or initials) at the very bottom, Settings gear above it, Plugins above that. Stack them vertically so the pane reads as `[workspaces] · [+] · — · [system tiles]`.
- `app/usage/page.tsx` — already exists; just becomes reachable via the system pane instead of a slash command.
- No URL changes for any page — the routes are stable, only the chrome that links to them moves.
- `app/page.tsx` and any other layout that mounts `<SideNav />` — pass through; no shape change.

**Required behavior**

1. **System pane content order** (top to bottom): Workspaces list (existing), `+` (existing), thin divider, Plugins (`Plug` icon), Settings (`Settings` icon), Account/Usage (the user's avatar — letter+color from the same generator the workspace switcher uses, or the email initials).
2. **Active state isolation.** Selecting a workspace tile and selecting a system tile are independent — clicking the Account tile shouldn't dim the active workspace indicator, and vice versa. Two separate "active" highlights, one per group.
3. **Tooltips.** Every system tile shows the same tooltip pattern as the workspace tiles (label on hover, ~250 ms delay).
4. **Keyboard.** No new shortcuts in v1 — but make sure `Tab` order goes Workspaces → System group → SideNav → main, so screen-reader navigation reads top-to-bottom in the visible order.
5. **Scope toggle on dual-scope pages.** For Memory, Assets, Cost, Agents, Hooks, Permissions: add a header chip in the page reading `Workspace ▾` with options `Workspace` and `Account`. Default = Workspace. Changing the toggle swaps the data source (re-fetches with the right scope query param). The Cost and Assets specs in this file already use this language; the others adopt it for consistency.
6. **No data migration.** Settings.json, plugin state, and usage data all already live in the right place; this task only re-routes the chrome.

**Acceptance criteria**

- [ ] Decision table above is filled in and any overrides are recorded inline before any code changes.
- [ ] `SideNav` items list contains exactly: Chat, Sessions, Files, Memory, Assets, Cost, Agents, MCP, Hooks, Schedule, Permissions (in that order). Settings, Plugins, and Account/Usage are removed.
- [ ] Workspace switcher pane has a divider below `+` and three system tiles below it: Plugins, Settings, Account/Usage — each linking to its existing route.
- [ ] Switching workspace does not visually re-render or de-focus the system tiles.
- [ ] Memory, Assets, Cost, Agents, Hooks, Permissions each have a `Workspace | Account` scope toggle in their page header, defaulting to Workspace, and switching scope swaps the data source.
- [ ] Tooltips and active states behave correctly across both groups.
- [ ] `Tab` order is workspace tiles → system tiles → side nav → main.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).
- [ ] No URL changes; all existing deep links still resolve.

**Out of scope**

- Hiding or merging individual workspace-scoped items based on usage telemetry — keep all 11 in the workspace pane for now; trim later if needed.
- Reordering by drag-and-drop.
- Theming the system pane differently from the workspace pane (could be a future polish — slightly muted background to signal "global").
- A separate "Account" route. Reuse `app/usage/page.tsx` as the destination for the Account tile in v1.

**Gotchas**

- The user's screenshot shows two panes today only because the prior Workspaces task is partially live. Don't assume both panes exist when this task starts — sequence depends on whether Workspaces lands first. If it hasn't, this task absorbs the divider/system-group construction into `WorkspaceSwitcher.tsx` as part of building it. Either way, the *audit table* must be produced before code.
- Some entries (MCP, Hooks, Permissions) have a settings-file scope hierarchy that disagrees with the binary Workspace/Account toggle (managed → user → project → local is four levels, not two). Keep the toggle binary in the chrome; the editors inside those pages already expose all four scopes (or will, per phases 6/7/9 in this file). The toggle just filters which scopes contribute to the visible state.
- The Account avatar in the system pane needs an `accountInfo()` call (already wired via the SDK — `lib/server/session.ts` exposes it; reuse what `app/usage/page.tsx` already fetches). Don't add a new endpoint.
- Per `AGENTS.md`, this Next.js fork has breaking changes — but no new routes are added here, so no doc check needed unless you change layout shells.

### Session URL persistence — keep the active session id in the URL so refresh resumes it ✓ shipped 2026-05-08



**Goal** — When the chat at `/` binds to a session, the URL becomes `/?session=<id>` (preserving any other params like `at=<uuid>`). On page refresh, the existing boot effect already reads `?session=` and resumes — so the round-trip just works. Today the URL is *read* on boot but never *written* back, so a refresh on a freshly-created session loses it.

**Why** — `lib/client/use-session.ts:696-705` reads `?session=` and `?at=` on mount and calls `createSession({ resume, resumeSessionAt })` if they exist. But `createSession()` and `switchSession()` never push the new id back into the URL. Result: open `/`, a brand-new session id `X` is created server-side and bound, the URL stays at `/`. Hit refresh → URL has no `?session=` → another fresh session `Y` is created and `X` is orphaned. The user's transcript, queue, and context window are gone in a way they can't recover from without going to `/sessions` and clicking through manually.

**Files involved**

- `lib/client/use-session.ts` — single-file fix. The `bindToSession(id)` call at line 639 is the centralized point where the client commits to an id; update the URL there.

**Required behavior**

1. **Write on bind.** Inside `bindToSession(id)`, after `setSessionId(id)`, call a small helper that does `history.replaceState(null, "", urlWithSession)` where `urlWithSession` is the current URL with `session` set to the new id. Use `replaceState`, *not* `pushState` — the refresh-survivor is the only goal; a back-button history entry per session would be noise.
2. **Preserve other params.** Build the new URL with `URLSearchParams` from the *current* `window.location.search`, set `session = id`, and serialize. This keeps `?at=`, any future query params (e.g. workspace hint, debug flags), and the path itself untouched.
3. **Drop `at` after first bind.** The `at=<uuid>` param is a one-shot resume cursor. Once a session is bound and replaying from that anchor, `at` has done its job — leaving it in the URL means a subsequent refresh would re-replay from that anchor instead of from the actual latest state. Strip `at` from the URL in the same `replaceState` call. (The boot effect should still *read* it on the first mount, just not preserve it across the bind.)
4. **Apply to every bind path.** `bindToSession` is called from `createSession` (new and resumed) and from `switchSession` (clicking a different session in the picker). All three flows benefit from the URL update — putting the call inside `bindToSession` covers all three by construction.
5. **Don't update URL for sub-routes.** This task only affects the chat route. Pages like `/sessions`, `/cost`, `/files` don't host a session and should continue to work as today (the hook is only mounted from the chat shell, so this is automatic — but verify no other page imports `useSession`).
6. **No server change.** This is purely a client-side history mutation; the server already knows nothing about the URL.

**Acceptance criteria**

- [ ] Open `/` on a clean state → after the new session is created and bound, the URL becomes `/?session=<id>` within one render frame.
- [ ] Hard refresh (Cmd-R / Ctrl-R) on `/?session=<id>` resumes the same session, transcript intact, no orphan session created.
- [ ] Switching to a different session via the Sessions picker updates the URL to the new id, and refreshing then resumes the new one (not the old one).
- [ ] Opening `/?session=<X>&at=<uuid>` resumes session `X` from the anchor on first load; after the bind, the URL becomes `/?session=<X>` (the `at` param is dropped).
- [ ] Back button does *not* cycle through every session that was bound during the visit (we used `replaceState`, not `pushState`).
- [ ] Other query params on `/` (any present at boot) survive the bind unchanged.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- Path-based session URLs (`/s/<id>`) — query-param form already works with the existing read path.
- Cross-tab session sync (BroadcastChannel etc.).
- Reflecting permission mode, model, or other session state in the URL.
- Server-rendered fallback if JS is disabled.

**Gotchas**

- `bindToSession` is called from inside the URL-bootstrap `useEffect` on mount. The first call happens during the initial render path — `history.replaceState` is safe to call there, but verify it doesn't trigger any extra `popstate` handlers (it doesn't, by spec; just confirm no app code listens for it).
- React's StrictMode in dev double-invokes effects — the boot effect will create a session twice in dev, but only the second `bindToSession` survives. The URL update will run on both; that's fine because `replaceState` is idempotent.
- If an external code path ever calls `setSessionId` directly without going through `bindToSession`, the URL would drift. Today that doesn't happen — keep it that way; do not add a `useEffect` mirror that watches `sessionId` and writes the URL, because the bind site is the canonical "I am now bound to id X" event and reactive mirrors race against it on tab switches.

### Activity pane — fill the right rail with always-on session insight ✓ shipped 2026-05-08



**Goal** — Turn the right pane (`BackgroundTasksPanel`) into a useful, always-populated **Activity** rail. Today it renders three sections (Subagents, Running tools, Recent) that are *all* empty at idle, so visually the pane looks broken. The user's screenshot shows the symptom: 95% empty space below "RUNNING TOOLS · No tools currently executing." Re-frame the rail as a "what's happening in this session right now" surface with always-on widgets at the top and the existing transient widgets underneath.

**Why** — A right rail that's blank for the majority of session time wastes premium screen real estate and trains the user to ignore it (so when something *does* appear there, they miss it). The data already exists — `useSession()` returns `model`, `permissionMode`, `cwd`, `usage`, `tasks`, `toolProgress`, `pendingPermission`, `queue`, `subagentMessages` — none of it is shown in the rail today. Wire it up.

**Current state — do not reinvent**

- `components/panels/BackgroundTasksPanel.tsx` — the file to extend. Header reads "Activity"; counter on the right shows `tools.length + subagents.length`.
- `app/page.tsx:441` — the only mount point: `<BackgroundTasksPanel progress={session.toolProgress} tasks={session.tasks} />`. Pass through whatever new state the new widgets need.
- `lib/client/use-session.ts` — already exposes everything we need (`model`, `permissionMode`, `cwd`, `usage`, `pendingPermission`, `queue`, `tasks`, `toolProgress`, `subagentMessages`, `agents`, `skills`).
- SDK has `getContextUsage()` for the context-bar widget; not currently wired to the client (`lib/server/session.ts:189` exposes a `getContextUsage()` server method) — `lib/client/useContextWatcher.ts:12` already polls it every 30 s while the session is mounted.
- `components/overlays/CostOverlay.tsx` — token/cost figure formatters already exist; reuse `fmtUsd`, `fmtTokens`, `fmtMs`.

**Files involved**

- `components/panels/BackgroundTasksPanel.tsx` — rename internally to `ActivityPanel.tsx` (file name optional, but the component label "Activity" stays in the header and the file name should match). Add the new widgets.
- `app/page.tsx` — pass the additional session state through.
- `components/panels/widgets/` — small folder with one component per widget (SessionCard, ContextBar, TokenMeter, TodoList, BackgroundBashes, RecentEdits, PermissionPending). Keep each ~40–80 lines so they're easy to ship and tweak.
- No new API routes; everything is already on the client.

**Widget catalog (top-to-bottom in the rail)**

Always-on (render even when idle, so the rail is never blank):

1. **SessionCard** — compact identity block: model name, permission mode pill, `cwd` (truncated, hover for full), turn count, wall time. Click to open the existing `CostOverlay` for the full breakdown. Replaces the current empty top of the rail.
2. **ContextBar** — a one-line bar showing `usedTokens / contextWindow` with a percent. Color steps: ≤50% subtle, 51–80% accent, 81–95% amber, >95% red. Hover popover shows the category breakdown returned by `getContextUsage()` (system prompt, tools, messages, MCP tools, memory). Wire to the existing `useContextWatcher` poll.
3. **TokenMeter** — three small stat tiles: input / output / cache-read tokens, plus a fourth for $ this session. Live-updated from `usage` (already accumulates from `result` events at `use-session.ts:412-437`).

Conditional (render only when relevant; collapse to nothing otherwise):

4. **PermissionPending** — when `pendingPermission != null`, mirror a tiny inline card here that says "⏳ Waiting on your approval — open prompt" and re-focuses the modal on click. Helps users who tab away and miss the modal.
5. **TodoList** — when the session has used the `TodoWrite` tool, render the latest todos here with their statuses (pending / in_progress / completed). Needs a small client-side reducer to track `TodoWrite` tool_use inputs (the SDK doesn't surface a "current todos" view — we synthesize it from the most recent successful `TodoWrite` call's payload).
6. **Subagents** — keep as today, just re-titled "Tasks" to match the SDK's vocabulary.
7. **Running tools** — keep as today.
8. **BackgroundBashes** — when there are running `Bash(run_in_background=true)` shells, list them with shell id, command (truncated), elapsed time, and a "Stream output" button that opens a tail viewer (defer the viewer itself to a follow-up; the listing is enough for v1).
9. **Recent edits** — last N (5) file paths the agent has touched in this session via `Edit` / `Write`, with a "Reveal in tree" link (uses the Files-tree route from the Workspaces task) and a small badge showing `+lines / -lines` if available from the diff. Falls back to just the path if line counts aren't tracked.
10. **Recent (completed tasks)** — keep as today.

**Required behavior**

1. **No blank rail at idle.** The first three widgets always render. Even on a brand-new session before the first turn, SessionCard shows model + cwd + mode, ContextBar shows the system-prompt baseline, TokenMeter shows zeros — that's fine; the rail is alive.
2. **Sticky header.** The "Activity" header strip stays sticky at the top while the body scrolls.
3. **Counter math.** The header counter currently shows `tools + subagents`. Generalize to "items needing attention" — running tools + running subagents + pending permission (`+1`) + running background bashes. Skip widgets that aren't visible (e.g. don't count completed Recent items).
4. **Section dividers.** Use the existing `Section({ label, children })` helper for grouping. Add a thin `border-t border-[var(--border)]/40` between major groups (Always-on / Active / History).
5. **Collapsible sections.** Each section has a small caret that lets the user collapse it; persisted to `localStorage` keyed by section name (`claudius.activity.<section>.collapsed`). Defaults: all expanded.
6. **Width.** Stays at `w-72` for now (288 px). Don't widen — the chat content is the focus.
7. **Empty-but-visible widgets.** The only widget allowed to render an empty-state line ("No tools currently executing.") is when its own data is empty *and* the section is in the Active group; History and Always-on must not show "No X" copy at idle — instead, simply render their figures (zero-counts are fine; no apologetic strings).
8. **Density.** Match the existing dense look — `text-[10px]` / `text-[11px]` and tight padding. Don't introduce a new visual scale.

**Acceptance criteria**

- [ ] Opening the chat shows a populated right rail at idle: SessionCard with model/cwd/mode, ContextBar at its baseline percent, TokenMeter at zero. No blank rail.
- [ ] Sending a turn updates TokenMeter and SessionCard's turn-count + wall-time live.
- [ ] When a permission prompt is pending, a "Waiting on your approval" card appears in the rail and clicking it re-focuses the modal.
- [ ] When the agent calls `TodoWrite`, the TodoList widget shows the items with their current statuses; a follow-up `TodoWrite` updates the same widget in place.
- [ ] The rail header counter equals the visible attention items (running tools + running subagents + pending permission + running background bashes), not just tools + subagents.
- [ ] Each section can be collapsed and the collapse state persists across reload via `localStorage`.
- [ ] Hovering ContextBar shows the per-category breakdown from `getContextUsage()`.
- [ ] On a long-running session, Recent edits lists the last 5 file paths the agent edited, newest first, with optional ±lines badges.
- [ ] On idle, the rail shows zero-state figures (`0 tokens`, `0 turns`) but does not render any "No X" empty-state copy in the Always-on or History groups.
- [ ] `npx tsc --noEmit` passes (modulo the pre-existing `StatusLine` error in `app/page.tsx:19`).

**Out of scope**

- A live tail viewer for background bash output (the listing is in v1; the viewer is a follow-up).
- Inline diff rendering for Recent edits (link to existing diff viewer; don't duplicate it).
- Reordering or hiding individual widgets via user settings — defer to a "rail customization" task once the default set is validated.
- Cross-session activity aggregation (this rail is the *current* session only).
- A dedicated `/activity` page; the rail is enough.
- Sounds / desktop notifications when a permission prompt arrives — already covered by Phase 16.

**Gotchas**

- `useContextWatcher` polls every 30 s — fine for ContextBar normally, but on a turn that's actively burning tokens it will lag. Consider triggering an extra fetch immediately after each `result` event so the bar updates within a turn rather than mid-poll. Optional in v1.
- `TodoWrite` is a tool with mutable list semantics — the canonical state is whatever the *latest* successful `TodoWrite` tool_use input was. Track that as it arrives in `use-session.ts` (alongside the existing `tasks` and `toolProgress` state); don't try to derive it from individual diffs of older calls.
- Background bashes are tracked by the SDK; they surface through the SDK message stream as tool_use events with `run_in_background:true` and via the `Monitor`/`KillBash` tool family. The SDK's `tool_progress` event already arrives for these (`use-session.ts:528-545` style); make sure the BackgroundBashes widget reads from a dedicated map (e.g. `backgroundBashes: Record<bashId, BashInfo>`) rather than fishing them out of `toolProgress`.
- Recent edits requires tracking which Edit/Write tool_use ids have completed and what their inputs were. Add a small reducer in `use-session.ts` that records `{ path, timestamp, addedLines?, removedLines? }` on each successful tool_result for `Edit`, `MultiEdit`, `Write`. Cap to the last 20 in memory; the widget only shows the last 5.
- The `pendingPermission` mirror in the rail must not fight the modal — clicking the rail card should focus/raise the modal, not open a second one. Use the existing `pendingPermission` state and a `?focus=permission` URL hash trick (or just `document.getElementById(...).focus()`) to bring the modal to attention.
- Per `AGENTS.md`, this Next.js fork has breaking changes — but no new routes here, so no doc check is needed unless you change the layout shell.

---

## Follow-up tasks (promoted from "Out of scope")

These were marked out-of-scope inside earlier tasks but make sense to implement once the parent task lands. Each is intentionally tight — full context lives in the parent task's spec.

### Edit + delete existing memories ✓ shipped 2026-05-08



**Parent:** `Add a "create memory" affordance to /memory`. **Why now:** The create-memory task lands a write path on `/api/memory/auto`. Edit and delete are the same boundary check + a different fs call; without them the memory page is half a CRUD.

**Behavior**
- `PATCH /api/memory/auto?cwd=&filename=` body `{ description?, type?, body? }` rewrites the file (preserving `name`, since name doubles as identity). `DELETE /api/memory/auto?cwd=&filename=` removes the file and the matching `MEMORY.md` index line.
- Filename validation, path-traversal rejection, and `name`-immutability identical to the create endpoint. Only the `name` line in frontmatter is locked; everything else is editable.
- UI: clicking a file in `AutoMemorySection` (`app/memory/page.tsx`) opens it in an editable form (the same form used for create, prefilled). "Save" calls PATCH; a small "Delete" button next to Save opens a confirm dialog.

**Acceptance**
- [ ] Editing description/body/type rewrites the file with byte-identical frontmatter shape.
- [ ] Deleting removes the file *and* the matching `- [name](filename.md) — …` line from `MEMORY.md`; other index lines untouched.
- [ ] The `name` field is read-only in the edit form; renaming requires delete + create.
- [ ] `npx tsc --noEmit` passes.

---

### Carry attached images through the queue across reload ✓ shipped 2026-05-08



**Parent:** `Send queued messages reliably when Claude finishes` *and* `Inline [Image #N] tokens in the prompt`. **Why now:** Both parents persist `QueuedMessage` to `sessionStorage` and both flag the gap that `images` aren't carried. Without this, queueing a multi-modal prompt then reloading silently loses the images while keeping the text — a confusing data-loss bug.

**Behavior**
- Extend `QueuedMessage` (in `lib/client/types.ts`) with `images?: AttachedImage[]`.
- The queue's existing `sessionStorage` serializer (added by the queue task) must round-trip the base64 image data. Cap each queued message at the existing 20 MB image limit; if total queue payload > 5 MB, drop oldest messages first and warn — this is to keep `sessionStorage` (~5–10 MB ceiling) safe.
- The `flushQueue` POST already accepts `{ text, images }` (see `use-session.ts:781`); just pass through the queued `images` field instead of sending text-only.

**Acceptance**
- [ ] Queueing a prompt with N images, reloading the page, and letting the queue flush after the current turn finishes results in a multi-modal POST with all N images intact.
- [ ] If the queue's serialized size exceeds ~5 MB, oldest messages are dropped and an inline error "Queue too large; oldest items removed" is shown.
- [ ] Editing a queued chip (the queue-task's editQueued action) puts both text *and* images back into the prompt input.
- [ ] `npx tsc --noEmit` passes.

---

### Spending limits & quotas — per-job and global ✓ shipped 2026-05-08 (v1: per-session enforcement + project soft-warning; per-job + project-wide pause deferred)



**Parents:** `Loop / Schedule` (per-job) and `Cost — left-nav section` (global). Both flagged this OOS. **Why now:** A scheduled job that runs every 5 minutes can silently rack up $X/day; a runaway agent loop can do worse. Spend-cap is a safety feature, not a polish.

**Behavior**
- New page `/cost/limits` (or a tab inside `/cost`) with three controls:
  1. **Daily project cap (USD)** — soft warning chip in the header; hard pause if breached.
  2. **Per-job cap (USD/run, USD/day)** — set per scheduled job in the Schedule editor; soft warning + skip-and-record-`limit_exceeded`-status if breached.
  3. **Per-session cap (USD)** — set in session settings; on breach, surface a non-dismissable banner and refuse new turns until the user explicitly clicks "Continue (override)."
- Storage in the project's SQLite (`.claudius.db` from the Files/Assets task) — new `limits` table keyed by `scope` and `target`. If that DB doesn't exist yet, fall back to a JSON file at `~/.claude/.claudius/limits/<encoded-cwd>.json`.
- Enforcement points:
  - Schedule executor: check job + project caps *before* dispatching the SDK call. On breach, write a `Run` record with `status: "skipped"`, `reason: "limit_exceeded"`.
  - Live session: check session + project caps inside the existing `result` event handler in `use-session.ts:412-437` *after* accumulating the new turn's cost. On breach, set a new `cap_breached: true` state that `PromptInput` reads to disable Send.
- "Continue (override)" path lifts the cap for the *current calendar day* only and writes a small audit row.

**Acceptance**
- [ ] A scheduled job with `usdPerDay: 0.10` that has accrued $0.10 today produces a `skipped/limit_exceeded` run instead of dispatching.
- [ ] A live session at the per-session cap shows the banner; Send is disabled; clicking "Continue" re-enables Send for the rest of the day.
- [ ] Breaching the project daily cap pauses *all* sessions and scheduled jobs in that project until midnight (server local) or until the user clears the override.
- [ ] An audit log of all cap-breach + override events is visible in `/cost/limits`.
- [ ] `npx tsc --noEmit` passes.

**Out of scope (explicitly):** Anthropic-side caps via Admin API; this is purely client-side enforcement on top of `total_cost_usd` we already accumulate.

---

### Live-stream scheduled job runs ✓ shipped 2026-05-08



**Parent:** `Loop / Schedule`. **Why now:** The parent task's run-history viewer renders only after the run completes. Watching a long run is the natural follow-up; the chat already has SSE plumbing we can reuse.

**Behavior**
- Each scheduled job, when running, is a one-shot SDK session — but spawned without a browser tab attached. Add an SSE endpoint `GET /api/schedule/:id/runs/:runId/stream` that broadcasts the same `ServerEvent` shape the chat already consumes.
- The Schedule run-history pane (`components/schedule/RunHistory.tsx`) gets a "● Live" badge on any run whose status is `running`; clicking it opens the existing `MessageList` rendering the live event stream.
- After completion, the live stream is replaced by the persisted transcript view — no UI change visible to the user.

**Acceptance**
- [ ] Triggering a job and clicking the live row immediately shows the SDK init message, then assistant text/tool deltas as they happen.
- [ ] The "● Live" badge disappears within ~1 s of the run completing.
- [ ] Multiple browser tabs streaming the same live run all see identical event ordering.
- [ ] `npx tsc --noEmit` passes.

---

### Writable file tree ✓ shipped 2026-05-08



**Parent:** `Workspaces — Slack-style switcher pane`. **Why now:** The Files tree page in the parent is read-only — you can browse and preview, but not edit. The most common reason to look at a workspace's tree is to read or tweak a file. Read-only is a half feature.

**Behavior**
- New endpoints under `/api/workspaces/:id/files`: `PUT ?path=` writes a UTF-8 file (body is the new content); `POST ?path=&kind=file|dir` creates; `DELETE ?path=` deletes; `PATCH ?path=&newPath=` renames. All four enforce the same path-safety boundary as the read endpoint.
- File detail panel grows two affordances: an inline editor (Monaco — already implied as a dep for SettingsEditor) for text files, and "Open in $EDITOR" link that emits a `vscode://file/<path>` URL for VS Code (already in Phase 12 scope of this file).
- "New file" / "New folder" / "Rename" / "Delete" actions on the tree's right-click context menu (or a small action row).

**Acceptance**
- [ ] Editing a text file and clicking Save rewrites the file on disk; reload shows the edit.
- [ ] Creating a new file or folder appears immediately in the tree without a manual refresh (optimistic update + revalidation).
- [ ] Deleting moves to OS trash where possible; falls back to permanent delete with a clear confirm dialog.
- [ ] All path-safety checks reject `..`, absolute paths, and symlink hops outside the workspace root with 400.
- [ ] `npx tsc --noEmit` passes.

---

### Per-workspace defaults — model, permission mode, MCP overrides ✓ shipped 2026-05-08 (model + permissionMode wired; mcpServerIds / autoMemoryEnabled / claudeMdExcludes / additionalDirectories stored in schema, not yet honored at session-creation)



**Parent:** `Workspaces`. **Why now:** Different projects naturally want different defaults — a "research" workspace likely wants Opus on `acceptEdits`, a "ops" workspace wants Sonnet on `default`. The Workspaces task creates the registry but binds nothing per-workspace beyond `rootPath`.

**Behavior**
- Extend the workspace shape (in `~/.claude/.claudius/workspaces.json`) with `defaults?: { model?, permissionMode?, mcpServerIds?, autoMemoryEnabled?, claudeMdExcludes?, additionalDirectories? }`.
- New session creation merges these defaults *under* explicit `CreateSessionRequest` fields (so per-session overrides still win): `effective = { ...workspace.defaults, ...requestBody }`.
- UI: workspace edit form gains a "Defaults" tab with selectors for each field; values left empty mean "inherit machine-level setting" (current behavior).

**Acceptance**
- [ ] Setting `defaults.model = "claude-opus-4-7"` on a workspace causes new sessions in that workspace to use Opus without specifying it.
- [ ] An explicit `?model=...` query param or session-level model switch still overrides the workspace default.
- [ ] Switching workspaces and starting a new session shows the new default in the StatusLine.
- [ ] Defaults round-trip through the workspace JSON file (no schema breakage on read of an existing file with no `defaults` key).
- [ ] `npx tsc --noEmit` passes.

---

### Transcript search ✓ shipped 2026-05-08



**Parent:** `Session open — anchored at bottom, paginated upward`. **Why now:** Once sessions can run for hundreds of messages without paying a cost (since pagination keeps DOM small), users will want to search them. Today there's no search at all.

**Behavior**
- `GET /api/sessions/:id/search?q=&limit=` streams `*.jsonl` line-by-line, runs a case-insensitive substring (or `/regex/` if `q` starts and ends with `/`) match against text content, and returns `{ messageUuid, role, snippet, score }[]` in occurrence order. No persistent index in v1 — full-scan is fast enough at our scale.
- New `Cmd-F` / `Ctrl-F` keybinding inside the chat opens a slim header search bar; results render in a popover. Clicking a result calls the existing `loadOlder()` from the pagination task until that message is in state, then scrolls to it with a brief highlight pulse.
- Account-wide search (across all sessions in the workspace, then across all workspaces) is a follow-up — v1 is single-session only.

**Acceptance**
- [ ] `Cmd-F` / `Ctrl-F` opens the search bar without conflicting with the browser's native find when the user intends *transcript* search.
- [ ] A search returns results within ~500ms on a 1000-message session.
- [ ] Clicking a result paginates as needed and scrolls the message into view with a 1-second background-color pulse.
- [ ] `/regex/` syntax works for common patterns; invalid regex shows an inline error.
- [ ] `npx tsc --noEmit` passes.

---

### Multi-tab session coordination ✓ shipped 2026-05-08



**Parent:** `Session URL persistence`. **Why now:** Once the URL preserves the session id (parent task), it's trivial to open the same session in two tabs. Today nothing prevents that, and both tabs will: (a) open SSE streams, (b) accept user input, (c) write to the same queue/history. Real bug already, latent until URL persistence makes it easy to trigger.

**Behavior**
- On `bindToSession(id)`, broadcast a `claim:<id>` message via `BroadcastChannel("claudius.sessions")`. If another tab responds with `held:<id>` within 250 ms, the late tab enters **read-only mode**: SSE still streams, but PromptInput is disabled with a banner "Active in another tab — [Take over]" / "[Open as new session]."
- Clicking "Take over" sends `evict:<id>`; the holder demotes to read-only and the new tab becomes the holder.
- Closing a tab sends `release:<id>` so a passive tab on the same session can self-promote.
- Pure client-side coordination — no server changes.

**Acceptance**
- [ ] Opening the same session in a second tab puts that tab in read-only mode within 1 s.
- [ ] Clicking "Take over" swaps holder cleanly; old tab disables input within 1 s.
- [ ] Closing the holder tab promotes any single waiting tab to holder automatically.
- [ ] Different sessions in different tabs are unaffected (no false read-only mode).
- [ ] `npx tsc --noEmit` passes.

---

### Live tail viewer for background bashes ✓ shipped 2026-05-08 (v1: replays captured BashOutput results; true live-tail polling needs SDK access we don't have)



**Parent:** `Activity pane — fill the right rail`. **Why now:** The parent lists running background bashes but provides no way to see their output without asking Claude. The SDK's `BashOutput` / `Monitor` tools surface this; we just need to expose them as a UI.

**Behavior**
- Clicking a running bash in the Activity rail opens a slide-over panel (right-anchored, ~480 px wide) that streams stdout/stderr lines via the existing `tool_progress` channel and the `BashOutput` tool's response shape.
- Auto-scroll-to-bottom unless the user has scrolled up (mirrors the chat MessageList logic from the reverse-infinite-scroll task).
- Action row: "Kill" (calls `KillBash`), "Copy output", "Open as message" (inserts the buffer as a quoted user message in chat).
- If the bash terminates while the panel is open, the header switches to its exit code and a subtle status pill ("exited 0" / "exited 1" / "killed").

**Acceptance**
- [ ] Clicking a running bash opens the panel within one frame and shows accumulated output up to that point.
- [ ] New stdout lines appear in real time without flicker; auto-scroll respects the "user is reading older content" rule.
- [ ] "Kill" terminates the process and updates the status pill.
- [ ] Closing the panel does *not* kill the process — it keeps running in the background.
- [ ] `npx tsc --noEmit` passes.

**Gotchas**

- Some old `result` events may not have `total_cost_usd` populated — treat missing as 0, not as null/skip.
- `modelUsage` shapes have changed across SDK versions; defensively read `Object.entries(modelUsage)` and treat each value as `{ inputTokens?, outputTokens?, costUsd? }` with all fields optional.
- Calendar-day grouping must use a consistent timezone (server local) — document this on the page so users don't get confused when comparing to the SDK's UTC timestamps.
- `recharts` adds ~100 KB gzipped; if that's unacceptable, swap for a hand-rolled `<svg>` bars component (rectangles + axis ticks). Decision: start with `recharts` for shipping speed, revisit if bundle size budget is tightened.
- The cache file (`.claudius-cost-cache.json`) lives inside `~/.claude/projects/<encoded-cwd>/` — make sure it's filtered out of session listings in `sessions-store.ts` so it doesn't appear as a phantom session.
