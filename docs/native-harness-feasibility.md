# Native Harness Feasibility — Stepping Outside the Claude Agent SDK

**Status:** Draft / feasibility study
**Branch:** `feat/native-harness-spike`
**Date:** 2026-05-31

> **TL;DR — No-go.** Five of nine capability buckets are independently XL, an
> L→XL `claude_code` system-prompt body is owned by no one, and an XL
> *integration tax* sits on top because the buckets are mutually dependent.
> The single biggest blocker is **auth (§4.9)**: the Claude subscription token
> is gated to the `claude_code` identity/scope, so a native loop likely *cannot
> send arbitrary system prompts on the subscription path* — which is the entire
> reason to go native. The SDK is not an abstraction being shed; `assistant.mjs`
> (1.5 MB) + `sdk.mjs` (856 KB) **are** Claude Code. Going native = permanently
> forking it. The PoC in §8 proves the loop is the easy ~5%. Full reasoning in
> §7. If the real goal is *observability/control*, push for seams through the
> SDK's existing control-request surface instead.

## 1. The question

Claudius today wraps a single SDK call — `query()` from
`@anthropic-ai/claude-agent-sdk` (`lib/server/session.ts:886`). That one call
*is* Claude Code: it owns the agent loop, the built-in tools (Read/Edit/Bash/
Grep/Glob/WebFetch/…), MCP wiring, hooks, permissions, the CLI-compatible
session JSONL, subagents, skills/slash commands, compaction, and auth.

The user is asking: **what would it take to step outside the SDK and reimplement
"Claude Code functionality" natively inside Claudius**, on top of the raw
Messages API (`@anthropic-ai/sdk`, already present transitively at `0.81.0`),
**so the loop can be driven and observed from Claudius's own UI** rather than
through the SDK's opaque `query()` generator?

This document is a **feasibility study and plan**, not a migration. The goal is
to (a) inventory what the SDK actually provides, (b) separate what Claudius
*already* duplicates from the genuine gap, (c) honestly cost the gap, (d) flag
the constraints most likely to sink the ambition, and (e) ship one minimal,
standalone proof-of-concept that proves the native loop can do a single
tool round-trip.

## 2. Scope boundary (read this first)

- **In scope:** analysis, capability inventory, effort/risk assessment, a
  decision recommendation, and one isolated PoC spike (`scripts/native-harness-spike/`)
  that is *not* wired into the running app.
- **Out of scope:** actually removing the SDK from `session.ts`, rewriting the
  tool implementations, or changing any production code path. That is a
  multi-week migration and would produce a broken PR.
- "Start to execute" = this plan exists, the analysis is complete, and the
  first concrete artifact (the spike) is in the tree.

## 3. The discriminating reality

The raw Messages API gives you **the model and the tool-use protocol, and
nothing else**. Everything expensive ships inside the SDK. So "implement the
same functionality" is roughly **~95% harness reimplementation, ~5% API loop.**

The two sleepers that the plan must address head-on, not gloss:

1. **Auth / billing.** The SDK authenticates through the user's Claude
   subscription (OAuth / keychain creds), not just `ANTHROPIC_API_KEY`. A
   native impl on `@anthropic-ai/sdk` likely loses the subscription path. This
   is **blocking-class** for the whole ambition.
2. **What Claudius already wraps vs. what is pure-SDK.** Claudius already owns a
   session store, MCP config, hooks bridging, and permissions UI. The real work
   is the *gap*, not the whole surface.

> **How this study was produced:** a dynamic multi-agent workflow fanned out one
> read-only analysis agent per capability bucket (reading `sdk.d.ts` and
> `lib/server/`), an adversarial critic looked for what they under-costed, and a
> synthesis pass wrote §§4–7. The blunt no-go below is the workflow's verdict,
> not a foregone conclusion.

## 4. Capability inventory

Each subsection separates **SDK provides** / **Claudius already has** / **native gap** / **effort** / **risk**. Effort scale: S (days), M (1-2 wk), L (several wk), XL (month+).

