# CC parity audit — chunk7 (2.1.209–2.1.217)

Repo audited: `<repo>` at `cf6b644` (SDK 0.3.288). All paths are relative to that repo.

Notes on method / gotchas:
- `grep` in this shell is a wrapper that silently skips files detected as binary. `app/[workspaceId]/memory/page.tsx` is git-binary (contains a non-text byte; `file` reports `data`). Use `grep -a` on it. It is the only such file under app/lib/components.
- Bot run-note errors found in this slice:
  - **2.1.215 note, phantom claims:** (a) a Settings "Session limits" section that writes `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` / `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` / `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`. `grep -rni "session limits\|mcpAutoBackground\|CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"` over app/ lib/ components/ finds nothing. (b) a "Needs input" session/tab status. `grep -rni "needs.input\|needs_input\|needsInput"` finds nothing, and `Session.getStatus()` (lib/server/session.ts:7301-7309) still maps every pending prompt to `"running"`.
  - **2.1.212 note:** contains only unfilled `_(TODO …)_` placeholders.
  - **2.1.214 note, "Last modified" label:** this one is real (memory/page.tsx:313-314, 638-642). It only looks phantom because the file is git-binary (see above).
  - **2.1.217 note:** classifies transcript-write warnings as A. They are actually B partial, because the `level` field is dropped (see table).

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.217 | Emoji shortcode autocomplete (`:heart:`, `:hea` suggestions), `emojiCompletionEnabled` setting | B | implemented | lib/shared/emoji-shortcodes.ts; components/chat/EmojiShortcodePicker.tsx; components/chat/PromptInput.tsx:841-842 (trigger gated by setting), :1764 (picker mount); lib/client/useEmojiCompletionEnabled.ts:33; lib/server/settings.ts:92; app/settings/page.tsx:718-720, :940 |
| 2.1.217 | Warnings when transcript writes fail or session saving is off (env) | B | partial | These arrive as `SDKInformationalMessage` with `level: 'info'\|'notice'\|'suggestion'\|'warning'` (sdk.d.ts:5238-5245). lib/client/use-session.ts:4409-4422 renders every level as the same `kind:"info"` pill and ignores `level`. A data-loss warning therefore looks like routine info, and `level:'info'` lines (which the SDK documents as transcript-mode-only) show inline. No dedicated SDK message: `grep -i "transcript.*fail\|disk full"` in sdk.d.ts finds nothing. |
| 2.1.217 | Footer PR badge hyperlinks, `FORCE_HYPERLINK=0` | C | n-a | Terminal OSC-8 hyperlink detection. Browser links are already `<a>`. |
| 2.1.217 | Login-expiry warning 3 days before expiry (was 5) | B | implemented | lib/server/token-expiry.ts:36 `TOKEN_EXPIRY_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000`; components/chat/TokenExpiringPanel.tsx |
| 2.1.217 | frontend-design plugin tip capped at 3 impressions | C | n-a | Claudius has no plugin-suggestion tip. `grep -rni "frontend-design" app lib components` only hits placeholder copy in app/plugins/page.tsx:214,276,341. lib/shared/tips.ts:110 is a generic "plugins" tip. |
| 2.1.217 | Cap of 20 concurrent subagents (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) | A | n-a | Engine. Settable through the generic Settings → Environment editor (app/settings/page.tsx:758-765). Claudius has no env-var catalog: `grep -rn "CLAUDE_CODE_MAX_" app lib components` only hits tool-budget comments. |
| 2.1.217 | No nested subagents by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) | A | n-a | Engine. Same generic env editor as above. |
| 2.1.216 | `sandbox.filesystem.disabled` setting | B | implemented | components/workspaces/WorkspaceForm.tsx:85,124,227-228; lib/server/session.ts:2771-2781 (nested `sandbox.filesystem.disabled`); lib/server/workspaces-store.ts:45; lib/shared/session-defaults.ts:58-59; app/api/sessions/route.ts:128,155 |
| 2.1.216 | `/fork` confirmation: one line with the new session name, attach id, and a "shares your checkout" note | B | missing (low) | components/chat/ChatSurface.tsx:1165-1179 POSTs to /api/sessions/fork, then `router.push` to the fork. There is no confirmation naming the fork and no shared-working-tree note; the only toast is "Fork failed". `grep -rni "shares your\|same checkout\|shared checkout\|Forked as"` over components app lib finds nothing. |
| 2.1.216 | PowerShell `git`/`gh` argument validation | A | n-a | Engine tool permissioning. |
| 2.1.216 | `/ultrareview` diff-too-large error detail | A | n-a | Forwarded to the SDK (lib/shared/slash-commands.ts:247 `handler: "sdk"`). |
| 2.1.216 | `/code-review ultra` empty-diff message | A | n-a | Bundled skill. Output is engine text. |
| 2.1.216 | Spend limit adjustment prompt shows the server's rejection reason | A | n-a | Interactive CLI flow (`/extra-usage` is forwarded to the SDK, slash-commands.ts:166). Claudius has no spend-limit adjustment UI; `grep -rni "spend.limit\|spendLimit"` only hits the read-only `rate_limits.spend_limit` display at session.ts:8564-8623. |
| 2.1.216 | `/context` warns when over the context window; a failed `/compact` shows as an error | B | partial | Banner done: components/chat/ContextWarningBanner.tsx:56,102-107 ("Context window exceeded — N% full"), lib/client/useContextWarning.ts:44. Compact error done: lib/client/use-session.ts:1548, 3891-3896 ("Compaction failed: …"). Missing: the `/context` overlay itself (components/overlays/ContextOverlay.tsx:155-160, 339) shows a bare "N%" with no exceeded warning. `grep -ni "exceed" components/overlays/ContextOverlay.tsx` only hits an unrelated comment at line 33. |
| 2.1.216 | `/rewind` skips symlink/hard-link paths and reports how many | B | implemented | components/chat/RewindFilesButton.tsx:36, 206 (`skippedLinks`) |
| 2.1.216 | Background sessions park a "needs input" request in the agent view for `/mcp` and `/install-github-app` | C | n-a | CLI daemon / agent view with no attached client. |
| 2.1.216 | Bundled dataviz skill palette update | A | n-a | Bundled skill. |
| 2.1.216 | [VSCode] Fixed RTL text (Arabic/Hebrew/Persian) ordering when mixed with English or code | F | missing | Same webview-class bug is plausible in Claudius. `grep -rn 'dir="auto"\|dir={\|unicode-bidi\|direction:'` over components app only finds `flexDirection` in app/global-error.tsx:24. components/chat/Markdown.tsx, UserMessage.tsx and the PromptInput textarea all inherit an LTR base direction. |
| 2.1.216 | Fixed skills/commands changed mid-session not appearing in the slash menu until restart | F | partial | The live path works: use-session.ts:4452-4456 applies `commands_changed`. However, the server caches `latestInitSnapshot.slashCommands` only from `system:init` (session.ts:1545-1550, 7497-7503) and re-emits it in `session_snapshot` after replay. The client then overwrites the list (use-session.ts:2373), so a reload or tab switch reverts the palette to the stale init list. This is acknowledged in the comment at use-session.ts:4449-4451. |
| 2.1.215 | Claude no longer runs `/verify` and `/code-review` on its own | A | n-a | Engine / system-prompt behaviour. |
| 2.1.214 | EndConversation tool | A | n-a | No SDK surface: `grep -i "EndConversation\|end_conversation"` across sdk*.d.ts finds nothing, and `TerminalReason` (sdk.d.ts:9685) has no conversation-ended value. Renders through the generic ToolCall. |
| 2.1.214 | Periodic progress heartbeat for long-running tool calls | B | implemented | `SDKToolProgressMessage.heartbeat` (sdk.d.ts:6119-6128) is consumed at lib/client/use-session.ts:3916-3934. Live counter at components/chat/ToolCall.tsx:179, 286-292. |
| 2.1.214 | ISO `modified` timestamp in memory-file frontmatter | B | implemented | lib/server/auto-memory.ts:109-118 (write), 221 (patch), 154-178 (parse); app/[workspaceId]/memory/page.tsx:313-314, 537, 638-642 (needs `grep -a`, file is git-binary). |
| 2.1.214 | OTel `message.uuid`, `client_request_id`, `tool_source` attributes | A | n-a | Engine telemetry, configured via env. Claudius has no OTel pipeline. |
| 2.1.214 | `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` | A | n-a | Engine env var. |
| 2.1.214 | Reasoning effort added to the `subagentStatusLine` payload | C | n-a | Claudius only edits the statusLine setting (lib/shared/status-line.ts) and never executes it. `grep -rni subagentStatusLine app lib components` finds nothing. |
| 2.1.214 | `docker` daemon-redirect flags now prompt | A | n-a | Engine permission analyzer. |
| 2.1.214 | `claude rc` home-directory trust error | C | n-a | CLI subcommand. |
| 2.1.214 | Single-segment `dir/**` hook `if:` now matches only `<cwd>/dir` | A | n-a | Engine matcher. The Claudius hooks form passes `if` through verbatim (app/[workspaceId]/hooks/page.tsx:595-600, example `Bash(git *)`). Optional copy tweak only. |
| 2.1.214 | `file -m/-f` now require permission | A | n-a | Engine. |
| 2.1.214 | Keep-alive pooling disabled after a stale-connection error | A | n-a | Engine networking. |
| 2.1.214 | SessionStart hooks report source `"fork"` | B | implemented | lib/shared/hook-events.ts:66 matcherHint `startup \| resume \| clear \| compact \| fork`. No Claudius SessionStart callbacks branch on source (`grep -rn SessionStart lib/server` finds nothing). |
| 2.1.212 | `/fork` copies into a background session while you keep working; the old in-session subagent is now `/subtask` | B | partial | Native `/fork` (slash-commands.ts:79) → ChatSurface.tsx:1165-1179 → app/api/sessions/fork/route.ts → SDK `forkSession` creates a copy but navigates you into it instead of keeping you in the original. `/subtask`: `grep -rni "subtask" app lib components` finds nothing. It would only appear if the engine advertises it in `system:init` slash_commands (merged by `mergeSuggestions`, slash-commands.ts:312). Can't verify; the CLI ships as a bunfs binary. |
| 2.1.212 | `claude auto-mode reset`: restore the default auto-mode config, with confirmation | B | missing | Claudius already has an Auto mode editor (app/[workspaceId]/permissions/page.tsx:281 `AutoModeTab`; app/api/settings/auto-mode/route.ts) but no reset. `grep -ni "reset\|restore"` in permissions/page.tsx finds no reset action, only the per-list `$defaults` toggles at :347-382. `updateAutoMode` (lib/server/settings.ts:586-600) only merges and cannot delete the `autoMode` key. |
| 2.1.212 | Session cap on WebSearch calls (200, `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`) and on subagent spawns (200, `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`); `/clear` resets | B | partial | UI: components/cost/LimitsPanel.tsx:17-45, 127, 143. API: app/api/limits/route.ts:40-44. Store: lib/server/limits-store.ts:27-29. Gate: lib/server/session.ts:3294-3313 inside `canUseTool`. Problems: (a) `toolBudgetKindFor` (lib/shared/tool-budget.ts:17-21) only matches `"Task"`, but the SDK emits `"Agent"` (lib/shared/subagent-tool.ts:1-18), so the subagent cap probably never counts. (b) The gate runs only when the engine calls `canUseTool`, which it skips for auto-allowed tools (Agent), after any "always allow" rule, and in bypass mode. (c) Claudius never forwards the env vars (`grep CLAUDE_CODE_MAX_WEB_SEARCHES` finds only comments), so the setting can lower the engine's native 200 but never raise it. `/clear` reset is fine: ChatSurface.tsx:1122-1124 creates a new Session. |
| 2.1.212 | MCP calls over 2 min auto-background (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`) | B | implemented | Rendering of auto-backgrounded MCP calls: components/chat/ToolCall.tsx:71-79, AssistantMessage.tsx:209, lib/server/session.ts:8193, 8305. The env var itself works through the generic env editor (A). The 2.1.215 note's "Session limits" section for it is phantom. |
| 2.1.212 | `/resume` in agent view opens a picker that includes deleted sessions | C | n-a | Agent-view specific. Claudius delete is a hard SDK `deleteSession` (lib/server/sessions-store.ts:46-47), so nothing could be restored. |
| 2.1.212 | WebSearch/WebFetch retry 529 and rate limits | A | n-a | Engine. |
| 2.1.212 | Mid-conversation system block cached behind gateways | A | n-a | Engine. |
| 2.1.212 | Cold-attach shows the formatted transcript instantly | C | n-a | `claude attach`. |
| 2.1.212 | `SendMessage` bodies no longer duplicated | A | n-a | Engine. |
| 2.1.212 | `/fork` names an untitled copy after your prompt | A | n-a | SDK `forkSession` derives the title (sdk.d.ts:851). Claudius passes `title` only when the user gives an arg (ChatSurface.tsx:1171). |
| 2.1.212 | Bare `/btw` reopens the side-question panel on the latest exchange | B | missing (low) | `/btw` is forwarded to the SDK (slash-commands.ts:123 `handler:"sdk"`). Claudius has no side-question panel: `grep -rni "btw\|side.question\|sideQuestion" app lib components` only hits the registry and changelog. A prerequisite panel is also missing. |
| 2.1.212 | `←` footer hint pulses "N done" | C | n-a | Terminal footer. |
| 2.1.212 | Task tool `mode` param deprecated | A | n-a | Engine. The agent-file `permissionMode` frontmatter (agents/page.tsx:44, 394) is a different field. |
| 2.1.212 | `forceLoginMethod` enforced for SDK and other logins | A | n-a | Engine auth. |
| 2.1.212 | Transcripts record effort on each assistant message | A | n-a | No field on `SDKAssistantMessage`: grep for effort near sdk.d.ts:3610-3645 finds nothing. |
| 2.1.212 | `set_model` applied mid-turn | A | n-a | Claudius forwards immediately (lib/server/session.ts:5107-5123). The picker is not gated on `pending`. |
| 2.1.212 | Agent view: sessions blocked on a prompt show "Needs input" instead of "Working" | B | partial | `Session.getStatus()` (lib/server/session.ts:7301-7309) maps pending permission/ask/plan/elicitation to `"running"`. `TabStatus` (components/chat/SessionTabs.tsx:17) has no needs-input value; StatusDot is at :1102-1116; the sessions API returns `s.getStatus()` (app/api/sessions/route.ts:237). Partial signal only: per-tab unread notification badge (SessionTabs.tsx:24-30; ChatSurface.tsx:2002). `grep -rni "needs.input\|needs_input\|needsInput"` finds nothing. The 2.1.215 note's claim that this shipped is phantom. |
| 2.1.212 | Auth status panel title renamed to "Authentication" | C | n-a | `grep -rni "cloud authentication"` finds nothing. |
| 2.1.212 | tmux synchronized-output release-note correction | C | n-a | Terminal. |
| 2.1.211 | `--forward-subagent-text` / `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` | B | implemented | lib/server/session.ts:2855 `forwardSubagentText: true` (SDK option, sdk.d.ts:1863-1869). |
| 2.1.211 | Windows skill/plugin dir naming hardening; CCR proxies after `/clear` | A | n-a | Engine / cloud. |
| 2.1.211 | Terminal layout and rendering performance | C | n-a | Terminal. |
| 2.1.211 | Background agent result reporting (no fabricated results) | A | n-a | Engine / model loop. |
| 2.1.211 | Memory index over-limit warning measures only loaded content | B | implemented | lib/server/auto-memory.ts:331, 343 (`measureMemoryIndexLoadedBytes`), 427-431 |
| 2.1.211 | Integer env vars accept `1e6` / `64_000` | A | n-a | Engine parses env. Claudius's env editor stores strings. |
| 2.1.211 | Documentation links updated to the current docs sites | B | implemented / n-a | User-facing links are already current (ChatSurface.tsx:179 code.claude.com). Only a code comment uses docs.anthropic.com (lib/shared/model-deprecations.ts:9). |
| 2.1.211 | "Always allow" rules saved at the repo root (worktrees) | A | n-a | Claudius passes `addRules` with `destination` to the SDK (lib/server/session.ts:3544-3561). The engine writes the file. |
| 2.1.211 | `/usage-credits` confirms before requesting from org admins | C | n-a | Interactive CLI flow. Claudius only mentions it in banner copy (lib/server/long-context-credits-detector.ts:6). |
| 2.1.211 | Vim mode `s`/`S` in NORMAL mode | C | n-a | Claudius has no vim mode: `grep -rni vim` only hits the statusLine `hideVimModeIndicator` and shiki. |
| 2.1.211 | [VSCode] Remote Control banner copy | C | n-a | VS Code extension. |
| 2.1.211 | Claude in Chrome upload-path hardening | C | n-a | Chrome extension. |
| 2.1.211 | Claude in Chrome `save_to_disk` now writes the screenshot | C | n-a | Chrome extension. |
| 2.1.211 | Fixed permission previews (relayed to chat channels) not neutralizing bidi/zero-width/look-alike chars | F | missing | components/chat/PermissionPrompt.tsx:137-140 renders `JSON.stringify(request.input)` raw, and JSON.stringify does not escape U+202E or U+200B. lib/shared/invisible-unicode.ts exists but only PromptInput uses it (`grep -rl invisible-unicode` → components/chat/PromptInput.tsx). The input is collapsed by default (:42), so priority is lower. |
| 2.1.210 | Live elapsed-time counter on the collapsed tool summary line | B | implemented | components/chat/ToolCall.tsx:11, 179, 286-292; lib/client/use-elapsed.ts |
| 2.1.210 | Startup warning for `Write(path)` / `NotebookEdit(path)` / `Glob(path)` rules | B | implemented | lib/shared/permission-rule-lint.ts:33; app/[workspaceId]/permissions/page.tsx:417 (draft rule), :441 (existing rules) |
| 2.1.210 | Agent tool hardened against indirect prompt injection | A | n-a | Engine. |
| 2.1.210 | Timeout auto-background message for Bash/PowerShell | B | implemented | `timedOutAfterMs`: lib/client/use-session.ts:764-771, 3401-3413; components/panels/widgets/BackgroundBashes.tsx:53 |
| 2.1.210 | Auto mode classifier defaults to Sonnet 5 | A | n-a | Engine. |
| 2.1.210 | dataviz OKLab validation | A | n-a | Bundled skill. |
| 2.1.210 | MEMORY.md over read limit gives an explicit error instead of truncating | B | implemented | lib/server/auto-memory.ts:427-431 (413 error, rollback at 131-142) |
| 2.1.210 | Screen reader announces permission-mode changes | B | implemented | components/chat/ModeSelector.tsx:77, 118-123 (`aria-live="polite"`) |
| 2.1.210 | Agents footer shows how many background agents are waiting on input | B | implemented (via notifications) | Per-tab unread badges (SessionTabs.tsx:24-30, ChatSurface.tsx:2002) plus the notifications bell. Status-dot conflation is tracked under the 2.1.212 "Needs input" row. |
| 2.1.210 | Agent view keeps the `←` origin session marked | C | n-a | Agent view TUI. |
| 2.1.210 | Fable temporarily unavailable in the advisor picker | n-a | n-a | Transient and superseded. Fable is re-offered per 2.1.232 (lib/shared/advisor.ts:39-46). |
| 2.1.209 | (no non-Fixed bullets) | — | — | The only bullet is "Fixed /model and other dialogs blocked in `claude agents` background sessions", which is CLI-only. Skipped. |
| 2.1.214 | Fixed memory frontmatter values silently truncated at an inline `#` | F | missing | lib/server/auto-memory.ts:113-118 (write) and ~231-236 (patch) emit `description: ${…}` / `name: ${…}` unquoted into `autoMemoryDir()` = `~/.claude/projects/<enc>/memory` (:15-16), the same directory the engine loads. A description containing " #" gets truncated by the engine's YAML parse. Newlines are not rejected either (only a `.trim()` emptiness check at :96), so a value can inject frontmatter keys. |

## Fixed bullets checked and NOT flagged (Claudius doesn't share the bug)
- 2.1.217 RC late viewers miss pending prompts: Claudius re-emits pending ask/permission/elicitation/plan on subscribe (lib/server/session.ts:6882-6909).
- 2.1.211 `/clear` didn't reset the cost counter: Claudius `/clear` creates a new session (ChatSurface.tsx:1122-1124).
- 2.1.210 plan approvals without edits labelled "(edited by user)": Claudius replaces `plan` only when it was edited (session.ts:3684-3687).
- 2.1.211 routines with no schedule showing year-1 next run: `nextFireMs` returns null (lib/shared/cron.ts:46).
- 2.1.212 plugin uninstall hitting the wrong marketplace: Claudius has no uninstall path (`grep -rni uninstall lib/server app/api` finds nothing plugin-related).
- 2.1.214 cost double-counting on multiple `message_delta`: Claudius never sums `message_delta` (grep finds nothing).
- 2.1.210 `$1`/`$2` stripped: Claudius does no argument substitution (grep for `ARGUMENTS` / `$1` finds nothing).
- 2.1.216 AskUserQuestion continue-wording: Claudius sends structured answers through `updatedInput` (session.ts:3614); the wording is the engine's.
- 2.1.216 plugin-skill prefix lost in autocomplete: the palette uses SDK-provided names (slash-commands.ts:312-352).
- 2.1.211 `/loop` hides the session from resume; titles showing refusal text: Claudius has no hide logic and titles come from the SDK.
