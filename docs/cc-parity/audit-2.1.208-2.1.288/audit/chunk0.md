# Chunk 0 audit — Claude Code 2.1.285–2.1.288 vs Claudius

Repo audited: `<repo>` @ cf6b644 (SDK 0.3.288). Paths below are repo-relative; `sdk.d.ts` = `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. CLI-binary string checks used `strings` on `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`.

Run-note hints: 2.1.288.md, 2.1.287.md (covers 2.1.286+2.1.287), 2.1.285.md. Note contradictions found: 2.1.285 `/tasks` 'no SDK marker' (false — `ambient`/`skip_transcript` exist); 2.1.287 'single pendingPermission slot' (outdated — FIFO queue + '1 of N' exist, so those two rows are implemented); 2.1.288 classified Ctrl+C draft recovery, agents-view search and MCP URL 'I'm done' as C/A (all have browser analogues → B).

## Non-Fixed bullets

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.288 | `$.ui.selection()` for mods | C | n-a | TUI mod API (fullscreen `$.ui.*`); Claudius has no mods host. |
| 2.1.288 | Built-in `gh api` in cloud sessions w/o gh CLI | C | n-a | Cloud-session image tooling. |
| 2.1.288 | Ctrl+C-cleared prompt: Up on empty prompt restores draft (text + pasted images) | B | missing | `components/chat/PromptInput.tsx:953-963` Ctrl+C when idle → `clearInput()`; `clearInput` (`PromptInput.tsx:763-771`) wipes `value` + `images` with no stash. Double-Esc (`:980-993`) also calls `clearInput()`. Plain ArrowUp is unbound (history recall is Cmd/Ctrl+↑ only, `:996-1002`; comment `:1358`). `grep -rniE "clearedDraft\|lastCleared\|stashCleared\|restoreCleared\|undoClear" components lib` → only unrelated `lastClearedSessionId` (/clear session latch, `ChatSurface.tsx:218`). Would live in PromptInput.tsx (stash in clearInput; restore on plain ↑ when composer empty & no picker open). |
| 2.1.288 | Re-authenticate prompt when MCP server asks for more OAuth scope mid tool call | B | partial | Claudius only announces `needs-auth` once at session start (`lib/server/session.ts:6063-6080` `noteMcpNeedsAuthAtStartup` → `mcp_needs_auth_notice`) and the MCP page offers only Reconnect (`app/[workspaceId]/mcp/page.tsx:252`). `grep -rniE "insufficient_scope\|step.?up\|reauth" lib components app` → 0 hits. In the CLI binary the step-up path throws `MCP server "X" needs additional permissions (scope: …) — run /mcp to re-authenticate` (strings in claude-agent-sdk-darwin-arm64/claude), which reaches Claudius as a plain tool error with no affordance. Uncertainty: the TUI's re-auth/"Retry now" dialog is an internal dialog kind (`mcp_url_elicitation`); sdk.d.ts documents no MCP dialog kind for `onUserDialog`/`supportedDialogKinds` (only `refusal_fallback_prompt`, sdk.d.ts:1753-1780) and Claudius wires neither (`grep -rn "onUserDialog\\|supportedDialogKinds" lib` → 0). |
| 2.1.288 | /code-review `--max-findings <n>\|all` | A | n-a | Bundled skill with free-text args; `/code-review` is not in the static registry (`lib/shared/slash-commands.ts`), so it passes through as an SDK-listed command (`components/chat/ChatSurface.tsx:1766-1769`). |
| 2.1.288 | Agents view: Ctrl+F find session by name, Alt+↑/↓ jump groups; rebindable | B | partial | Browser analogue = sessions list. Search box exists (`app/[workspaceId]/sessions/page.tsx:163-184` matches claudiusTitle/customTitle/firstPrompt/sessionId; input `:233-239`) but: no keyboard shortcut to jump to it — `lib/client/shortcuts.ts` registry (`:95-359`) has no session-find action and `components/overlays/CommandPalette.tsx:70` only navigates to /sessions; the input has no `onKeyDown` (Enter does nothing; `sed -n 228,240p … \| grep -c onKeyDown` → 0). Alt+↑/↓ groups: n/a (list not grouped; only branch chips `:273-295`). Rebinding part = A: keybindings.json editor is free-form (`app/[workspaceId]/keybindings/page.tsx:96-99`). See also rows 2.1.287 `n:` filter and 2.1.288 Enter-best-match. |
| 2.1.288 | Screen reader: announce new permission mode on plan approval | C | n-a | Terminal screen-reader mode. |
| 2.1.288 | Auto mode: classifier compacts long conversations instead of prompting/failing | A | n-a | Engine (auto-mode classifier). |
| 2.1.288 | Screen reader: short announcements persist | C | n-a | Terminal screen-reader mode. |
| 2.1.288 | Screen reader: 'answered' beside answered question boxes | C | n-a | Terminal screen-reader mode. |
| 2.1.288 | Improved /usage-credits message for Team/Enterprise | C | n-a | CLI command copy; Claudius links out to claude.ai for credits (`components/chat/LongContextCreditsPanel.tsx`). |
| 2.1.288 | Cloud sessions: first turn doesn't wait for `alwaysLoad:false` stdio MCP | C | n-a | Cloud sessions. |
| 2.1.288 | 'You should know' notes wording (we / main agent / you) | C | n-a | Built-in TUI mod output. |
| 2.1.288 | Artifact DB write refused at size limit — clearer error | A | n-a | Artifact tool engine text. |
| 2.1.288 | Bash permission prompts: shorter reason when part can't be checked | A | n-a | Reason text comes from the engine and is rendered verbatim by `components/chat/PermissionPrompt.tsx`. |
| 2.1.288 | Self-hosted runner `gh api` improvements | C | n-a | Self-hosted runner. |
| 2.1.288 | Remote Control credential renewal recovery | C | n-a | Remote Control. |
| 2.1.288 | Background command time limit only in unattended sessions (-p, Agent SDK, CI, cloud) | A | n-a | Engine. Note: Claudius runs as an Agent SDK session (entrypoint `sdk-ts`), which the CLI does NOT count as attended (attended set in binary: claude-vscode, claude-desktop, local-agent, remote*, …; `CLAUDE_CODE_SESSION_ATTENDED` only propagates to children). So the 30-min/2-h background cap likely still applies to Claudius (entrypoint `sdk-ts`; not verified that the cap uses this predicate) while desktop/VS Code no longer have it; no supported opt-out found (`grep -rn CLAUDE_CODE_SESSION_ATTENDED lib app electron` → 0). Judgement-call only. |
| 2.1.288 | Auto-mode classifier ignores ANTHROPIC_DEFAULT_SONNET_MODEL pin to Sonnet/Opus 5.5 | A | n-a | Engine. |
| 2.1.288 | `claude project purge` → `claude purge` | C | n-a | CLI subcommand. |
| 2.1.288 | Agents view `n:` / Ctrl+F: Enter opens best name match | B | partial | Same surface as row 2.1.288 Ctrl+F: `app/[workspaceId]/sessions/page.tsx:233-239` search input has no Enter handler; `filtered` (`:163-184`) is unranked (insertion order), so there is no 'best match' to open. |
| 2.1.288 | `/autocompact` saves window per model | B | partial | Settings catalog exposes only top-level `autoCompactWindow` (`app/settings/page.tsx:1058-1062`, type number, desc 'Auto-compact window size'). SDK now has `modelSettings.<model>.autoCompactWindow: 'auto'\|number` which *replaces* the top-level value per model and is where /autocompact saves (`sdk.d.ts:8970-8972`). Claudius deliberately leaves `modelSettings.*` to the generic JSON editor (`app/settings/page.tsx:1040-1045`), so editing the top-level field silently does nothing for any model the user already ran /autocompact on. `grep -rn "autoCompactWindow\\|autocompact" app components lib` → only the catalog entry + comments. Would live in app/settings/page.tsx 'Context & compaction'. |
| 2.1.288 | MCP URL prompts: wait for "I'm done, continue" when server can't report completion | B | partial | URL-mode elicitation is rendered (`components/chat/McpElicitationPrompt.tsx:38-76,162-170`) but `openLink()` (`:72-76`) opens the tab and immediately resolves `accept`, so the tool call continues before the user finishes in the browser. Claudius also never consumes the SDK's `system/elicitation_complete` message (`sdk.d.ts:5148-5155`): `grep -rn "elicitation_complete" lib components app` → 0 (only `elicitationId` passthrough at `lib/server/session.ts:3477`, `lib/shared/events.ts:462`). CLI binary: `userConfirmsCompletion:!0` is set exactly when `mode==="url"` and no elicitationId (`…e.mode==="url"&&r===void 0&&{userConfirmsCompletion:!0}`), labelled " I'm done, continue "; with an elicitationId the CLI accepts on open, then shows a waiting state closed by the completion notification. |
| 2.1.288 | [Claude Tag] follow related Slack thread | C | n-a | Claude Tag (Slack). |
| 2.1.288 | [Claude Tag] clearer Configure-page save errors | C | n-a | Claude Tag admin. |
| 2.1.287 | Claude Mods (plugins modify deeper behaviour) | C | n-a | TUI mod host (panes/bands/status lines). |
| 2.1.287 | 'You should know' built-in mod (`cc-plugin-you-should-know@builtin`) | C | n-a | Built-in mod rendered via TUI mod surfaces; registered in the binary for non-`local-agent` entrypoints. Claudius has no mods host. (Low value: could be toggled via enabledPlugins if wanted.) |
| 2.1.287 | Agents view `n:<text>` filter (names + tasks), Enter opens first match | B | partial | Name/first-prompt matching exists (`app/[workspaceId]/sessions/page.tsx:169-178`); Enter-to-open missing (input `:233-239` has no onKeyDown). Merged with 2.1.288 Ctrl+F row. |
| 2.1.287 | OTel `user_prompt.prompt_text` | A | n-a | Engine telemetry. |
| 2.1.287 | URL prompts from MCP servers (2025-11-25) + `bareElicitationCapability` | B | implemented | `lib/server/session.ts:3464-3500` (`onElicitation`, url mode), `components/chat/McpElicitationPrompt.tsx:38-76`, add-server checkbox `app/[workspaceId]/mcp/page.tsx:359,392,403,523-528`. (Follow-up behaviour change is row 2.1.288 "I'm done, continue".) |
| 2.1.287 | Windows: startup warning when Bash deny also disables PowerShell | C | n-a | CLI startup warning (Windows). |
| 2.1.287 | Self-hosted runner built-in `gh api` | C | n-a | Self-hosted runner. |
| 2.1.287 | /config: ‹ › cycling, narrow stacking, PgUp/PgDn | C | n-a | TUI /config. |
| 2.1.287 | Plugin marketplace errors in plain words | A | n-a | CLI-generated text; Claudius installs via `/plugin install` sent to the session (`app/plugins/page.tsx:209-217`). |
| 2.1.287 | Plugin listings note uninstalled deps; update retries install | A | n-a | Engine; Claudius already surfaces plugin load errors incl. unmet deps (`app/api/plugins/route.ts:21-43`, `app/plugins/page.tsx:166` PluginErrorsSection; sdk.d.ts:5952). |
| 2.1.287 | Claude apps gateway Bedrock model-ID error | C | n-a | Gateway. |
| 2.1.287 | SDK: priority 'now' message no longer cancels web fetch/search | A | n-a | Engine; Claudius benefits (send-now path `PromptInput.tsx:967-975`). |
| 2.1.287 | /memory: ←/→ flip on/off settings | C | n-a | TUI key handling. |
| 2.1.287 | /skill names typed mid-message told to Claude as skills | A | n-a | Engine prompt assembly. |
| 2.1.287 | Prompt input border / ❯ contrast in light themes | C | n-a | Terminal theme. |
| 2.1.287 | Remote file delivery: retry once on timeout/502-504 | C | n-a | Cloud/Remote Control. |
| 2.1.287 | File-send temporary failure wording | C | n-a | Cloud/Remote Control. |
| 2.1.287 | Held cross-session message prompt shown between dashed lines | C | n-a | TUI prompt styling. |
| 2.1.287 | MCP/tool permission prompts between dashed lines | C | n-a | TUI prompt styling. |
| 2.1.287 | Headless MCP startup: retry transient remote connect early | A | n-a | Engine. |
| 2.1.287 | Remote session large files stream from disk | C | n-a | Cloud/Remote Control. |
| 2.1.287 | Better explanation when server refuses a sent file | C | n-a | Cloud/Remote Control. |
| 2.1.287 | Large MCP tool results: less memory, smaller session files | A | n-a | Engine. |
| 2.1.287 | Windows: faster Bash tool | A | n-a | Engine. |
| 2.1.287 | Shell write through repo symlink onto sensitive file waits for a person | A | n-a | Engine permission check. |
| 2.1.287 | Opus 4.7+/Fable 1M context by default on Bedrock/Vertex/Foundry/gateway | A | n-a | Engine. Claudius reads the window from `get_context_usage` (`lib/client/useContextWatcher.ts:41-53`); workspace 1M toggle copy already says newer models include 1M (`components/workspaces/WorkspaceForm.tsx:602-606`). |
| 2.1.287 | `claude agents` replies arrive as queued messages; slash cmds run when turn ends | C | n-a | Agents view / engine queueing. |
| 2.1.287 | Whole-tool Bash allow rules prompt for protected-file writes | A | n-a | Engine permission check. |
| 2.1.287 | Right/middle-click paste on release | C | n-a | Terminal mouse handling. |
| 2.1.287 | MCP `alwaysLoad:false` defers all of a server's tools | A | n-a | Engine; Claudius add-server form already exposes alwaysLoad (`app/[workspaceId]/mcp/page.tsx:358,510-515`). |
| 2.1.287 | Screen reader: no cursor pre-park (`CLAUDE_AX_PREPARK_MS`) | C | n-a | Terminal screen-reader mode. |
| 2.1.287 | Auto model switch after flagged message keeps effort | A | n-a | Engine. |
| 2.1.287 | Waiting permission prompts show oldest first | B | implemented | FIFO queue, head shown: `lib/client/use-session.ts:953-959`, enqueue `:2105`. (2.1.287 run note's 'single pendingPermission slot' claim is outdated.) |
| 2.1.287 | [VSCode] 'Run in background' for running command/sub-agent | C | n-a | VS Code. Claudius analogue already exists: Ctrl+Enter send-now moves running tools to background (`PromptInput.tsx:967-975`). |
| 2.1.287 | [VSCode] bg shell/Monitor output on agent-map cards | C | n-a | VS Code; Claudius has `components/panels/BashViewer.tsx`. |
| 2.1.287 | [VSCode] Manage plugins: failed marketplace actions explained | C | n-a | VS Code. |
| 2.1.287 | [VSCode] Chrome 'Enabled by default' also connects editor sessions | C | n-a | VS Code. |
| 2.1.287 | [Claude Tag] task list not reposted | C | n-a | Claude Tag. |
| 2.1.287 | [Code Review] locked-conversation failed-review card | C | n-a | Code Review service. |
| 2.1.286 | "2 of 5" count on stacked permission prompts | B | implemented | `components/chat/PermissionPrompt.tsx:90-96` ("1 of {queueTotal}"), count from `lib/client/use-session.ts:6143-6144`. (Run note claimed this needed a queue Claudius lacked — queue now exists.) |
| 2.1.286 | Mouse support for 'N more' list rows (fullscreen) | C | n-a | TUI fullscreen lists. |
| 2.1.286 | Commit guidance: run `verify` skill before committing | A | n-a | Engine system prompt. |
| 2.1.286 | Send-now in subagent's view backgrounds subagent's command | A | n-a | Engine; Claudius has no per-subagent composer. |
| 2.1.286 | Background-agent replies drop recap | A | n-a | Engine. |
| 2.1.286 | Artifact link reads via WebFetch ask like Artifact read | A | n-a | Engine permission logic. |
| 2.1.286 | fetch/skill/read/sandbox/Chrome/workflow/notebook prompts match edit-prompt look | C | n-a | TUI prompt styling. |
| 2.1.286 | Bash/PowerShell/Monitor prompts show command between dashed lines | C | n-a | TUI prompt styling. |
| 2.1.286 | Fullscreen list scrollbars | C | n-a | TUI. |
| 2.1.286 | External editor (Ctrl+G) opens at cursor line | C | n-a | Terminal $EDITOR; Claudius has no external-editor action (`grep -rniE "external editor\|ctrl\+g" components lib` → only TranscriptSearch Cmd+G). |
| 2.1.286 | Slash suggestions faster; descriptions match by word prefix | B | partial | `components/chat/SlashCommandPicker.tsx:108-123`: description is matched by loose subsequence (`fuzzyScore(filter, haystack) * 0.3`, haystack = name+aliases+description), not word-prefix, so short queries surface unrelated commands. Would live in SlashCommandPicker.tsx `filtered` memo. |
| 2.1.286 | Output style picker opens on current style, description under each name | B | partial | No picker: `/output-style` with no args only toasts current + names (`components/chat/ChatSurface.tsx:1379-1402`); Settings uses a bare `<select>` of `STATIC_OUTPUT_STYLES` names (`app/settings/page.tsx:565-578`). SDK returns names only (`app/api/sessions/[id]/output-style/route.ts:41-49` `available_output_styles: string[]`), so descriptions would need a separate source. Low value. |
| 2.1.286 | /hooks detail closing line wording | C | n-a | TUI copy. |
| 2.1.286 | Fallback notice / thrashing error mention 1M→200K drop | A | n-a | Engine-generated text. |
| 2.1.286 | SDK: re-sent MCP enable for connected server is cheap | A | n-a | Engine; benefits Claudius's `mcp_toggle`. |
| 2.1.286 | Gateway `/protocol` page | C | n-a | Claude apps gateway. |
| 2.1.286 | Prompts sent while idle show in normal colour (not gray) | B | implemented | Claudius never greys a just-sent prompt: no pending/optimistic styling in `components/chat/UserMessage.tsx` / `MessageList.tsx` (`grep -niE "optimistic\|isPending\|pendingSend\|unconfirmed"` → 0); queued messages live separately in `QueueIndicator.tsx`. |
| 2.1.286 | Single retry budget per model call (≤14 requests) | A | n-a | Engine. |
| 2.1.286 | `--bare` changes | C | n-a | CLI flag. |
| 2.1.286 | Send-now moves a skill's shell command to background | A | n-a | Engine. |
| 2.1.286 | WebFetch rate-limited domain check: don't retry in loop | A | n-a | Engine. |
| 2.1.286 | Plugin installs refuse npm git/folder sources | A | n-a | Engine plugin installer (Claudius installs via `/plugin install`). |
| 2.1.286 | List screens align details column | C | n-a | TUI. |
| 2.1.286 | Overflow rows read '↑ N more' | C | n-a | TUI. |
| 2.1.286 | /hooks opens on one list grouped by event | B | implemented | `app/[workspaceId]/hooks/page.tsx:58-63` groups `HOOK_EVENTS` into a single page with an `EventRow` per event (`:195-198`). |
| 2.1.286 | Theme picker scrolls; no number keys | C | n-a | TUI. |
| 2.1.286 | /exit Remove worktree after stopping its servers/shells | C | n-a | TUI /exit flow; Claudius has no worktree-removal flow (`app/api/worktrees/route.ts` is GET-only). |
| 2.1.286 | claude-api skill Managed Agents examples use limited networking | A | n-a | Bundled skill content. |
| 2.1.286 | Removed browser link from /ultrareview output | C | n-a | CLI output. |
| 2.1.286 | [VSCode] Bookmarks side panel | C | n-a | VS Code. Claudius has none (`grep -rni bookmark components app` → only URL comments); low-value idea. |
| 2.1.286 | [VSCode] Questions row with answers in conversation | C | n-a | VS Code; Claudius already keeps answered AskUserQuestion as a historic row (`components/chat/AskUserQuestionPrompt.tsx:277`). |
| 2.1.286 | [VSCode] Option previews in question cards | C | n-a | VS Code; Claudius already renders `preview` (`AskUserQuestionPrompt.tsx:80-91,525-526,668`). |
| 2.1.286 | [VSCode] Rows for terminal output/browser tab/selection sent with a message | C | n-a | IDE context attachments. |
| 2.1.286 | [VSCode] Manage plugins explains still-on plugin / folder clash | C | n-a | VS Code; Claudius plugins page shows per-scope enablement (`app/plugins/page.tsx:69-85`). |
| 2.1.286 | [VSCode] Stop/Escape end only current turn | C | n-a | VS Code. |
| 2.1.286 | [VSCode] status bar item in every window | C | n-a | VS Code. |
| 2.1.286 | [Cloud sessions] routine shows 'Due' when late | C | n-a | Cloud routines. Low-value analogue: Claudius schedule page prints `nextRunAt` verbatim even if in the past (`app/[workspaceId]/schedule/page.tsx:356,532`). |
| 2.1.286 | [Claude Tag] Add channel on spend-limits page | C | n-a | Claude Tag admin. |
| 2.1.286 | [Claude Tag] Slack session titles cleaned | C | n-a | Claude Tag. |
| 2.1.285 | `CLAUDE_CODE_DISABLE_WEB_FETCH` env var | A | n-a | Engine env var; Claudius env is free-form (`app/settings/page.tsx:758-765` EnvEditor), no env catalog (`grep -rn "CLAUDE_CODE_DISABLE_" app components` → 0). WebFetch can also be disallowed via permissions. |
| 2.1.285 | `claude --desktop` | C | n-a | CLI flag. |
| 2.1.285 | `claude plugin configure <plugin>` / `--values-stdin` | C | n-a | CLI subcommand (browser analogue tracked on the [VSCode] plugin-options-form row). |
| 2.1.285 | `claude plugin install --config <server>.<key>=<value>` | C | n-a | CLI flag (see plugin-options row). |
| 2.1.285 | `allowedProviders` managed setting | A | n-a | Engine-enforced managed policy. Claudius doesn't read managed settings (`grep -rniE "managed-settings\|allowedProviders" lib app components` → only settings-page descs), so its account switcher (`lib/shared/accounts.ts:23` kinds oauth-token/api-key/bedrock) won't pre-warn. Judgement-call only. |
| 2.1.285 | `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` | A | n-a | Engine env var (free-form env, see above). |
| 2.1.285 | Chrome native host reports computer name | C | n-a | Claude in Chrome. |
| 2.1.285 | Bedrock/Vertex fall back to older same-tier model | A | n-a | Engine. |
| 2.1.285 | Marketplace errors explain refused git address | A | n-a | Engine text. |
| 2.1.285 | Git URL validation for plugins/marketplaces | A | n-a | Engine. |
| 2.1.285 | Artifact tool results suggest publish in same step | A | n-a | Engine tool text. |
| 2.1.285 | Remote Control /btw sees in-progress turn | C | n-a | Remote Control. |
| 2.1.285 | BMP/HEIC/AVIF/TIFF previews in Claude apps | C | n-a | Claude apps. |
| 2.1.285 | Auto-mode subagents end once report handed back | A | n-a | Engine. |
| 2.1.285 | Bedrock/Vertex unusable-model cache (1 day) | A | n-a | Engine. |
| 2.1.285 | Artifact publish results use fewer tokens | A | n-a | Engine. |
| 2.1.285 | SDK `ping` stream event every 30s during non-streaming fallback | A | n-a | Claudius has no stream-silence watchdog that a long fallback could trip (`lib/client/stream-recovery.ts` only handles EventSource CLOSED; `grep -niE "stall\|watchdog" lib/server/session.ts lib/client/use-session.ts` → none for SDK stream). |
| 2.1.285 | /resume opens a session running in background | C | n-a | `claude --bg` daemon sessions. |
| 2.1.285 | Per-turn perf with many deny rules/MCP tools | A | n-a | Engine. |
| 2.1.285 | Leaving ctrl+o transcript faster | C | n-a | TUI. |
| 2.1.285 | Bedrock/Vertex/Mantle model checks send same headers | A | n-a | Engine. |
| 2.1.285 | MCP tool `_meta['anthropic/alwaysLoad']=false` stays deferred | A | n-a | Engine. |
| 2.1.285 | Background Bash/PowerShell stop after time limit (30 min default, 2 h max) | A | n-a | Engine; refined by 2.1.288 (unattended only) — Claudius counts as unattended, see 2.1.288 row. |
| 2.1.285 | Code Review / /ultrareview run when disableWorkflows on | C | n-a | Code Review service / CLI command. |
| 2.1.285 | Custom `ANTHROPIC_BASE_URL` uses 1M window | A | n-a | Engine; Claudius reads window from `get_context_usage`. |
| 2.1.285 | Team/Enterprise: WebFetch withheld until policy loads | A | n-a | Engine. |
| 2.1.285 | /memory: Auto-memory can't be turned on from bg/tool-started sessions | A | n-a | Claudius sessions are neither (memory toggle `lib/client/useAutoMemory.ts`). |
| 2.1.285 | One-time 'make auto mode default' offer shown on 3P / telemetry off | C | n-a | TUI onboarding offer; Claudius has no such offer (`grep -rniE "make auto mode\|autoModeOffer" lib components app` → 0). |
| 2.1.285 | -p / Python SDK on 3P start in auto mode by default | A | n-a | Claudius always passes `permissionMode` explicitly (`lib/server/session.ts:2813`). |
| 2.1.285 | SigV4 Host header includes non-default port | A | n-a | Engine. |
| 2.1.285 | MCP name `widgets` reserved in cloud/runners | C | n-a | Cloud sessions. |
| 2.1.285 | /ultrareview leaves out symbolic refs | C | n-a | CLI command. |
| 2.1.285 | Windows: project/local env no longer sets system vars | A | n-a | Engine settings merge. |
| 2.1.285 | /tasks folds Claude Code's own background work under one 'System tasks' row | B | partial | SDK DOES mark these tasks: `skip_transcript` / `ambient` on `task_started` (`sdk.d.ts:6072-6079`) — contradicts the 2.1.285 run note's 'no reliable marker' rationale. Claudius persists `ambient` (`lib/server/session-tasks-db.ts:37`, `lib/server/session.ts:8178-8186`) and excludes it from counts (`components/panels/BackgroundTasksPanel.tsx:353-360,407-413`) but still renders every ambient task as its own row; `skip_transcript` is not persisted at all (appears only in comments: `session.ts:8179`, `lib/client/task-status.ts:65-70`). `grep -rni "system tasks\\|systemTasks" components lib app` → 0. Fold should key on `skip_transcript` (ambient also covers user-requested watchers, sdk.d.ts:6077). Would live in BackgroundTasksPanel.tsx + task plumbing. |
| 2.1.285 | /ultrareview requires git ≥2.31 | C | n-a | CLI command. |
| 2.1.285 | /ultrareview partial clone as snapshot | C | n-a | CLI command. |
| 2.1.285 | /ultrareview refuses incomplete partial clone | C | n-a | CLI command. |
| 2.1.285 | Model checks identify as Claude Code | A | n-a | Engine. |
| 2.1.285 | `claude mcp get` hides plugin stdio command/args/env | C | n-a | CLI subcommand. Claudius doesn't leak these either: plugin servers come only from live status with a stub config (`app/[workspaceId]/mcp/page.tsx:99-103`). |
| 2.1.285 | /claude-api blocked from Remote Control | C | n-a | Remote Control. |
| 2.1.285 | `/config chrome=true` points to /config panel | C | n-a | CLI command. |
| 2.1.285 | Project settings can't widen admin sandbox | A | n-a | Engine settings merge. |
| 2.1.285 | [VSCode] note under reload-interrupted last message | C | n-a | VS Code; Claudius already labels interrupted turns (`lib/client/use-session.ts:229-234`). |
| 2.1.285 | [VSCode] Plugin options form (ask for unset options on install; gear to change later) | B | missing | Browser analogue of `claude plugin configure` (2.1.285) + `--config` and of the Fixed bullets about `.mcpb` servers needing Configure (2.1.285) and `--plugin-dir` plugins lacking 'Configure options' (2.1.288). Claudius has a plugins page but no options UI: `grep -rniE "userConfig\|user_config\|pluginConfigs\|configure options\|\.mcpb" lib app components` → 0. SDK settings key exists: `pluginConfigs.<plugin>.options` / `.mcpServers.<server>` (`sdk.d.ts:9029-9046`). Would live in `app/plugins/page.tsx` + `lib/server/plugins.ts` (read manifest `userConfig`, write `pluginConfigs`). Sensitive values go to secure storage in the CLI — needs a story. |
| 2.1.285 | [VSCode] on-demand diagnostics tool | C | n-a | IDE integration. |
| 2.1.285 | [VSCode] Manage plugins failure popup with fix | C | n-a | VS Code. |
| 2.1.285 | [VSCode] confirm before disabling plugin/marketplace that project settings enable | C | n-a | VS Code (low-value analogue on Claudius plugins page). |
| 2.1.285 | [Cloud sessions] MCP_DISCOVERY_CACHE behaviour | C | n-a | Cloud sessions. |
| 2.1.285 | [Claude Tag] DMs for Enterprise seats | C | n-a | Claude Tag. |
| 2.1.285 | [Code Review] says when REVIEW.md wasn't applied | C | n-a | Code Review service. |

## Fixed bullets flagged (F) or checked

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.288 | Fixed `idle_prompt` notification firing while background agents still run | F | missing | Claudius's own idle notification is the analogue: `lib/server/notification-bus.ts:733-758` emits `session_idle` ("Claude finished a turn") on every `result` with no background-work check; `lib/server/session.ts:7557` passes only hasSubscribers/sessionTitle. Session already tracks running work (`session.ts:7329` hasActiveSubagents, `:7350` countActiveBackgroundTasks) but the bus never sees it. |
| 2.1.287 | [VSCode] Fixed user's own /usage or /context opening the built-in dialog | F | missing | `components/chat/ChatSurface.tsx:1714-1724`: `findSlashCommand(head)` (static `ALIAS_INDEX`, `lib/shared/slash-commands.ts:267-268`) → `handler: "native"` always wins for /context, /cost, /usage, /stats (`slash-commands.ts:113,164-165`), even when the SDK lists a user/project/plugin command of that name. SDK `builtin` flag is already carried on suggestions (`slash-commands.ts:274-280`) but not used for dispatch precedence. |
| 2.1.287 | Fixed running-tool dot/spinners moving with Reduce motion on | F | missing | Claudius has no reduced-motion handling at all: `grep -rniE "prefers-reduced-motion\|motion-reduce\|reducedMotion\|reduceMotion" app components lib` → 0; SDK setting `prefersReducedMotion` (`sdk.d.ts:9110`) not in the settings catalog. Low value. |
| 2.1.285 | [VSCode] Fixed message quoting a CC/IDE tag losing rest of its text | F | partial | `lib/client/sdk-message-filters.ts:68-81` `parseSyntheticCliWrapper` turns any user message that *starts* with `<command-name>…</command-name>` or `<local-command-stdout\|stderr>` into a pill and drops text after the closing tag. Only triggers on a leading tag — low value. |
| 2.1.287 | Fixed /advisor pairing checks (Sonnet 5.5 advises Opus 4.7/4.8; refused pairs flagged) | F | implemented | Claudius's own table already reflects it: `lib/shared/advisor.ts:349-374` (`opus47` list includes `claude-sonnet-5-5`), `advisorPairingRejected` `:381-392`. |
| 2.1.287 | Fixed picking Fable saving pinned version id | F | n-a | Claudius picker uses the `fable` alias (`app/api/models/route.ts:76`, `app/api/sessions/[id]/model/route.ts:44`); live list comes from SDK `supportedModels()`. |
| 2.1.285 | [VSCode] Fixed Enter after a slash command running a fuzzy-matched item | F | implemented | `components/chat/SlashCommandPicker.tsx:157-191` (`isConfidentSlashMatch`, CC 2.1.236 parity). |
| 2.1.285 | [VSCode] Fixed Escape stopping the turn instead of closing the command menu | F | n-a | Picker captures Escape (`SlashCommandPicker.tsx:192-195`); Escape never interrupts in Claudius (`PromptInput.tsx:980-993` double-Esc clears only). |
| 2.1.288 | [VSCode] Fixed connector stuck on 'Needs authentication' (adds Check connection) | F | n-a | Claudius MCP row already has Reconnect which re-polls status (`app/[workspaceId]/mcp/page.tsx:252`). |
| 2.1.288 | Fixed 'What should Claude do instead?' hint on Interrupted row after ctrl+enter | F | n-a | Claudius shows only an 'Interrupted' badge (`components/chat/AssistantMessage.tsx:95`), no hint. |
| 2.1.286 | Fixed /compact,/clear,/rewind typed in a subagent transcript acting on main | F | n-a | Claudius has no per-subagent composer (subagent messages render inline in TaskBlock). |
| 2.1.287 | [VSCode] Fixed bg agent's running command shown failed after turn ended | F | n-a | Claudius gates liveness on `background_tasks_changed` (`lib/client/task-status.ts:48-55`). |
| 2.1.285 | [VSCode] Fixed message sent while Claude was working disappearing after reopen | F | n-a | Claudius queue is server-side + SQLite (`queued_messages`) and mirrored via `queue:updated` (`lib/client/use-session.ts:1572-1587`). |

## Counts

Non-Fixed bullets: 153 — A=53, B=16, C=84
B by status: implemented=5, missing=2, partial=9
All non-Fixed by status: implemented=5, missing=2, n-a=137, partial=9
F rows: 13 — implemented=2, missing=3, n-a=7, partial=1