### 4.1 Agent loop & streaming

- **SDK provides:** `query()` returns a `Query` async generator (sdk.d.ts:2162) that runs the full agentic loop over `anthropic.messages.stream()` — accumulates tool_use, dispatches, appends tool_results, re-prompts until the turn settles, and synthesizes the ~28-member `SDKMessage` union (sdk.d.ts:3298). Owns `interrupt()`/`setModel`/`setPermissionMode`, `maxTurns`/`maxBudgetUsd`, partial streaming (`SDKPartialAssistantMessage`), retry/backoff + `fallbackModel`, cache_control breakpoint placement, signed-thinking replay, and `TerminalReason`/`EXIT_REASONS` derivation.
- **Claudius already has:** All the host-side scaffolding. `lib/server/async-queue.ts` is a complete streaming-input queue; `session.ts` `consume()` (L3250) is the `for await` driver with SSE broadcast, replay buffer, turn-status, and dual abort (`interrupt()` L1558 vs `abortController.abort()` L371). The client (`lib/client/use-session.ts`) already parses raw `stream_event` partials, so partial streaming to the UI is near-free. Cost from raw usage is mostly owned via `litellm-pricing.ts` + `cost-aggregate.ts` (verified present) — **but** `cost-aggregate.ts:152` reads the SDK's on-disk JSONL, so this win is hostage to bucket 4.6.
- **Native gap:** The while-loop mechanics reuse existing plumbing (cheap). The expensive remainder the SDK does *inside* the loop and Claudius has zero of: (1) context compaction (lands in 4.8), (2) signed-thinking replay, (3) cache_control placement, (4) retry/backoff + fallbackModel, (5) result accounting, (6) EXIT_REASONS derivation, (7) the rest of the SDKMessage taxonomy (task_progress, prompt_suggestion, tool_use_summary, status, thinking_tokens) that downstream UI keys on.
- **Effort:** M for loop mechanics alone; **L** with replay + retry/fallback + cache_control + SDKMessage-taxonomy reproduction in scope.
- **Risk:** **high.** Note the genuine native *upside* the study under-weighted: a from-scratch loop holding the live in-memory assistant message could avoid the thinking-replay 400 class entirely (it is an SDK reassembly bug per `thinking-replay-recovery.ts:5-20`) — but only until 4.6/4.8 serialize-then-rehydrate signed blocks, at which point the bug re-enters through persistence.

### 4.2 Built-in tools

- **SDK provides:** Executes all 15+ tools inside the subprocess (sdk-tools.d.ts): Read (line windowing, PDF pages, image blocks, readFileState mtime cache), Edit/MultiEdit (exact-match + uniqueness + diff), Bash (timeout, background tasks, sandbox, output persistence, `gitOperation` classification, `staleReadFileStateHint`), Grep (ripgrep wrapper), Glob, WebFetch/WebSearch, Task, TodoWrite, NotebookEdit, ExitPlanMode, AskUserQuestion, plus file checkpointing for rewind.
- **Claudius already has:** Almost nothing on the agent path. `shell.ts` is a `bash -c` executor but verified wired **only** to `app/api/workspaces/[id]/shell/route.ts` (the /git console) — not to any agent tool, no sandbox/background/git-classification. `safe-path.ts`, `fs-list.ts`, `asset-store.ts`, `git.ts` are reusable adjacent utilities. ExitPlanMode/AskUserQuestion are intercepted in `canUseTool` (L1018/L1056) for the UI round-trip only — the SDK still executes them.
- **Native gap:** Reimplement every executor plus cross-tool invariants: readFileState gating Edit behind Read (and Bash-write invalidation), Bash sandboxing (security subproject), ripgrep parsing, WebFetch SSRF + HTML→markdown + summarization sub-call, Task recursion (overlaps 4.7), NotebookEdit ipynb, file checkpointing, and protocol glue. Every consumed output field (`gitOperation`, `persistedOutputPath`, NotebookEdit diffs) must be reproduced or UI silently breaks at runtime.
- **Effort:** **XL** (L-to-XL even for the reduced Read/Edit/Write/Bash/Grep/Glob set; full parity + sandbox + checkpointing + web tools is XL+ongoing).
- **Risk:** **high.** Sandboxing reimplemented wrong = RCE surface. Output-field parity is a versioned reverse-engineering treadmill (failure mode: field silently missing at runtime, no type error). WebSearch is likely an **over-cost** — Anthropic ships a server-side `web_search` tool on raw Messages API; needs one-line live verification before being budgeted as a hard gap.

