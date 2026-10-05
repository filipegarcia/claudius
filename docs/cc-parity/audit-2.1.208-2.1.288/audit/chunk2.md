# CC parity audit — chunk2 (CLI 2.1.274 – 2.1.280)

Repo audited: `<repo>` @ `cf6b644` (= origin/main), SDK 0.3.288 (CLI 2.1.288).
**2.1.279 is absent from the chunk** (no changelog section; slice covers 2.1.274, .275, .276, .277, .278, .280).

## Provenance / git forensics (read before the table)

| version | bot run note | what actually landed on HEAD |
|---|---|---|
| 2.1.274 | claims memory-critical banner shipped (`lib/server/memory-monitor.ts`, `MemoryWarningBanner.tsx`, `memory_critical` SSE event, unit + e2e specs) | **Phantom implementation.** `rg "memory_critical\|MemoryWarningBanner\|memory-monitor" lib components app instrumentation.ts` → 0. `git log --all -S memory_critical` / `-S MemoryWarningBanner` → 0 commits on any ref. Local `cc-parity/2.1.274` has no commits beyond main. |
| 2.1.275 | 4 items | Commit `4e05d7a` is an ancestor of HEAD; all 4 verified by grep below. Send-now later reworked by `534f960` (2.1.281 semantics, `priority:"now"`). |
| 2.1.276 | fix-only | nothing to land. |
| 2.1.277 | **no local note**; note exists only in git (`cdc76aa`) | **Orphaned.** `3b66af8 feat(cc-parity): 2.1.277 — AGENTS.md fallback, invisible-Unicode prompt hardening, deprecate taskOutputMaxChars` + `cdc76aa` + `7da1561` live only on `origin/sdk-update/0.3.275`; PR #261 (`bc23418`) merged an earlier tip of that branch, so none are ancestors of HEAD. taskOutputMaxChars deprecation later landed independently via the SDK path; AGENTS.md fallback did **not**. |
| 2.1.278 | 0 B items | correct; re-checked against SDK 0.3.288 (still no signal). |
| 2.1.280 | 4 items (Opus 5.5 probe pin, @-ranking, /skills overlay, invisible-Unicode) — "parked" | PR #265 (`29eb20d`) merged; all 4 present on HEAD (grep below). But the bot's skip of "paste >800 chars marked" is a **false-rationale skip** (SDK 0.3.288 has `inline_pastes`/`pasted_content`), and Opus 5.5 pricing was missed. |

