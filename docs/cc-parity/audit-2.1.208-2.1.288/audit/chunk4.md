# Chunk 4 audit — Claude Code 2.1.251 → 2.1.266 vs Claudius (repo `<repo>`, SDK 0.3.288)

Notes on inputs:
- 2.1.259 run note is an unfilled TODO template (bot parked after 3 failed runs); 2.1.259 bullets were classified independently here (the 2.1.260 note partially covers them; its claims were re-checked).
- 2.1.265 has no run note; classified independently.
- 2.1.257 note's Fable 5.1 "[A — version-agnostic label]" classification is a **false-rationale skip**: the static label literally says "Fable 5", and Claudius's own pricing tables don't know Fable at all (see rows below). The probe pin was later backfilled in commit 61da5d0, but pricing and copy were not.
- 2.1.258, 2.1.263, 2.1.266 contain only Fixed / generic bullets.

All paths relative to `<repo>`.

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.266 | (only bullet is a Fixed: `CLAUDE_CODE_USE_GATEWAY` regression) | — | n-a | engine auth; `rg CLAUDE_CODE_USE_GATEWAY app lib components` → none |
| 2.1.265 | `user.email`/`user.groups` in Desktop/Cowork gateway telemetry | C | n-a | gateway/Cowork telemetry |
| 2.1.265 | `--plugin-dir` pointed at a folder of plugins | C | n-a | CLI flag; Claudius never passes SDK `plugins:` option (`rg "plugins:|type: \"local\"" lib/server app/api` → none) |
| 2.1.265 | 1 GB cap on tool results saved to disk; preview says truncated | A | n-a | engine; preview text arrives in tool_result |
| 2.1.265 | `--worktree` parallel checkout | C | n-a | CLI flag; Claudius worktrees are list-only (`app/api/worktrees/route.ts` GET only) |
| 2.1.265 | `/workflows` agent detail: per-agent tool calls marked running/failed/done, subagent task list, Enter unfolds calls w/ inputs+results | B | missing | `components/chat/WorkflowBlock.tsx:18-25` renders ONE aggregate task ("SDK does not expose the per-agent breakdown"); `transcriptDir` only printed as text at `WorkflowBlock.tsx:216-225`; no `/workflows` command (`rg '"workflows"' lib/shared/slash-commands.ts` → none). Per-agent JSONL lives under the run's `transcriptDir` |
| 2.1.265 | Slash commands typed mid-prompt show a match list; plugin skill found by bare name | B | partial | Picker only opens when the WHOLE input is `/\S*`: `components/chat/PromptInput.tsx:836` (`/^\s*\/\S*$/`), filter `SlashCommandPicker.tsx:108` (`value.startsWith("/")`). Bare-name: fuzzy substring `lib/shared/slash-commands.ts:407` finds `plugin:skill`, but Enter-confidence `isConfidentSlashMatch` `slash-commands.ts:436-442` uses `startsWith` on the prefixed name |
| 2.1.265 | Remote MCP: no OAuth client registration until you authenticate | A | n-a | engine MCP client |
| 2.1.265 | Faster resume of long sessions | A | n-a | engine |
| 2.1.265 | Better error when an oversized image can't be decoded | A | n-a | engine message. (Side note: Claudius's own intake silently drops >20 MB images with no message — `PromptInput.tsx:145,1108` — see low-value list) |
| 2.1.265 | (Claudius analogue of the image-error bullet) oversize image attach gives no error at all | B | partial | Claudius's own intake silently drops >20 MB images: `components/chat/PromptInput.tsx:145,1108` (`readFileAsBase64` returns null, caller just skips, `:1137-1138`); no toast naming cause/fix. Low value |
| 2.1.265 | Artifact tool read treats others' pages as untrusted | A | n-a | engine tool |
| 2.1.265 | `.claude` folder permission option copy says what it allows | B | missing | Claudius never renders SDK `CanUseTool` `suggestions` (`sdk.d.ts:224`); `rg suggestions lib/server/session.ts` → none; buttons are fixed "Always (session/project/user)" `components/chat/PermissionPrompt.tsx:167-192`, rule built as tool-wide `[{toolName}]` `lib/server/session.ts:3544-3560` |
| 2.1.265 | `forceLoginGatewayUrl` machines are gateway sessions from startup | C | n-a | managed/gateway auth; catalog row exists `app/settings/page.tsx:1316`. (Catalog enum for `forceLoginMethod` at `page.tsx:1309-1313` lacks `"gateway"` though SDK has it `sdk.d.ts:8578` — low-value) |
| 2.1.265 | Image processing uses runtime built-in support | A | n-a | CLI internals |
| 2.1.265 | Plugin display metadata prefers marketplace entry over plugin.json (Installed tab, `plugin details`) | B | partial | Installed rows show name/version/source only, no description/display name: `app/plugins/page.tsx:609-621`, `lib/client/usePlugins.ts:8-20` |
| 2.1.265 | FIX: `/plugin` Discover showing no description/display name for marketplace plugins whose metadata lives only in `plugin.json` | F | missing | Claudius has the same bug: `lib/server/plugins.ts:139-160` (`listAvailable`) reads only `marketplace.json` entries' `description`; never falls back to the plugin's own `.claude-plugin/plugin.json`; no `displayName` field at all (`AvailablePlugin` `plugins.ts:21-31`) |
| 2.1.265 | Gateway OTel exported directly to named collector | C | n-a | gateway |
| 2.1.265 | [VSCode] auto-archive inactive sessions | C | n-a | VS Code extension (Claudius has no archive concept: `rg -i archiv components app` → none) |
| 2.1.263 | "Bug fixes and reliability improvements" | — | n-a | no feature content |
| 2.1.261 | "Organization policy" line in `/status` / `claude doctor` | C | n-a | no SDK signal for policy-load failure (`grep -i "policy" sdk.d.ts` → only setting docs) |
| 2.1.261 | `bashOutputMaxChars` / `taskOutputMaxChars` settings | B | implemented | `app/settings/page.tsx:1243,1257` (`taskOutputMaxChars` later marked deprecated per SDK 0.3.277) |
| 2.1.261 | `--append-subagent-system-prompt-file` | C | n-a | CLI flag; no SDK option (`grep -i subagentsystemprompt sdk.d.ts` → none) |
| 2.1.261 | `/skill-doctor` — unused skills + their context cost | B | partial | Cost half: `lib/shared/slash-commands.ts:120`, `components/chat/ChatSurface.tsx:1466-1468`, `components/overlays/ContextOverlay.tsx:233-240`. "Unused" half missing; run-note's "no usage signal" rationale is wrong: `usage_EXPERIMENTAL…()` returns `behaviors.{day,week}.skills[{name,pct}]` (`sdk.d.ts:~4347-4440`), but Claudius calls it with `skipBehaviors: true` (`lib/server/session.ts:8549-8551`) |
| 2.1.261 | `/model` picker / model pill show friendly name, not raw Bedrock/Vertex/gateway id | B | partial | Picker list uses SDK `displayName` (A). Current-model pills render raw ids: `components/panels/widgets/SessionCard.tsx:314,446-450` (`shortModel` only strips `claude-`), `components/chat/StatusLine.tsx:413,429` (`{model}` verbatim). `prettyModelName`/`canonicalModelId` already handle provider wrapping (`lib/shared/advisor.ts:334-338,397`) |
| 2.1.261 | Vertex startup w/ `GOOGLE_APPLICATION_CREDENTIALS` | A | n-a | engine |
| 2.1.261 | Streaming perf (layout re-checks) | C | n-a | Ink renderer |
| 2.1.261 | Dangerous-`rm` prompt catches more forms | A | n-a | engine classifier |
| 2.1.261 | No-response-headers retry waits `API_TIMEOUT_MS`, clearer messages | A | implemented | `no_response` retry surfaced: `lib/client/api-retry.ts:54,103-114` |
| 2.1.261 | Gateway 403 on managed-settings load copy | C | n-a | gateway |
| 2.1.261 | `forceLoginMethod: "gateway"` ignores leftover API key/login | C | n-a | managed auth |
| 2.1.261 | (catalog) `forceLoginMethod` value `"gateway"` that this bullet names | B | partial | Claudius's settings catalog enumerates the key but options are `["claudeai","console"]` `app/settings/page.tsx:1309-1313`; SDK type is `'claudeai'|'console'|'gateway'` `sdk.d.ts:8578`. Low value |
| 2.1.261 | Auto mode: diagram-renderer URL = upload | A | n-a | classifier |
| 2.1.261 | Prompt word-editing keys match Bash; `keybindingFlavor` no effect | B (setting) / C (keys) | implemented | catalog marks it deprecated `app/settings/page.tsx:1263-1276`; Claudius textarea uses browser editing |
| 2.1.261 | `/context` local token estimate fallback | A | n-a | `getContextUsage()` engine-side |
| 2.1.261 | [VSCode] custom-style walkthrough, MCP add/remove form, hollow ring, fold button, archive, flat model list | C | n-a | VS Code extension |
| 2.1.260 | Diff panel beside conversation, live as Claude edits; toggle `/diff` | B | partial | `/diff` native → full-screen static overlay `components/overlays/DiffOverlay.tsx:21-35`, one-shot fetch `:56-96` (no refresh on edits), covers chat. Note's "no beside-chat layout" rationale is false: the Activity rail beside chat exists (`components/panels/BackgroundTasksPanel.tsx:235`, already hosts `RecentEdits` `:857`) |
| 2.1.260 | Likely cause for prompt-cache misses in `/cost` (+ status line `prompt_cache`) | B (cost) / C (statusline) | missing | `components/overlays/CostOverlay.tsx:139-160` shows only hit/miss ratio; `lib/shared/prompt-cache.ts` doc declines. Partially derivable from data Claudius has (per-message usage in `lib/client/use-session.ts:~2620-2650`, `lastTurnCompletedAt`, `promptCacheTtl` setting, model switches, init tool-list changes) |
| 2.1.260 | `/reload-plugins` in headless sessions | A | implemented | native `case "reload-plugins"` `components/chat/ChatSurface.tsx:1295` |
| 2.1.260 | Text form of `/advisor` (`/advisor`, `<model>`, `off`) | B | implemented | `components/chat/ChatSurface.tsx:1241-1254`, `lib/shared/advisor.ts` `resolveAdvisorCommandArg` |
| 2.1.260 | `oidc.scope_on_refresh` | C | n-a | gateway |
| 2.1.260 | Gateway desktop policy keys | C | n-a | gateway |
| 2.1.260 | Reverted 2.1.259 `Read()` deny on Bash args | A | n-a | engine rules |
| 2.1.260 | Workflow `agent({schema})` upfront rejection | A | n-a | engine |
| 2.1.260 | Deleting bg session w/ unpushed worktree commits names branch | C | n-a | Claudius doesn't create/delete session worktrees (`app/api/worktrees/route.ts` GET only) |
| 2.1.260 | Gateway refresh-failure log | C | n-a | gateway |
| 2.1.260 | Idle CPU of `-p`/SDK sessions | A | n-a | engine |
| 2.1.260 | Bedrock CountTokens | A | n-a | engine |
| 2.1.260 | Settings error suggests unambiguous spelling for `Edit(C:\dir\(name)\**)` | B | missing | `lib/shared/permission-rule-lint.ts` has no `\(` Windows-path lint (`rg '\\\\\\(' lib/shared/permission-rule-lint.ts` → only trailing-garbage guard). Low value |
| 2.1.260 | Auto-compact near 1M for Opus/Fable | A | n-a | engine |
| 2.1.260 | `/ultrareview` waits 45 min | A | n-a | `handler: "sdk"` `slash-commands.ts:247` |
| 2.1.260 | `/effort` on Fable 5.1 no cache invalidation | A | n-a | engine |
| 2.1.260 | `claude-api` skill samples updated | A | n-a | bundled skill |
| 2.1.260 | `ctrl+l`/`cmd+k` clears fullscreen transcript view | C | n-a | TUI key chord; Cmd+K owned by command palette |
| 2.1.260 | Permission rules with trailing text after `)` reported invalid | B | implemented | `lib/shared/permission-rule-lint.ts:118`, `app/[workspaceId]/permissions/page.tsx:12,430` |
| 2.1.260 | Managed `claudeMd` skips security dialog | A | n-a | managed settings |
| 2.1.260 | Claude in Chrome follows org admin setting | A | n-a | `/chrome` is a toast in Claudius `ChatSurface.tsx:1543-1548` |
| 2.1.260 | Gateway `orgPluginSettings` list form | C | n-a | gateway |
| 2.1.260 | Gateway refuses misspelled nested policy field | C | n-a | gateway |
| 2.1.260 | `!` bash-mode runs outside sandbox | — | n-a | Claudius runs `!` itself, never sandboxed: `app/api/sessions/[id]/bash/route.ts:9-25` |
| 2.1.260 | self-hosted runner `--kill-session-after-min` | C | n-a | CLI |
| 2.1.260 | Removed 1-hour limit on subagent bg commands | A | n-a | engine |
| 2.1.260 | [VSCode] effort in footer pill; Open/Closed filter | C | n-a | VS Code (Claudius already shows effort pill `SessionCard.tsx:27-31`) |
| 2.1.260 | FIX: `/model` picker not showing Fable 5.1 | F | n-a | picker list from `supportedModels()` (engine-fixed); static probe list has it `app/api/models/probe/route.ts:39-46` (backfill 61da5d0) |
| 2.1.260 | FIX: `owner/repo#123` linking to github.com in GitLab repos | F | n-a | Claudius doesn't linkify issue refs (`rg -i "github.com" components/chat/Markdown.tsx` → none) |
| 2.1.260 | FIX: `/rewind` reporting success w/ missing backups | F | n-a | Claudius returns SDK `rewindFiles` result verbatim `app/api/sessions/[id]/rewind/route.ts:42-43` |
| 2.1.259 | `managedMcpServers` managed setting | A | n-a | MCP page merges SDK live status incl. servers absent from config files `app/[workspaceId]/mcp/page.tsx:93-107` |
| 2.1.259 | `--permission-prompts none` for unattended hosts | B | missing | SDK `Options.permissionPrompts?: 'host'|'none'` `sdk.d.ts:2020`; `rg permissionPrompts app lib components` → none. Unattended site: scheduler `lib/server/scheduler.ts:159-166` (no `canUseTool`, `permissionMode: "auto"`). Other headless `query()` sites: `lib/server/updater/apply.ts:614-620` (bypass, no canUseTool), `session-recap.ts:252-255` (deny-all canUseTool), `commit-message.ts:23-30` & `customization-description.ts:105-112` (`tools: []`) |
| 2.1.259 | `glab mr …` recognized → `MR !N` in tool summary + footer MR badge | B | missing | Claudius has no PR badge for GitHub either: `rg -i "prUrl|pr_url|glab|PrBadge" lib components app` → only unused `prUrlTemplate` catalog row `app/settings/page.tsx:1131`. Low value |
| 2.1.259 | `claude plugin validate --json` | C | n-a | CLI subcommand |
| 2.1.259 | Terminal resize/first-render perf | C | n-a | TUI |
| 2.1.259 | `/workflows` agent detail: JSON pretty-print w/ syntax colors, long outcomes fold | B | implemented | `components/chat/JsonBlock.tsx:4,8,58`, `lib/shared/json-syntax.ts`, used in `WorkflowBlock.tsx:158,172` |
| 2.1.259 | Headless/SDK first turn starts ≤50 ms sooner | A | n-a | engine |
| 2.1.259 | `/install-github-app` explains GitHub-only + GitLab CI docs in GitLab repos | B | missing | native handler opens GitHub App URL unconditionally `components/chat/ChatSurface.tsx:1535-1538`; no remote-host check |
| 2.1.259 | Nested bg subagent results saved to parent transcript | A | n-a | engine |
| 2.1.259 | `allowedMcpServers` governs only user-added servers | A | n-a | not in Claudius catalog (`rg allowedMcpServers app/settings` → none) |
| 2.1.259 | [VSCode] Active quick filter / status filter in session list | C | n-a | VS Code (browser analogue noted in low-value list) |
| 2.1.258 | (Fixed only: macOS 12 launch; remote/scheduled empty-content) | — | n-a | engine |
| 2.1.257 | Claude Fable 5.1 (`claude-fable-5-1`), default Fable, 1M ctx, $10/$50, $0.25 cache read | B | partial | Implemented: probe pin `app/api/models/probe/route.ts:39-46`; live picker via `supportedModels()`. MISSING pricing: `lib/shared/cost-pricing.ts:49-54` `priceFor` → Sonnet $3/$15 for fable (used by mid-turn estimate `lib/client/use-session.ts:2633` and resume baseline `lib/server/session.ts:7720`); `lib/server/litellm-pricing.ts:286` family fallback only opus/sonnet/haiku and `lib/server/litellm-prices.json` has no `claude-fable-*` key → Cost page prices Fable at $0 under the bundled snapshot or any LiteLLM table lacking `claude-fable-*` (`costFromUsage` returns 0 when unpriced, `litellm-pricing.ts:307`). STALE copy: static fallback `app/api/models/route.ts:75-77` "Fable 5" for the `fable` alias (now 5.1); `lib/client/use-session.ts:294-295` `MODEL_UNAVAILABLE_MESSAGE` hardcodes "Claude Fable 5" for any fable id; advisor Fable row pins `claude-fable-5` `lib/shared/advisor.ts:46,86-89` |
| 2.1.257 | "Time format" (`timeFormat`) + `timeZone` for turn-end clock & transcript timestamps | B | partial | Catalog passthrough only, explicitly "Does not affect Claudius's own message timestamps" `app/settings/page.tsx:1283-1295`. Claudius's own clocks ignore it: turn-end clock `components/chat/StatusLine.tsx:255-258`, message timestamps `lib/client/format-message-time.ts:24-55` (`Intl.DateTimeFormat(undefined, …)`) |
| 2.1.257 | Containment Escape auto-mode rule | A | n-a | classifier |
| 2.1.257 | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | A | n-a | Claudius enumerates no subagent-model env (`rg SUBAGENT_MODEL app lib components` → none) |
| 2.1.257 | `s` in `/effort` = current session only | B | missing | Every effort pick persists: `lib/server/session.ts:5275-5287` (`applyFlagSettings` + `updateSettings("userSettings", {effortLevel})` whenever value ≠ null); ModelPicker chips `components/panels/widgets/ModelPicker.tsx:551-620` have no session-only choice; `/effort` is `handler: "sdk"` `slash-commands.ts:127` |
| 2.1.257 | `/doctor` warns on stale sandbox mask files | C | n-a | Claudius's `/doctor` is independent and doesn't manage SDK sandbox artifacts |
| 2.1.257 | One-time auto-mode prompt before first read outside working dirs; `permissions.blockReadsOutsideWorkingDirectories` | B | partial | Toggle implemented `app/[workspaceId]/permissions/page.tsx:171-181`, `lib/server/settings.ts:27`, `lib/client/usePermissions.ts:10-58`. The interactive "block such reads" choice can't appear because Claudius ignores CanUseTool `suggestions` (see 2.1.265 `.claude` row) |
| 2.1.257 | Gateway-supplied `description` on `/model` entries | A | implemented | `components/panels/widgets/ModelPicker.tsx:430-432` renders SDK description |
| 2.1.257 | Rendering perf / prompt-input responsiveness | C | n-a | TUI |
| 2.1.257 | Policy helper diagnostics | C | n-a | managed |
| 2.1.257 | `/code-review --comment` on GitLab MRs | A | n-a | bundled skill |
| 2.1.257 | Queued MCP elicitation/permission desktop notification timing | A | n-a | Claudius renders all pending asks concurrently |
| 2.1.257 | Async hook completion notices coalesced onto one line | B | missing | one pill per `hook_response`: `lib/client/use-session.ts:4014-4040` (plain append, not `appendCoalescedSystemEntry`). Low value |
| 2.1.257 | `self-hosted-runner --configure-git` | C | n-a | CLI |
| 2.1.257 | Liveness reporting to SDK hosts under gateway keep-alives | A | n-a | Claudius has no stall watchdog to fool (`rg -i "stall|watchdog|idle.*timeout" lib/server/session.ts` → none relevant); `keep_alive` is not in `SDKMessage` |
| 2.1.257 | MCP log credential redaction | A | n-a | engine |
| 2.1.257 | `/fork` keeps prompt cache | A | n-a | engine |
| 2.1.257 | Emoji autocomplete accepts remaining GitHub/Slack aliases | B | implemented | `lib/shared/emoji-shortcodes.ts:223-231` |
| 2.1.257 | `--effort` lifts default-effort hold for session only | A | n-a | engine |
| 2.1.257 | `policyHelper` shadowed by cached server settings | C | n-a | managed |
| 2.1.257 | `managedSourcesBehavior: "merge"` sandbox keys | A | n-a | managed |
| 2.1.257 | Gateway model discovery despite nonessential-traffic off | A | n-a | gateway |
| 2.1.257 | `--resume <id> --bg` continues under own ID | C | n-a | CLI |
| 2.1.257 | `/btw` history: Shift+←/→ or `[`/`]` | C | n-a | `/btw` is `handler: "sdk"` (`slash-commands.ts:123`), no Claudius panel |
| 2.1.257 | `defaultMode: "bypassPermissions"` in project settings ignored | A | n-a | Claudius's initial mode comes from DB workspace defaults (`components/workspaces/WorkspaceForm.tsx:48,208`), no settings.json `defaultMode` editor |
| 2.1.257 | `fable`/`best` stay Fable 5 on gateways | C | n-a | gateway |
| 2.1.257 | `--add-dir`/`/add-dir`/`additionalDirectories` refuse network paths | B | implemented | `app/api/settings/additional-dirs/route.ts:26-44`; toast `ChatSurface.tsx:1448-1452` |
| 2.1.257 | Gateway TLS pinning on sign-in/refresh | A | n-a | gateway |
| 2.1.257 | Cowork: reading another's artifact always asks | C | n-a | Cowork |
| 2.1.257 | Removed Ctrl+E explanation on permission prompts | C | n-a | TUI |
| 2.1.257 | [VSCode] account/usage headers, model pill, collapse toggle, output-style menu, archive | C | n-a | VS Code |
| 2.1.252 | (Fixed only) "always allow" not saving w/o settings.local.json | F | n-a | Claudius saves via SDK `updatedPermissions` destination `lib/server/session.ts:3552-3560` (engine writer) |
| 2.1.251 | `PreModelSwitch`/`PostModelSwitch` hook events | B | implemented | `lib/shared/hook-events.ts:20-21,88-89`; `PostModelSwitch` registered `lib/server/session.ts:3102` |
| 2.1.251 | `SessionStart` resume hooks get staleness + re-cache cost | A | n-a | hook payload (`sdk.d.ts:6480-6500`). Optional resume-cost banner in low-value list |
| 2.1.251 | Live streaming of foreground subagent tool calls to Remote Control | C | n-a | Claudius renders subagent tool calls natively |
| 2.1.251 | Spend-limit bar in `/usage` (+ `rate_limits.spend_limit` statusline field) | B (bar) / C (statusline) | partial | Bar `components/overlays/CostOverlay.tsx:264-273`; parser guesses shape `lib/server/session.ts:8564-8583`; `spend_limit` still absent from SDK 0.3.288 `sdk.d.ts` (`grep -c spend_limit` → 0), so it never fires |
| 2.1.251 | Per-session prompt-cache line in `/cost` (hit ratio, misses, tokens re-cached, warm/cold) (+ statusline `prompt_cache`) | B (cost) / C (statusline) | partial | `CostOverlay.tsx:139-160` renders hit/miss ratios only; warm/cold + re-cached computed but not shown `lib/shared/prompt-cache.ts:30-75` |
| 2.1.251 | `attach/logs/stop/respawn/rm` in `--help` | C | n-a | CLI |
| 2.1.251 | CPU per turn / install size | C | n-a | TUI / binary |
| 2.1.251 | Cloud proxy drop named in Bash result | A | n-a | engine |
| 2.1.251 | `/schedule` explains MCP can't attach to cloud routines | — | n-a | Claudius's `/schedule` is a local scheduler with full MCP |
| 2.1.251 | Subagent-message framing | A | n-a | prompt engineering |
| 2.1.251 | Placeholder "Message @name…" while viewing bg subagent/fork transcript | B | missing | no per-subagent composer; static placeholder `components/chat/PromptInput.tsx:1648-1654`. Low value (needs the underlying "reply to subagent" feature) |
| 2.1.251 | MCP server-name sanitization | A | n-a | engine |
| 2.1.251 | Bedrock under `PROVIDER_MANAGED_BY_HOST` | A | n-a | engine |
| 2.1.251 | Managed-settings approval dialog lists only changes | C | n-a | CLI dialog |
| 2.1.251 | Malformed tool-call retry | A | n-a | engine |
| 2.1.251 | `/radio` on more providers | C | n-a | not in Claudius |
| 2.1.251 | Chrome actions always via permission checks | A | n-a | engine |
| 2.1.251 | `CLAUDE_CODE_SUBAGENT_MODEL` = default, not override | A | n-a | env precedence engine-side |
| 2.1.251 | Commit trailer for non-Claude models | A | n-a | engine |
| 2.1.251 | Seat-based Enterprise default → Opus 5 | A | n-a | default resolved by SDK; Claudius static `default` row is alias-only `app/api/models/route.ts:55-58` |
| 2.1.251 | `/effort` saves default per model | B | implemented | `lib/server/session.ts:5285` `updateSettings("userSettings", {effortLevel})` → SDK writes `modelSettings.<model>` (`sdk.d.ts:5106`). Settings catalog still only edits top-level `effortLevel` `app/settings/page.tsx:1033-1038` (low-value) |
| 2.1.251 | Analytics gating before sign-in | A | n-a | engine |
| 2.1.251 | Footer PR badge via GitHub API on 3P/telemetry-off | C | n-a | Claudius has no PR badge |
| 2.1.251 | Sandboxed Bash output-file handling | A | n-a | engine |
| 2.1.251 | Plugin/LSP install suggestions wait for Enter | C | n-a | TUI input race |
| 2.1.251 | Sandbox-weakening managed settings need approval | A | n-a | managed |
| 2.1.251 | `ANTHROPIC_CUSTOM_HEADERS` approval | A | n-a | managed |
| 2.1.251 | Project `env` can't set `CLAUDE_CONFIG_DIR`/`TMPDIR` | A | n-a | engine settings loader |
| 2.1.251 | Removed 6 syntax-highlight languages | C | n-a | TUI highlighter |
| 2.1.251 | [VSCode] Remote Control footer pill | C | n-a | VS Code |

## Counts (140 rows; dual-tagged B/C rows counted as B)
- Bucket: A 55 · B 31 · C 44 · F 5 · no-feature/n-a (—) 5
- B rows: implemented 9 · partial 12 · missing 10
- F rows: missing 1 (plugin Discover plugin.json fallback) · n-a 4
- A rows marked implemented (Claudius surface already present): 3