### 4.3 MCP

- **SDK provides:** Entire MCP *runtime*: `createSdkMcpServer`/`tool()` in-process servers (sdk.d.ts:466), transport + lifecycle for stdio/SSE/HTTP/claudeai-proxy configs (5s connect timeout, deferred tool loading), `mcp__server__tool` namespacing + schema injection, live control (`mcpServerStatus`/`reconnectMcpServer`/`toggleMcpServer`/`setMcpServers`), elicitation, and remote OAuth/needs-auth flows.
- **Claudius already has:** Config-file CRUD and thin pass-throughs only — **zero runtime**. `lib/server/mcp.ts` reads/writes server entries across scopes; `session.ts:1991-2037` delegates to `this.query.*`. API routes + `/mcp` UI + `mcp-server-add` skill all operate on config files. It never connects to a server.
- **Native gap:** Reimplement the client runtime by depending directly on `@modelcontextprotocol/sdk` Client + transports: per-session connection manager (connect/retry/disable/reconnect), `listTools` → namespaced Anthropic `tools[]`, route `mcp__…` tool_use to `callTool()`, map `CallToolResult` → tool_result, per-call timeout, surface `McpServerStatus` to the existing UI. Re-host the in-process `claudius_goal` tool natively (trivial). Out of MVP: elicitation, OAuth/needs-auth, claudeai-proxy, deferred tool-search, enterprise lists.
- **Effort:** **L** (lower-half L ≈ 2-3 wk for stdio + plain SSE/HTTP MVP leaning on `@modelcontextprotocol/sdk`); XL for OAuth/elicitation/proxy parity.
- **Risk:** **high.** Transport correctness (stdio framing, SSE reconnection, timeouts), OAuth flow for remote connectors, elicitation bridge, and reliable child-process teardown (leaked stdio processes) are the hazards.

### 4.4 Hooks

- **SDK provides:** The entire hook engine compiled into the bundled CLI binary. 30 lifecycle events (`HOOK_EVENTS`, sdk.d.ts:783), programmatic + settings.json registration (5 handler types), JSON stdin/stdout protocol, exit-code-2 blocking, matcher/timeout/once/async flags, cross-scope merge, and deny/modify feedback into the loop. `includeHookEvents` surfaces hook_started/progress/response.
- **Claudius already has:** `lib/server/hooks.ts` is a settings.json CRUD editor — **no execution** (never spawns/POSTs/fires). `lib/shared/hook-events.ts` is display metadata for the `/hooks` editor. The only live hooks are two self-serving programmatic observers (`session.ts:846-885`, worktree-sniff + cwd) that always return `{continue:true}`. `readSettings` loads per-scope but does **not** merge.
- **Native gap:** (a) A dispatch engine + JSON I/O protocol so user settings.json hooks keep working (5 handler types, matchers, flags, cross-scope merge, feedback semantics). (b) Firing events around the loop. Loop-native events (Pre/PostToolUse, UserPromptSubmit, Stop, SessionStart/End, PermissionRequest/Denied, CwdChanged) are wireable directly; **~half the 30 events cannot fire until other subsystems exist** — PreCompact/PostCompact need 4.8, Subagent/Task events need 4.7, Worktree events need worktree mgmt, UserPromptExpansion/InstructionsLoaded need 4.7 + CLAUDE.md loading, Elicitation needs 4.3.
- **Effort:** **XL** for full parity; **L** for dispatch-engine + loop-native events only (dropping subsystem-dependent events); S for Claudius's own two observers alone.
- **Risk:** **high.** Mutating/blocking hooks (PreToolUse deny/modify, UserPromptSubmit rewrite, Stop block) feed control flow — silent parity bugs. Cross-scope merge is currently free *because* the SDK defaults to all-source merge (verified: `settingSources` never set in session.ts).