## Classification

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.274 | Visible warning when memory usage is critical, with steps to free memory / restart | B | missing | Phantom (see above). `rg "memory_critical\|MemoryWarningBanner\|memory-monitor\|freemem" lib components app instrumentation.ts` → 0. SDK has no memory event (`rg -i "memory.?(usage\|pressure\|critical)" sdk.d.ts` → 0). Generic loop notifications arrive as `system/notification` {key,text,priority} (`sdk.d.ts:5467-5477`) but Claudius has no handler: falls to text-less `system/notification` pill (`lib/client/use-session.ts:4464-4467`; not in `SUPPRESSED_SYSTEM_SUBTYPES`, `lib/client/sdk-message-filters.ts:267-275`). Would live in `lib/server/` monitor + composer banner stack in `components/chat/ChatSurface.tsx`. |
| 2.1.274 | `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` env var | A | n-a | Read by CLI; Claudius has no env-var catalog in its settings UI (`rg "MCP_TIMEOUT\|CLAUDE_CODE_" app/settings/page.tsx lib/server/settings.ts` → prose mentions only); spawn env inherits `process.env`. |
| 2.1.274 | `effort` attribute on `claude_code.llm_request` OTel span | A | n-a | engine telemetry; no OTel UI in Claudius (`rg "OTEL_\|otelHeadersHelper" app/settings lib/server/settings.ts` → 0). |
| 2.1.274 | `claude_code.managed_settings_resolved` OTel event / `OTEL_LOG_MANAGED_SETTINGS` | A | n-a | same as above. |
| 2.1.274 | gateway `store.connect_timeout_seconds` | C | n-a | Claude apps gateway product. |
| 2.1.274 | `enduser.sub` in gateway telemetry | C | n-a | gateway/Desktop/Cowork. |
| 2.1.274 | gateway warning >256 open upstream requests | C | n-a | gateway. |
| 2.1.274 | Click-to-expand collapsed teammate & agent messages (fullscreen) | B | implemented | `components/chat/TaskBlock.tsx:71,109` (collapsible subagent block); `components/chat/PeerMessageHeader.tsx:136-142` (peer/teammate message expand toggle). |
| 2.1.274 | stream-json startup no longer waits for deferred MCP servers | A | n-a | engine startup. |
| 2.1.274 | Monitor tool final output + exit in one notification | A | n-a | engine. |
| 2.1.274 | Artifact tool errors / publish-on-stale-version stopped (2 bullets) | A | n-a | engine tool behaviour. |
| 2.1.274 | Safety checks before removing agent worktree with submodules | A | n-a | Claudius never removes worktrees itself (`rg "worktree remove\|removeWorktree\|deleteWorktree" lib app components` → 0). |
| 2.1.274 | `OTEL_LOG_RAW_API_BODIES=file:` index.jsonl / ids | A | n-a | engine telemetry. |
| 2.1.274 | gateway boot retries / spend-limit / sign-in rate-limit errors (3 bullets) | C | n-a | gateway. |
| 2.1.274 | v2 MCP client + 2026-07-28 negotiation default (`MCP_SDK_GENERATION`, `MCP_PROTOCOL_NEGOTIATION`) | A | n-a | engine MCP transport; no env catalog. |
| 2.1.274 | `/code-review` leaner inline prompts | A | n-a | bundled skill. |
| 2.1.274 | `"type": "sdk"` MCP entries skipped with warning | A | n-a | Claudius add-server form only offers stdio/http/sse (`app/[workspaceId]/mcp/page.tsx:444-446`). |
| 2.1.274 | Artifact watching no longer starts a turn | A | n-a | engine. |
| 2.1.274 | Plugin/marketplace clones leave Git LFS pointers | A | n-a | engine installer. |
| 2.1.274 | Self-hosted runners skip read-only repo | C | n-a | runner. |
| 2.1.274 | `/status` GitHub line → "Cloud sessions"; cloud copy changes | C | n-a | Claudius `StatusOverlay.tsx` has no GitHub/cloud row. |
| 2.1.274 | [VSCode] continue step interrupted by window reload + setting | C | n-a | VS Code. |
| 2.1.274 | [VSCode] Memory & Instructions in Customize menu | C | n-a | analog exists: `app/[workspaceId]/memory/page.tsx`. |
| 2.1.274 | [VSCode] `claudeCode.lockEditorGroups` | C | n-a | VS Code. |
| 2.1.274 | [VSCode] screen-reader "You"/"Claude" announcements | C | n-a | screen-reader. |
| 2.1.274 | [VSCode] default global gitignore → XDG path | C | n-a | VS Code. |
| 2.1.274 | [web] "Compare against" branch picker; routine retry/on-hold changes (3) | C | n-a | cloud product. |
| 2.1.274 | [Claude Tag] Guests setting; checklist cap; removed guest note (3) | C | n-a | Slack. |
| 2.1.274 | [Code Review] finding wording; skip-cause links (2) | C | n-a | GitHub app. |
| 2.1.274 | FIX: transcript renumbering ordered lists in your own messages (`3. 2. 1.` → `3. 4. 5.`; `N)` markers) | F | missing | Claudius is worse: `components/chat/Markdown.tsx:262-264` `ol({ children })` drops react-markdown's `start` prop, so `3. 2. 1.` renders **1. 2. 3.** and `N)` renders as `N.`. User bubbles go through it (`components/chat/UserMessage.tsx:296`); same override also renumbers assistant lists split by code blocks (a list resuming at "2." renders "1."). |
| 2.1.274 | FIX: AskUserQuestion preview notes attached to wrong option / dropped on Enter | F | n-a | Claudius has the preview pane (`components/chat/AskUserQuestionPrompt.tsx:80-91,525`) but no per-option notes/`annotations` at all (`rg -i "annotations\|notes" AskUserQuestionPrompt.tsx` → 0), so the bug can't occur. |
| 2.1.274 | FIX: MCP errors showing `${VAR}`-resolved secrets | F | n-a | Claudius doesn't expand `${VAR}` itself (`rg '\$\{\|expandEnv' lib/server/mcp.ts` → 0); renders SDK `status.error` (`mcp/page.tsx:288-290`) → engine fix covers it. |
| 2.1.275 | Gateway sign-in names/confirms account | C | n-a | gateway sign-in. |
| 2.1.275 | …and `/status` shows the signed-in account | B | implemented | `components/overlays/StatusOverlay.tsx:23,67` Account row (account-switcher profile; adapted). |
| 2.1.275 | Send-now key (Ctrl+Enter) interrupts/joins turn and sends all queued; sent+queued messages gray until model receives them | B | partial | Ctrl+Enter → `components/chat/PromptInput.tsx:974-978`; `app/api/sessions/[id]/queue/send-all/route.ts`; "Send all now" `components/chat/QueueIndicator.tsx:76-81`; reworked to `priority:"now"` (`lib/server/session.ts:3713-3735`). Missing: gray-until-received styling for sent bubbles (`rg -i "pending\|unacked\|awaitingAck" components/chat/UserMessage.tsx` → only hover-opacity classes); Ctrl+Enter ignores text currently typed in the composer (handler returns before `submit()`). `ctrl+x ctrl+s` chord = C. |
| 2.1.275 | Startup warning when `otelHeadersHelper` fails | A | n-a | Claudius doesn't expose `otelHeadersHelper` (`rg otelHeadersHelper app lib` → 0). |
| 2.1.275 | Sync claude.ai skills/plugins; `syncClaudeAiSkills`/`syncClaudeAiPlugins` opt-outs | B | implemented | `app/settings/page.tsx:775-783`; `lib/server/settings.ts:262-272`. |
| 2.1.275 | `/plugin install <p> --marketplace <source>` | B | implemented | `app/plugins/page.tsx:227-235,281-285`; `lib/shared/plugin-ref-lint.ts:40-58`. |
| 2.1.275 | `--system-prompt` dynamic-boundary global caching | A | n-a | Claudius uses array-form systemPrompt. |
| 2.1.275 | `/desktop` error explains why | C | n-a | CLI→Desktop handoff. |
| 2.1.275 | Artifact publish/read results, NUL warning, retry, update-in-place guidance, one-word icon (5) | A | n-a | engine tool. |
| 2.1.275 | Pasted/attached images saved where Claude can open them as files | A | n-a | engine (applies to SDK hosts); Claudius sends images inline. |
| 2.1.275 | Plan-usage reads shared across processes | A | n-a | engine. |
| 2.1.275 | `ListPlugins` tool description | A | n-a | engine. |
| 2.1.275 | Terminal-slow responsiveness | C | n-a | TTY. |
| 2.1.275 | Write/Edit results in synced account-skills folder | A | n-a | engine. |
| 2.1.275 | `/logout` revokes gateway token | C | n-a | gateway. |
| 2.1.275 | Hosted sessions keep permission prompt across container restart | C | n-a | hosted. |
| 2.1.275 | Claude in Chrome auto-mode per-site check | C | n-a | Chrome ext. |
| 2.1.275 | npm-source plugins via `npm pack --ignore-scripts` | A | n-a | engine installer. |
| 2.1.275 | Routine runs republish editable artifacts; removed one-off routine startup notice (2) | C | n-a | cloud routines. |
| 2.1.275 | [VSCode] view/edit/delete saved memory | C | n-a | analog exists: `app/[workspaceId]/memory/page.tsx:221,348-350`. |
| 2.1.275 | [VSCode] send image without text | C | n-a | analog exists: `PromptInput.tsx:795` (`if (!text && images.length === 0) return;`). |
| 2.1.275 | [VSCode] Retry link when MCP list fails | C | n-a | analog: Refresh button `app/[workspaceId]/mcp/page.tsx:125-128`. |
| 2.1.275 | [VSCode] per-change accept/reject in proposed-diff tab | C | n-a | no proposed-change diff tab in Claudius. |
| 2.1.275 | [VSCode] agent-map pill/sort; New session in sidebar; queued msg waits at bottom (3) | C | n-a | analog for last: `QueueIndicator.tsx`. |
| 2.1.275 | [web] "New routine" button; not-your-routine guidance (2) | C | n-a | cloud. |
| 2.1.275 | [Claude Tag] attach conditions; CloudWatch/GCP/Datadog presets; Grid notices (4) | C | n-a | Slack. |
| 2.1.275 | FIX: `@`-file suggestions buried below MCP resources with custom `fileSuggestion` or `@.`/`@./` | F | partial | Picker has no MCP resources (half n-a), but `@./src` is sent un-normalised (`components/chat/AtMentionPicker.tsx:60`) and `listFs` scores against `relPath` without a leading `./` (`lib/server/fs-list.ts:159-176`) → substring miss, subsequence needs `.` before `/` → near-empty results. Low. |
| 2.1.275 | FIX: plugin/marketplace messages showing tokens in URLs | F | n-a | messages come from engine (fixed there); Claudius only shows the user's own settings values in an editor (`app/plugins/page.tsx:707`). |
| 2.1.276 | (only one Fixed bullet — advisor tag behind proxy) | — | n-a | engine fix. |
| 2.1.277 | AGENTS.md read when project has no CLAUDE.md; change under "Project instructions" in `/config` | B | missing | Engine side is automatic (built-in `agents_md` feature; option `instructionFiles` = `claude-md` / `claude-md-or-agents-md` (default) / `claude-md-and-agents-md` / `managed-only`, per CLI 2.1.288 binary strings; not typed in `sdk.d.ts`). Claudius Memory page scopes hard-wired to CLAUDE.md: `lib/server/claudemd.ts:29-32`; `rg -i "agents\.md\|agents_md\|instructionFiles" lib app components` → only a comment (`lib/shared/prompt-audit.ts:88`) + shiki lang map. Orphaned implementation in `3b66af8` (origin/sdk-update/0.3.275, not in HEAD). No `instructionFiles` setting UI. |
| 2.1.277 | `CLAUDE_GATEWAY_PROXY_IS_EGRESS_BOUNDARY` | C | n-a | gateway. |
| 2.1.277 | gateway upstream `headers:` | C | n-a | gateway. |
| 2.1.277 | Line noting a background task update is waiting while `/tasks` panel is open | C | n-a | TUI redraw; Claudius panels re-render reactively. |
| 2.1.277 | SDK/-p first turn no longer waits on CLAUDE.md lookup | A | n-a | engine. |
| 2.1.277 | gateway loopback error names `CLAUDE_GATEWAY_ALLOW_LOOPBACK` | C | n-a | gateway. |
| 2.1.277 | `/plugin` Installed: MCP server shows owning plugin | B | implemented | implicit: status-only servers are listed under their full SDK name `plugin:<plugin>:<server>` (`app/[workspaceId]/mcp/page.tsx:97-105,217`) with a `plugin` source badge (`:231-243`). No plugin-name field in `McpServerStatus` (`sdk.d.ts:1233-1283`). |
| 2.1.277 | `claude plugin install` says when newer version exists | A | n-a | engine output rendered verbatim. |
| 2.1.277 | Startup notice overflow "N more notices hidden" | C | n-a | TUI. |
| 2.1.277 | Invisible Unicode/tag chars removed and cleaned prompt **shown for review** before send | B | partial | Strip exists (`lib/shared/invisible-unicode.ts:56-58`; `PromptInput.tsx:711,792,1294,1773`). Paste path cleans visibly; but typed/IME/drag-dropped invisible chars are stripped at submit and sent immediately (`PromptInput.tsx:792-797`) — no hold-for-review. Orphan `3b66af8` (`sanitize-prompt.ts`) implemented the hold. Low. |
| 2.1.277 | `/ultrareview` nothing-to-review messages | A | n-a | `handler:"sdk"`. |
| 2.1.277 | Artifact links read via Artifact tool | A | n-a | engine. |
| 2.1.277 | dangerous-rm prompt names command + `${VAR:?}` | A | n-a | engine text in generic permission prompt. |
| 2.1.277 | Artifact permission prompt copy | A | n-a | engine. |
| 2.1.277 | Fable always in `/model`, greyed only when org disables | B | implemented | `app/api/sessions/[id]/model/route.ts:42-60,137-141` (`ALWAYS_SHOWN_ALIASES`). Greyed state not buildable: `ModelInfo` has no disabled/policy flag (`sdk.d.ts:1395-1428`). |
| 2.1.277 | Bash sandbox instructions first-party wording on Bedrock/Vertex/Foundry | A | n-a | engine. |
| 2.1.277 | `/ultrareview` non-interactive refuses w/o base branch | A | n-a | engine. |
| 2.1.277 | Subagent results reach main agent under a header, indented | A | n-a | engine framing (display impact → see 2.1.280 F row). |
| 2.1.277 | Workflow `agent()` prompts framed as script text on 3P | A | n-a | engine. |
| 2.1.277 | Removed Haiku auto-title for `-p` outside SDK/IDE | A | n-a | not applicable to SDK host. |
| 2.1.277 | Removed TaskOutput tool; `taskOutputMaxChars` / `TASK_MAX_OUTPUT_LENGTH` no effect | B | implemented | `app/settings/page.tsx:1250-1261` (deprecated desc); `lib/server/settings.ts:374-379`. |
| 2.1.277 | [VSCode] Sign out row + `/logout` | C | n-a | analog `lib/shared/slash-commands.ts:170`. |
| 2.1.277 | [VSCode] background shells in agent map with Stop + `/tasks` | C | n-a | analog `components/panels/widgets/BackgroundBashes.tsx:73`; `slash-commands.ts:108`. |
| 2.1.277 | [VSCode] Copy response button + `/copy` | C | n-a (judgement) | `/copy` exists (`slash-commands.ts:255`, `ChatSurface.tsx:1648-1661`); no per-response copy button (`rg -i "copy\|clipboard" components/chat/AssistantMessage.tsx` → comment only; UserMessage has one). |
| 2.1.277 | [VSCode] auto-archive notice + "Unarchive all" | C | n-a | Claudius has no session archive concept (`rg -i "archiv" components app/sessions` → 0). |
| 2.1.277 | [VSCode] session cost/tokens in Account & usage dialog | C | n-a | analog `/cost` `components/overlays/CostOverlay.tsx`. |
| 2.1.277 | [web] env picker sections; org envs read-only; "Cloud sessions" label (3) | C | n-a | cloud. |
| 2.1.277 | [Claude Tag] Pylon EU host | C | n-a | Slack. |
| 2.1.277 | FIX: headless resume starting cost totals at zero | F | n-a | Claudius already reconciles its own baseline with the SDK's resumed totals (`lib/server/session.ts:7621-7656`, `reconcileUsageBaselineOnFirstFold`). |
| 2.1.278 | Auto mode defaults to server-side classifier; `CLAUDE_CODE_AUTO_MODE_SERVER=0`; warns on billed fallback | A | n-a | engine/billing; warning text arrives from engine (if via `system/notification`, Claudius shows a text-less pill — see 2.1.274 row). |
| 2.1.278 | `/status` "Auto mode server" row | B | missing (blocked) | No SDK signal in 0.3.288: `rg -i "auto_?mode_?server\|autoModeServer\|billed" sdk.d.ts` → 0 (only `supportsAutoMode` `sdk.d.ts:1427`). Would go in `components/overlays/StatusOverlay.tsx`. Not actionable until SDK exposes it. |
| 2.1.280 | Claude Opus 5.5 (`claude-opus-5-5`), default Opus, 1M ctx, $4/$20, $0.20 cache read | B | partial (low) | Probe pin `app/api/models/probe/route.ts:54-60`; advisor `lib/shared/advisor.ts:33,75,345,369`; picker is SDK-driven. Pricing residue: browser-safe estimator `lib/shared/cost-pricing.ts:33-53` prices every `opus` id at $15/$75/$1.50 (~3.75× high for Opus 5.5; already wrong for Opus 4.5–4.8) — used by the live cost tile `lib/client/use-session.ts:2633` (transient; replaced by `usage_snapshot` at turn end) and the legacy-session resume estimate `lib/server/session.ts:7720`. Bundled `lib/server/litellm-prices.json` (snapshot 2026-05-28) lacks `claude-opus-5-5` → `priceForModel` family fallback (`lib/server/litellm-pricing.ts:285-296`) = `claude-opus-4-1` ($15/$75) offline / before first refresh; the runtime cache `~/.claude/.claudius-litellm-prices.json` on this machine already has `claude-opus-5-5`, and `/cost` prefers JSONL `costUSD` when present (`lib/server/cost-aggregate.ts:217-219`). |
| 2.1.280 | Mouse wheel/click in fullscreen `/skills`, `/plugin` lists | C | n-a | TUI. |
| 2.1.280 | `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` | A | n-a | engine; no env catalog. |
| 2.1.280 | Hook output sizes in `hook_execution_complete` OTel | A | n-a | telemetry. |
| 2.1.280 | Reverted `ctrl+l`/`cmd+k` transcript clear | C | n-a | Claudius never shipped it (2.1.260 run-note classified C; no handler: `rg -i "clearTranscriptView\|ctrl\+l" components lib` → 0). |
| 2.1.280 | `/permissions` focus return, tab nav, confirmations default No (2) | C | n-a | TUI focus model; Claudius page deletes rules without a confirm. |
| 2.1.280 | `/cost` cache-miss causes name thinking changes | C | n-a | Claudius `/cost` has only a miss ratio (`CostOverlay.tsx:166`), no causes list; base feature predates slice. |
| 2.1.280 | Artifact tool tells user when it can't read a link | A | n-a | engine. |
| 2.1.280 | `/install-github-app` "Esc to cancel" | C | n-a | TUI. |
| 2.1.280 | `/artifacts`, `/workflows` scrollbar | C | n-a | TUI. |
| 2.1.280 | Workflow progress tree dim dot instead of ⟳ | C | n-a | TUI glyph. |
| 2.1.280 | `/plugin` Add Marketplace form layout | C | n-a | TUI. |
| 2.1.280 | `/workflows` detail double rule | C | n-a | TUI. |
| 2.1.280 | Language-less code blocks colored like inline code | C | n-a | Claudius `CodeBlock.tsx` already gives every fence full chrome. |
| 2.1.280 | `/btw` during running tool | A | n-a | `handler:"sdk"` (`slash-commands.ts:123`). |
| 2.1.280 | UserPromptSubmit hook timeout notice names hook | A | n-a | engine text. |
| 2.1.280 | `@` suggestions: filename match outranks folder-only match | B | implemented | `lib/server/fs-list.ts:150-179`. |
| 2.1.280 | Artifact pages (print/confirm/dark mode) | A | n-a | artifact runtime. |
| 2.1.280 | `/ultrareview` keeps renamed key-file copies local | A | n-a | engine. |
| 2.1.280 | Cross-session messaging warning explains `--debug-file` | C | n-a | CLI flag. |
| 2.1.280 | Default model on Pro/Team Standard → Opus | A | n-a | no hardcoded default model (`rg -i "DEFAULT_MODEL\|defaultModel\s*=" lib app components` → 0). |
| 2.1.280 | Effort saved before per-model `/effort` no longer applies to new models (Opus 5.5) | B | partial | Session picks persist per model via SDK `updateSettings` (`lib/server/session.ts:5283-5286`; `sdk.d.ts:5106`). But Settings catalog exposes only legacy top-level `effortLevel` described as "Persisted effort level for supported models." (`app/settings/page.tsx:1033-1038`); `modelSettings.<model>.effortLevel` only via raw JSON (`:1042-1045`). Low. |
| 2.1.280 | Opus 4.7/4.8/Fable 5 stop holding launch-default effort | A | n-a | engine precedence. |
| 2.1.280 | `/autocompact`, `/fast` footer hints (2) | C | n-a | TUI copy. |
| 2.1.280 | Self-hosted runner git hooks / `GIT_ALLOW_PROTOCOL` | C | n-a | runner. |
| 2.1.280 | Marketplaces imitating reserved names refused | A | n-a | engine. |
| 2.1.280 | `PermissionRequest`: agent-type hook no longer runs; error points to command/http | B | missing | Hooks editor offers `agent` for every event incl. PermissionRequest (`app/[workspaceId]/hooks/page.tsx:462-472,398-400`); no per-event handler restriction (`lib/shared/hook-events.ts:62,143-150`; `rg -i "allowedHandler\|supportedHandler\|handlerTypes" lib app` → 0). |
| 2.1.280 | [VSCode] Status dialog / `/status` | C | n-a | analog `StatusOverlay.tsx`, `ChatSurface.tsx:1504`. |
| 2.1.280 | [VSCode] Sandbox dialog (mode, unsandboxed fallback, excluded commands) | C | n-a (judgement) | Claudius sandbox = workspace toggle only (`components/workspaces/WorkspaceForm.tsx:75-83`); `rg "excludedCommands\|allowUnsandboxedCommands" app lib` → 0. |
| 2.1.280 | [VSCode] Claude in Chrome dialog | C | n-a | `/chrome` no-op (`slash-commands.ts:187`). |
| 2.1.280 | [VSCode] Export conversation `/export` | C | n-a | analog `ChatSurface.tsx:1194`. |
| 2.1.280 | [VSCode] skill source, token estimate, on/off click + `/skills` | B | implemented | `components/overlays/SkillsOverlay.tsx:37,77-104,158-162`; `app/api/settings/skill-overrides/route.ts`; `lib/server/settings.ts:319`. |
| 2.1.280 | [VSCode] typed `/plan` | C | n-a | analog `ChatSurface.tsx:1420`. |
| 2.1.280 | [VSCode] Paste >800 chars or >2 line breaks marked so Claude can tell it from typed text | B | missing | SDK `SDKUserMessage.pasted_content` (added 0.3.277) / `inline_pastes?: string[]` (`sdk.d.ts:6294-6299`); CLI wraps them in `<pasted_content>` and its system prompt treats that content as not user-authored (prompt-injection provenance). `rg "pasted_content\|inline_pastes\|pastedContent" lib components app` → 0. Skipped twice on false rationales: sdk-updater 0.3.280 note ("transcript UI has no use for it" — the consumer is the model, not the UI) and cc-parity 2.1.280 note ("no confirmed protocol the SDK reads" — field existed since 0.3.277). |
| 2.1.280 | [VSCode] invisible Unicode stripped from pastes w/ notice and before send | B | implemented | `lib/shared/invisible-unicode.ts:56-58`; `PromptInput.tsx:711,792,1294,1773`. |
| 2.1.280 | [VSCode] "Open in New Tab" beside current group | C | n-a | VS Code. |
| 2.1.280 | [web] admin Routines location; app-openable files; removed empty repo picker (3) | C | n-a | cloud. |
| 2.1.280 | [Claude Tag] Working indicator/Stop/title; guest notice; GitHub banner reasons (3) | C | n-a | Slack. |
| 2.1.280 | [Code Review] REVIEW.md size-limit note | C | n-a | GitHub app. |
| 2.1.280 | FIX: subagent hand-back messages showing internal provenance preamble | F | missing | Frame confirmed in stored `tool_result` content: "[Subagent hand-back] The text below is the final report of a subagent… The report follows:" + indented report (e.g. `~/.claude/projects/<project>/<session>.jsonl`, 4 hits; same string in CLI 2.1.288 binary). Claudius renders raw `result.content` in the "Returned to parent" `<pre>` (`components/chat/TaskBlock.tsx:192-204`); `rg -i "hand-back\|Subagent hand" lib components app` → 0. |
| 2.1.280 | FIX: invisible-char cleanup removed ZWNJ | F | implemented | Claudius regex excludes U+200C/U+200D (`lib/shared/invisible-unicode.ts:56`). |
| 2.1.280 | FIX: switched-off skill shows red ✘ instead of dim ◯ | F | implemented | `SkillsOverlay.tsx:160-162` (dim `Circle` + strikethrough). |

## Counts

Classification rows (multi-part bullets merged where marked): 2.1.274 = 32, 2.1.275 = 28, 2.1.276 = 1 (fix-only), 2.1.277 = 29, 2.1.278 = 2, 2.1.280 = 42.

- **A**: 43 · **B**: 19 · **C**: 62 (2 flagged as judgement calls) · **F**: 9 · fix-only placeholder: 1
- **B status**: implemented 10 · partial 4 (Opus 5.5 pricing residue [low]; send-now gray-until-received; invisible-Unicode review hold; legacy `effortLevel`) · missing 5 (memory-critical warning [phantom]; AGENTS.md [orphaned]; PermissionRequest agent-hook guard; paste marking [false-rationale skip]; Auto-mode-server `/status` row [blocked on SDK])
- **F status**: missing 2 (ordered-list numbering; subagent hand-back preamble) · partial 1 (`@./` query) · implemented 2 · n-a 4