### 4.5 Permissions

- **SDK provides:** A full decision **engine** that runs before any tool executes; `canUseTool` is only the residual "ask" handler it falls through to (sdk.d.ts:188-230). Allow/deny rule matches short-circuit *without* reaching canUseTool (`SDKPermissionDeniedMessage`, sdk.d.ts:3365). Six PermissionModes incl. `plan` (read-only + preamble) and `auto` (a model-classifier call, sdk.d.ts:1973). Rule-pattern matching (Bash compound-command splitting, path globs, domain rules), settings-tier merge (restrictive-only, managed-only, defaultMode escalation), and pre-computed title/displayName/description/suggestions bridge.
- **Claudius already has:** The interactive "ask" surface and mode plumbing — the residual handler, not the engine. `session.ts:998-1109` consumes the SDK-supplied ctx and raises permission_request/ask_user_question/plan_approval SSE events; `resolvePermission` (L1111), `resolvePlan` (L1212), `setPermissionMode` (L1562) delegate to `query.*`. Settings IO writes rule strings but **nothing evaluates them** — matching is 100% SDK-internal.
- **Native gap:** Reimplement the engine, run on every tool_use before dispatch: (1) rule-matching incl. Bash compound-command splitting (security-sensitive core), (2) settings-tier merge + precedence, (3) PermissionMode semantics natively — incl. `auto` (a classifier LLM call, **already in production** at `scheduler.ts:165`) and `plan` (read-only enforcement + preamble entangled with ExitPlanMode), (4) the title/suggestion bridge the UI gets for free, (5) write-through of `updatedPermissions` into the live merged rule set.
- **Effort:** **XL.**
- **Risk:** **high.** Bash pattern matching wrong = over-block (agent breaks) or under-block (denied command slips through) — highest-stakes reimplementation in the study. `auto`=classifier and `plan`=read-only enforcement are subsystems, not flags. Tier-merge mismatch fails silently after cutover.

### 4.6 Session persistence & resume

- **SDK provides:** The entire on-disk transcript layer. Subprocess writes CLI-internal `~/.claude/projects/<cwd>/<id>.jsonl` (8+ record types, parentUuid chaining). Read side: `getSessionMessages` (chain reconstruction, sdk.d.ts:726), `getSessionInfo`, `listSessions`, `forkSession` (UUID remap preserving DAG, :667), `rewindFiles` (restore from `file-history-snapshot`, :2298, gated by `enableFileCheckpointing`). Resume via Options `resume`/`sessionId`/`resumeSessionAt`. Format explicitly declared CLI-internal/opaque (sdk.d.ts:4001).
- **Claudius already has:** A thin delegation + metadata layer. `sessions-store.ts` re-exports the SDK readers; `sessions-db.ts` is a SQLite **index** (no transcript content). `session.ts` pins `sessionId`, sets resume, replays history via `getSessionMessages`, and watches the JSONL for external `claude --resume` writes (L913). Fork/rewind routes are pure pass-throughs. Zero native serialization, chain reconstruction, fork remap, or checkpointing.
- **Native gap:** Reimplement the whole layer — the Messages API has no concept of sessions/resume/fork/checkpoints: (1) JSONL (or native) writer with parentUuid threading + sidecar records, (2) reader that reconstructs the chain (graph walk over sidechains/subagents/compact boundaries), (3) fork UUID-remap, (4) a from-scratch file-checkpoint store for rewind (snapshot-before-edit + restore + dry-run + retention), (5) resume context replay, (6) metadata derivation.
- **Effort:** **XL.**
- **Risk:** **high, verging blocking** for the rewind/file-checkpoint fidelity. CLI-compat means perpetual coupling to an unversioned opaque format; a native store abandons `claude --resume` interop + the JSONL watcher. Recommendation: drop CLI-compat and own a documented SQLite store (better-sqlite3 already present) — removes reverse-engineering risk, still XL.

### 4.7 Subagents, skills & slash commands

- **SDK provides:** All orchestration. Task/Agent tool runs each subagent as a recursive sub-loop with its own prompt/tools/model/maxTurns/taskBudget/permissionMode (`AgentDefinition`, sdk.d.ts:38-92), incl. `background:true` and the ~30s progress-summary fork. `supportedAgents`/`listSubagents`/`getSubagentMessages`, skill resolution (`Options.skills`, Skill tool, SKILL.md injection), slash-command resolution (custom `.md` parsing + built-in `/compact`,`/init`,`/recap`,`/btw`,`/effort`,`/insights`,`/sandbox`), and the full task_* event stream + hooks.
- **Claudius already has:** A thin observer/CRUD slice. `agents.ts`/`skills.ts` CRUD the `.md` files; `db-agents.ts` persists defs and hands them to `Options.agents` (the SDK runs them); `slash-commands.ts` is a static registry whose `handler:'sdk'` path pushes the raw string into the input queue; `captureTaskState`/`session-tasks-db.ts` sniff task_* events off the wire for replay. **Resolves/executes/spawns nothing.**
- **Native gap:** Almost entirely greenfield. Reimplement the recursive agent loop (nested subagents, background queues, progress-summary fork), **generate** the subagent transcripts it used to merely read, re-emit task_*/Subagent* signals its observer expects, build the skill resolver + Skill tool + SKILL.md injection with listing budget, and reimplement slash commands — custom resolver (mechanical, M) plus every built-in `handler:'sdk'` command (no subprocess to forward to anymore; `/compact` alone is a summarization subsystem).
- **Effort:** **XL** (honest floor — heaviest orchestration surface).
- **Risk:** **high.** Cannot be built in isolation — every nested tool call must re-enter permissions (4.5), fire hooks (4.4), route MCP (4.3). Built-in agents (general-purpose/Explore) and plugin-injected items are SDK-internal and not editable files.

### 4.8 Compaction / context management

- **SDK provides:** The full context-management engine. Auto-compaction + `/compact` surfaced via `SDKCompactBoundaryMessage` (sdk.d.ts:2644) with preserved_segment/preserved_messages relink data; `autoCompactEnabled`/`autoCompactWindow`; PreCompact/PostCompact hooks; `getContextUsage()` rich per-category breakdown (sdk.d.ts:2262); `claude_code` preset assembly + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for cache-prefix splitting; `seedReadState`; `foldSessionSummary`. The summarization prompt itself is CLI-internal. Raw `@anthropic-ai/sdk` 0.81.0 provides only `countTokens()` + post-response usage — verified **not** used anywhere in Claudius today.
- **Claudius already has:** Only wraps SDK signals. `getContextUsage` passthrough (`session.ts:1981`) read by `useContextWatcher` (uses only total/max/percentage). Context-warning UI, compact-boundary display merge, `reseedReadPathsAfterCompact` (matters only *because* SDK compaction strips Reads), `systemPromptAppend` (a thin append, not assembly). Computes no budgets, decides no compaction, summarizes nothing, assembles no prompt.
- **Native gap:** (1) Compaction engine — write a tuned summarization prompt (SDK's is unavailable), threshold detection, splice summary + preserved tail, reproduce parentUuid relinking, keep readFileState coherent. (2) Token budgeting — `countTokens` exists but is a per-turn network round-trip (latency) or a bundled approximate tokenizer (drift); auto-compact must count *before* sending or hit a hard overflow 400. (3) cache_control/static-dynamic boundary mechanics (cheap).
- **Effort:** **XL** with preset content included; **L** for compaction + budgeting mechanics alone.
- **Risk:** **high.** Summary quality is non-deterministic (silent context loss). Relink bugs corrupt the chain. Budgeting is a latency-vs-drift forced tradeoff.

### 4.9 Auth / billing

- **SDK provides:** Owns the subscription/OAuth path entirely. Credential store `~/.claude/.credentials.json` (`claudeAiOauth`), token refresh against `platform.claude.com/v1/oauth/token` with the `oauth-2025-04-20` beta + `user:sessions:claude_code` scope, `accountInfo()` (subscriptionType/apiKeySource, sdk.d.ts:2289), per-session cost, `maxBudgetUsd`, and host-callback refresh requests. `DirectConnectTransport` is a WebSocket remote-control bridge, **not** a path to `/v1/messages` (ruled out as a shortcut).
- **Claudius already has:** Observation/UI scaffolding only. `doctor/route.ts:86-109` checks for the env key + credentials file existence; `usage/page.tsx` renders SDK `accountInfo()` fields; `settings/page.tsx:837` exposes `apiKeyHelper`. Owns **zero** of the mechanism — never reads, refreshes, stores, or attaches a token.
- **Native gap:** To preserve subscription billing on raw `@anthropic-ai/sdk`: read credentials (+ macOS keychain) → set `authToken` + `anthropic-beta: oauth-2025-04-20`; detect `expiresAt` + refresh against the OAuth endpoint, persisting rotated tokens without corrupting the file the CLI also writes (concurrent-writer hazard); re-derive `accountInfo()` data. The realistic fallback — require `ANTHROPIC_API_KEY` — is technically trivial but a product regression (per-token vs flat subscription).
- **Effort:** **L.**
- **Risk:** **high.** This is the single biggest argument against going native: the subscription token is gated to the claude_code identity/scope, so a native loop likely **cannot send arbitrary system prompts on the subscription path** — negating the project's own "drive from our own UI" motivation. ToS-exposed, fragile to Anthropic rotating the gate/beta/client_id, and forces ownership of refresh/storage the SDK owns today.

## 5. Effort & risk summary

| # | Capability bucket | Effort | Risk | Notes |
|---|---|---|---|---|
| 4.1 | Agent loop & streaming | M → **L** | high | Mechanics reuse existing AsyncQueue/consume/AbortController; L once replay + retry/fallback + cache_control + SDKMessage taxonomy are in scope. |
| 4.2 | Built-in tools | **XL** | high | Single most under-costed bucket. Sandboxing = security subproject; output-field parity = perpetual drift. |
| 4.3 | MCP | **L** | high | MVP (stdio + plain SSE/HTTP) leans on `@modelcontextprotocol/sdk`; OAuth/elicitation push to XL. |
| 4.4 | Hooks | **XL** | high | ~half of 30 events blocked on other buckets; L if scoped to dispatch engine + loop-native events only. |
| 4.5 | Permissions | **XL** | high | Bash pattern matching is highest-stakes reimplementation; `auto` classifier already in production. |
| 4.6 | Session persistence & resume | **XL** | high (→ blocking for rewind) | Opaque CLI format; rewind/file-checkpoint is a hazardous standalone subsystem. |
| 4.7 | Subagents, skills & slash commands | **XL** | high | Heaviest orchestration; cross-coupled to 4.3/4.4/4.5; `/compact` hidden inside. |
| 4.8 | Compaction / context | **XL** (L without preset content) | high | Non-deterministic summary quality; pre-turn budgeting latency/drift tradeoff. |
| 4.9 | Auth / billing | **L** | high | Not a technical wall but a strategic bind; negates the project's own motivation. |
| — | **`claude_code` system-prompt preset CONTENT** (orphaned — see §6) | **L → XL + ongoing** | high | Owned by no bucket; re-authoring + perpetual re-tracking of an opaque per-release prompt. |
| — | **Integration tax** (wiring the mutually-dependent buckets — see §6) | **XL** | high | Not in any bucket's number; efforts do **not** sum. |

**Total realistic estimate:** Not a sum of buckets. Five buckets are independently XL, plus an orphaned L→XL preset and an uncosted XL integration tax. Floor is **multiple months of concentrated work trending toward a standing maintenance team**, with permanent ongoing cost from the upstream treadmill. There is no credible "small first slice" that delivers parity, because the loop (4.1) cannot run usefully without tools (4.2), permissions (4.5), and the preset content, and those drag in compaction (4.8) and persistence (4.6) on any non-trivial session.

## 6. What we underestimated (adversarial pass)

A self-critical pass surfaced costs the per-bucket inventory missed. Honesty cuts both ways — one item is an over-cost.

- **The `claude_code` preset CONTENT is orphaned between buckets (HIGH).** `session.ts:687` sends `systemPrompt:{type:'preset',preset:'claude_code',append}` (verified). Both the context-management and subagents buckets punt on who re-authors the preset *body* — and no bucket owns it. The instruction body plus dynamic sections (cwd, git status, CLAUDE.md/AGENTS.md memory, date, directory layout, full tool-spec text) are baked into the 1.5MB `assistant.mjs` / 856KB `sdk.mjs` bundles, undocumented, changing every release. Without it the model behaves nothing like Claude Code — tool-calling quality, memory awareness, and git etiquette all regress. **L→XL on its own, plus ongoing maintenance forever.**

- **Integration cost is entirely uncosted — the most systematic under-cost (HIGH).** Every bucket priced itself in isolation, but the couplings are load-bearing and the efforts **do not sum**: the subagent loop (4.7) must re-enter the permission engine (4.5), fire Pre/PostToolUse/Subagent* hooks (4.4), and route MCP (4.3) on *every nested tool call*; hooks (4.4) cannot fire ~half their events until compaction (4.8), subagents (4.7), and worktrees exist; compaction (4.8) depends on readFileState owned by the tool layer (4.2). Wiring these correctly is itself an XL effort no bucket claims.

- **Built-in tools output-field parity is a drift treadmill, not a one-time port (HIGH).** `BashOutput.gitOperation`, `persistedOutputPath`, `staleReadFileStateHint`, NotebookEdit diffs, `AskUserQuestion.response` (added in 0.3.158) change shape every SDK bump, and the Claudius *client* reads them directly to drive UI rails. Failure mode is silent: no type error, the field just goes missing at runtime. Confirmed `shell.ts` is wired **only** to the /git console route, so even the reduced tool set starts near-zero on the agent path.

- **`settingSources` is unset today, hiding a shared merge dependency (MEDIUM).** Verified: `session.ts` never sets `settingSources`, so the SDK defaults to loading user+project+local+managed and performs the restrictive-only / managed-only / defaultMode-escalation merge for free — under *both* the permissions and hooks engines. Native means owning the full tier-merge precedence for both, and a mismatch is silent (rules simply stop applying after cutover).

- **Thinking-replay is an SDK bug, and the cost flips both ways (MEDIUM).** `thinking-replay-recovery.ts:5-20` states the 400 is caused *by* the SDK reassembling streamed turns from per-block JSONL so they no longer byte-match signed thinking blocks. A native loop holding the live in-memory message could avoid this class entirely — a real native upside the study omitted — *but* only until persistence (4.6) and compaction (4.8) serialize-then-rehydrate signed blocks, at which point the bug re-enters through that path. The interaction is uncosted.

- **Auth/billing is a strategic bind, not just a constrained sub-task (HIGH).** Technically the subscription OAuth token *can* hit raw `/v1/messages` with the `oauth-2025-04-20` beta — so it isn't a wall. But it forces a fork: (a) reuse the token = constrained to the claude_code identity/scope, ToS-exposed, and you **lose the system-prompt freedom that is the entire reason for going native**; or (b) require `ANTHROPIC_API_KEY` = clean but converts every user from flat Pro/Max to per-token billing. No path is both native-free and product-preserving.

- **Over-cost, in fairness: WebSearch (LOW).** Bucket 4.2 treats WebSearch as a near-blocker needing a third-party provider. Anthropic ships a server-side `web_search` tool on the raw Messages API; if available on the account/model it is a tool you declare, not a provider you vendor. Needs a one-line live verification rather than a hard-gap budget.

**Cross-cutting maintenance reality:** the SDK is not a thin binding being shed — `assistant.mjs` (1.5MB) and `sdk.mjs` (856KB) *are* the entire Claude Code agent. This repo bumps the SDK constantly (recent `bump claude-agent-sdk to 0.3.158`) and ships `scripts/sdk-update/` to automate it. Going native converts every free upstream update — tools, prompt, formats, auth betas — into a manual reimplement-and-retest obligation, and forks the on-disk formats so Claudius and the terminal CLI silently diverge for users who use both. The test surface alone (loop correctness, every executor, sandboxing, non-deterministic summary quality, security-critical permission matching, format serialization) is several times larger than the current repo and much of it cannot be covered by deterministic unit tests.

## 7. Recommendation

**No-go.** Do not step outside the SDK to reimplement the agent loop natively on the raw Messages API.

The decision is not close. Five of the nine capability buckets are independently XL, an L→XL `claude_code` preset body is owned by no one, and an XL integration tax sits on top because the buckets are mutually dependent (subagents re-enter permissions, hooks, and MCP on every nested call; hooks need compaction/subagents/worktrees to even fire; compaction needs the tool layer's readFileState). The honest total is multiple months trending toward a standing maintenance team, and the *best-case* product outcome is parity-minus-divergence — never better than today.

**The single biggest blocker:** auth/billing (4.9). The Claude subscription OAuth token is gated to the `claude_code` identity and scope, which means a native loop very likely **cannot send arbitrary system prompts on the subscription path** — that freedom is the entire stated reason for going native. So the project is self-defeating: to keep flat Pro/Max billing you re-impose the exact system-prompt constraint you set out to escape; to escape it you force every user onto per-token `ANTHROPIC_API_KEY` billing, a clear product regression. Verify this gate against the live API before any further investment, but treat it as the gating decision, not a detail.

**The structural reason it cannot be slice-delivered:** the SDK is not an abstraction being removed — `assistant.mjs` (1.5MB) and `sdk.mjs` (856KB) *are* the Claude Code agent. "Going native" means permanently forking Claude Code and hand-tracking every upstream release (this repo already bumps the SDK constantly and ships `scripts/sdk-update/` to keep up), forfeiting all free updates and CLI compatibility.

**Conditions under which to revisit:**
- Anthropic publishes a stable, documented OAuth path that permits arbitrary system prompts on subscription billing **and** a versioned tool/output-field/transcript contract. Absent both, the treadmill and the auth bind remain.
- The actual goal narrows to *observability/control* (drive and watch the loop from Claudius's UI) rather than *replacing* the loop. In that case the right move is to push for additional seams through the SDK's existing `SDKControlRequest` surface and `includeHookEvents`/control-request hooks — not to fork.

**If, despite this, exploration proceeds anyway** — sequence by lowest risk-per-value to fail fast: (1) MCP runtime (4.3, the only standalone L, real `@modelcontextprotocol/sdk` leverage); (2) a native-format session store (4.6) explicitly dropping CLI-compat; (3) the reduced tool set (4.2: Read/Edit/Write/Bash/Grep/Glob) *without* sandboxing; then reassess before touching permissions, compaction, subagents, or the preset body — and before sinking cost into the auth fork. But the recommendation stands: **stay on the SDK.**

## 8. Proof-of-concept

See `scripts/native-harness-spike/`. Demonstrates (in code; not run live here)
a single read-tool round-trip on the raw Messages API: model requests a tool,
harness executes it, feeds the result back, model produces a final answer.
Everything the SDK gives for free (the tool
*implementation*, permission gating, hooks, streaming-to-UI) is stubbed inline
and annotated `GAP:` — which is exactly the ~95% the inventory above costs.
Authored and type-checked; **not** run live in this environment (no API
credentials present, and per §4.9 the raw-API-key path is not the SDK's
subscription auth).
