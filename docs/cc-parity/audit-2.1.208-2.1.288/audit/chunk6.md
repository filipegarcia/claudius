# Audit chunk6 — Claude Code 2.1.218 → 2.1.234 vs Claudius (repo @ cf6b644, SDK 0.3.288)

Repo audited read-only: `<repo>`. All paths below are relative to it.
`sdk.d.ts` = `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

Pipeline-state findings (not changelog rows):
- **Unmerged 2.1.218 cc-parity branch.** Commits `c7e56ec` (bucket-B items) and `8513ab2` (e2e specs) live only on `cc-parity/2.1.218`; `git merge-base --is-ancestor` says neither is in HEAD. So the MCP whitespace warning, agent-frontmatter `:` validation and the fast-mode-on-model-switch notice were built but never shipped (`grep findConfigWhitespaceWarnings|fastModeNowSupported|model-switch` → no hits on HEAD).
- **Phantom implementation in run-notes/2.1.220.md**: claims `sandbox.network.strictAllowlist` + `allowedDomains` shipped in `WorkspaceForm.tsx`/`session.ts`. `grep -rni "strictAllowlist|allowedDomains" app lib components` → zero hits; `git log -S strictAllowlist` only finds the SDK-bump notes saying it's reachable "only via the raw-JSON editor".
- **False-rationale skip in run-notes/2.1.220/2.1.221.md** for `/fork` worktree: classified A because "Claudius calls `forkSession()`". `forkSession` only copies the transcript (`sdk.d.ts:824-838`); the worktree is created by the CLI's `/fork`, which Claudius replaces with a native handler.
- 2.1.234 was never classified by the 2.1.237 run; backfilled by run-notes/2.1.238.md (verified against code below, not accepted on the notes' word).

Legend: bucket A = zero Claudius code; B = Claudius should reimplement; C = terminal/CLI/service-only; F = fix on a Claudius-owned surface.

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.234 | `CLAUDE_CODE_PROJECT_DIR_NAME` env var for hosts with per-session config dirs | A | n-a | Claudius gives per-*profile* (not per-session) `CLAUDE_CONFIG_DIR` (`lib/server/accounts-store.ts:584-630`); no transcript-dir naming to choose. `grep -rn PROJECT_DIR_NAME lib app` → none |
| 2.1.234 | `selection:clear` keybinding action (also agents view) | C | n-a | `/keybindings` is a free-text passthrough editor for the CLI's `~/.claude/keybindings.json` (`lib/server/keybindings.ts:5-40`, `app/[workspaceId]/keybindings/page.tsx:178-184` placeholder "command (e.g. submit, interrupt, /clear)") — no action catalog to extend, Claudius never reads that file. Browser selection is native; Claudius's own registry `lib/client/shortcuts.ts:95-358` has no transcript-selection concept (`grep -rn "selection:" app lib components` → none). Optional trivial `selection.clear` action = judgement call |
| 2.1.234 | GitLab MR badge in footer/statusline (MR !N, draft/pending/green via glab) | B | missing | No PR/MR badge for ANY host: `grep -rni "gitlab|glab|merge request|mergeRequest" app lib components` → only a comment in `BranchSwitcher.tsx:698`; `grep -rn "\"gh\"|'gh'|gh pr|prNumber|PrBadge|prStatus" app lib components` → none; `lib/server/git.ts` only execs `git`. SDK has no PR fields (`grep -i pull_request|merge_request sdk.d.ts` → none). Only `prUrlTemplate` settings row exists (`app/settings/page.tsx:1131`). Would live in `lib/server/git.ts` + `components/chat/StatusLine.tsx` / Git page header |
| 2.1.234 | Auto-continue session when claude.ai usage limit resets; `/config` toggle "Continue automatically at usage limit" | B | missing | SDK key `Settings.autoContinueAtUsageLimit` (`sdk.d.ts:9229-9231`). `grep -rni "autoContinue|continue automatically|resumeAtLimit" app lib components` → none; settings catalog keys (`app/settings/page.tsx` `key:` list) lack it. `RateLimitHitPanel.tsx:8-13` explicitly says "nothing to click, you just wait" — no resume-on-reset. run-notes/2.1.238 deferred it |
| 2.1.234 | Claude told to use account email only to identify you | A | n-a | system-prompt text inside engine |
| 2.1.234 | Security: reject Windows NT-namespace `\??\` paths in pre-approval file accesses | A | n-a | engine path validation (Windows) |
| 2.1.234 | Remote Control: account/org switch stops session within seconds | C | n-a | Remote Control |
| 2.1.234 | RC sessions from Desktop/VS Code keep phones updated on permission mode/model | C | n-a | Remote Control |
| 2.1.234 | RC: effort picks from phone apply to host; session publishes effort | C | n-a | Remote Control |
| 2.1.234 | `SendMessage`/`ListAgents` say when session list too long to check | A | n-a | tool output text |
| 2.1.234 | Expired Anthropic profile credential points at `/login` | A | n-a | engine auth message |
| 2.1.234 | Transcript: your own prompts render markdown like replies | B | implemented | `components/chat/UserMessage.tsx:222-299` (`InlineUserText` → `<Markdown breaks allowExecute={false}>` at :296); historic view `components/sessions/TranscriptViewer.tsx:96`; `components/chat/Markdown.tsx:6` imports `remark-breaks` (`package.json:69`). Image-token-interleaved prompts still plain text (documented scope cut) |
| 2.1.234 | Better "API returned empty/malformed response" error | A | n-a | engine error text, rendered generically |
| 2.1.234 | Auto-generated session titles read as short names | A | n-a | titles come from SDK `aiTitle` (`lib/server/session.ts:1426-1433`, `:1675`); no Claudius-owned title prompt (`grep -rn "query(" lib/server` → recap/commit-message/scheduler/etc., none generate titles; `session-titles.ts` is a store only) |
| 2.1.234 | `claude-api` skill context cost ~200k→~25k | A | n-a | bundled skill |
| 2.1.234 | `/permissions` can be opened while Claude is working | B | implemented | Native slash commands dispatch immediately regardless of `pending` (`components/chat/ChatSurface.tsx:1716-1718` → `runNative`, `case "permissions"` :1280); rule enforcement mid-turn is engine-side |
| 2.1.234 | `/add-dir` usable mid-turn; `/add-dir`,`/config`,`/help`,`/theme`,`/advisor` dialogs open mid-turn | B | implemented | same dispatch path; `case "add-dir"` `ChatSurface.tsx:1432-1456` (note: pre-existing — it still says "restart session to apply"; SDK has no Query method for `register_repo_root`) |
| 2.1.234 | `/goal` clears itself with notice when a turn dies on unrecoverable error | B | n-a | Claudius's `/goal` is a native, non-looping tracker (`lib/shared/slash-commands.ts:83` `handler:"native"`; in-process `report_goal_achieved` MCP tool `lib/server/session.ts:4159-4220`) — the SDK's armed Stop-hook loop never runs, so there is no "armed" state to clear. Claudius ignores SDK `active_goal` (`grep -rn active_goal lib components` → none) |
| 2.1.234 | `/goal` checks in on background tasks after 30+ min (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`) | B | n-a | same as above — no looping goal in Claudius |
| 2.1.234 | `claude setup-token` rejects extra args | C | n-a | CLI subcommand |
| 2.1.234 | Esc in fullscreen no longer clears mouse selection | C | n-a | TUI fullscreen |
| 2.1.234 | Removed "Allowed by auto mode classifier" line under Agent tool calls | C | n-a | TUI line; Claudius never rendered it (`grep -rni "auto mode classifier|allowed by auto" components lib/client` → none) |
| 2.1.234 | Removed "Default teammate model" `/config` setting | B | n-a | Claudius never exposed it (`grep -rni "teammateModel|teammate model|defaultTeammate" app lib components` → none) |
| 2.1.234 | Dimmed elapsed-time counter on running tool header | B | implemented | `components/chat/ToolCall.tsx:286-293` (`text-[10px] text-[var(--muted)]`) |
| 2.1.234 | Background task notifications between turns sent in `<system-reminder>` tags | A | n-a | engine prompt construction (on-disk these are `type:"attachment"` records, not user records, so Claudius's `<task-notification>` user filters are unaffected) |
| 2.1.234 | Mantle: skip admin-pin probe at startup | A | n-a | engine/provider |
| 2.1.234 | Windows: startup no longer stalls on read-only `~/.claude.json` | C | n-a | Windows CLI startup |
| 2.1.233 | GitLab MR URL support for `--worktree` and `claude agents` view (`!N`) | C | n-a | CLI flag/subcommand; Claudius has no PR-URL→worktree flow for any host (`grep -ni "pull|url|github" lib/server/worktrees.ts lib/client/worktree.ts` → none) |
| 2.1.233 | `forward_user_identity` apps gateway setting | C | n-a | gateway product |
| 2.1.233 | `CLAUDE_CODE_TOOL_MEMORY_LIMIT` cgroup for Bash (Linux) | A | n-a | env var read by engine; Claudius has no env-var catalog UI |
| 2.1.233 | `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS` | A | n-a | same |
| 2.1.233 | `claude self-hosted-runner` faster session start | C | n-a | CLI subcommand |
| 2.1.233 | Apps gateway error forwarding (400/413 upstream message) | A | n-a | gateway/engine |
| 2.1.233 | `claude plugin validate` checks bare `.claude/skills` | C | n-a | CLI subcommand |
| 2.1.233 | Screen reader mode `/effort` numbered list | C | n-a | TUI a11y |
| 2.1.233 | Print-mode `[claude-code:unrecognized_model]` stderr diagnostic | C | n-a | `-p` mode |
| 2.1.233 | GitHub app setup tip hidden on gitlab/bitbucket; enterprise marketplace tip covers non-GitHub | B | n-a | Claudius tip catalog has no GitHub-app or enterprise-marketplace tip (`lib/shared/tips.ts:65-162` ids) |
| 2.1.233 | Todo/Task tools off on Opus 4.8+/Sonnet 5+/Fable 5+; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` restores | B | implemented | `lib/server/session.ts:804` sets `CLAUDE_CODE_ENABLE_TODO_TOOLS: "1"` in `buildQueryEnv`, used at `:2724` |
| 2.1.233 | Windows auto-mode `cd && cmd > file` regression fix; revert of 2.1.232 Bash perm changes | A | n-a | engine permission logic |
| 2.1.232 | Subagent forking on by default; non-teammate spawns background by default | A | n-a | engine; background tasks render generically (`components/panels/BackgroundTasksPanel.tsx`) |
| 2.1.232 | Type `@` to mention another Claude session by name → SendMessage | B | missing | `@` picker only has files + agents (`components/chat/at-mention.ts:16-18` `PickerItem = file | agent`; `AtMentionPicker.tsx:23-60`). Claudius already reads the live session registry `~/.claude/sessions/<pid>.json` for peer-sender resolution (`lib/server/peer-source.ts:27,95-200`) and renders inbound peer messages (`components/chat/PeerMessageHeader.tsx`), so the plumbing exists |
| 2.1.232 | `SendMessage` delivers to bare unique name without ref confirm | A | n-a | tool behaviour |
| 2.1.232 | Unique live session names (`name-word-word` variant + notice) | A | n-a (caveat) | engine registry naming. Caveat: Claudius rename only appends a JSONL custom-title (`lib/server/session.ts:3262-3267` → SDK `renameSession`), never the live `rename_session` control request (`sdk.d.ts:4963`, no Query method), so peers can't address a Claudius session by its visible title |
| 2.1.232 | `/config` rows "Dialog expiry" + "Messages from your other sessions" | B | implemented | `app/settings/page.tsx:1210` (`crossSessionInbound`), `:1217` (`dialogExpiry`); types `lib/server/settings.ts:219-240` |
| 2.1.232 | GitLab token-family secret redaction; `glab` config protection | A | n-a | engine sandbox/redaction |
| 2.1.232 | GitLab support for plugin marketplaces (bare gitlab.com URLs) | A | n-a | resolution engine-side; Claudius lint doesn't restrict hosts (`lib/shared/plugin-ref-lint.ts:100-116`). See marketplace-schema row below for editor limits |
| 2.1.232 | Settings: `additionalMarketplaces`/`allowedMarketplaces` aliases | B | partial | Alias read/write exists (`lib/server/plugins.ts:44-63`, `:193-204`) BUT the underlying model is wrong: Claudius types `extraKnownMarketplaces: string[]`, `strictKnownMarketplaces: boolean`, `blockedMarketplaces: string[]` (`plugins.ts:16-18`), while SDK has `extraKnownMarketplaces` = object map `{name:{source:{…}}}` (`sdk.d.ts:7351`) and strict/blocked = arrays of `{source:…}` objects (`sdk.d.ts:7855`, `:8329`). `strArr` drops object entries on read (`plugins.ts:33-35`) → valid configs show empty; `setMarketplaces` writes string arrays / `true` over the object form (`plugins.ts:182-209`) → saving corrupts settings.json |
| 2.1.232 | Enterprise policy: url-typed `blockedMarketplaces` keeps blocking git-classified URL | A | n-a | engine policy matching (editor can't express url-typed entries — see row above) |
| 2.1.232 | Gateway: `desktop:` overlay accepts all Desktop settings | C | n-a | gateway |
| 2.1.232 | Gateway: empty groups / malformed `email_domain` fail boot | C | n-a | gateway |
| 2.1.232 | Fable 5 re-offered as advisor (consent via `/model fable`) | B | implemented | `lib/shared/advisor.ts:46,87` (`ADVISOR_FABLE_VALUE`, `advisorOptions(includeFable)`); `app/api/sessions/[id]/advisor/route.ts` |
| 2.1.232 | Remote Control: resuming a conversation whose claude.ai session was deleted starts a replacement | C | n-a | Remote Control |
| 2.1.232 | Improved fullscreen streaming responsiveness | C | n-a | TUI renderer |
| 2.1.232 | Managed settings approval dialog improvements | C | n-a | Claudius has no managed-settings approval flow |
| 2.1.232 | `/feedback` & `/bug` open immediately while Claude responds | B | implemented | native dispatch irrespective of `pending` (`ChatSurface.tsx:1716-1718`, `case "feedback"` :1619) |
| 2.1.232 | `/plugin install p@m` refreshes marketplace first | A | n-a | Claudius forwards `/plugin install` to SDK (`app/plugins/page.tsx:227-285`) |
| 2.1.232 | `/code-review` high/xhigh/max runs in background agent | A | n-a | bundled skill |
| 2.1.232 | Pasted/clipboard images read without blocking event loop | A | n-a | engine |
| 2.1.232 | Remote Control keeps reconnecting ~30 min | C | n-a | Remote Control |
| 2.1.232 | RC: resuming no longer steals RC from another local Claude Code | C | n-a | Remote Control |
| 2.1.232 | Agent panel: completed subagents hide immediately, `/tasks` hint, overflow indicator moved | B | implemented | Claudius panel already drops non-running tasks from the live section (`components/panels/BackgroundTasksPanel.tsx:310,348`) into "Recent" (:864) |
| 2.1.232 | RC: terminal says why session was taken over/ended/deleted | C | n-a | Remote Control |
| 2.1.232 | Bash `< file` permission-checked like argument spellings | A | n-a | engine (later reverted in 2.1.233) |
| 2.1.232 | Shortened message when resuming a completed background agent | A | n-a | engine text |
| 2.1.232 | Cowork: no inlining external @-imports from user memory | C | n-a | Cowork |
| 2.1.232 | Hardened cross-session socket dir on shared /tmp | A | n-a | engine |
| 2.1.232 | Hardened Linux filesystem sandbox | A | n-a | engine |
| 2.1.232 | `sandbox.ripgrep` honored only from user/managed/--settings | A | n-a | engine settings precedence; Claudius doesn't write it |
| 2.1.232 | Removed startup tip suggesting custom subagents (+ /powerup nudge) | B | implemented | `lib/shared/tips.ts:59-62` comment; no `id: "agents"` tip remains (ids at :65-162) |
| 2.1.231 | (only a Fixed bullet) | — | n-a | skipped |
| 2.1.229 | Documented `claude remote-control --continue` | C | n-a | CLI |
| 2.1.229 | Server-supplied hooks for self-hosted runner sessions | C | n-a | self-hosted runner |
| 2.1.229 | SSE keepalive pings in gateway streaming | A | n-a | gateway transport |
| 2.1.229 | Plugin marketplace `command` sources (`mode: "link"`) | A | n-a (editor gap) | engine resolution; cannot be expressed in Claudius's string-only marketplace editor — see 2.1.232 aliases row |
| 2.1.229 | `ListAgents` marks offline RC sessions / cloud sessions | A | n-a | tool output |
| 2.1.229 | Workflow fan-out stagger (`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`) | A | n-a | engine |
| 2.1.229 | "prompt is too long" explains why autocompact couldn't recover | A | n-a | engine error text |
| 2.1.229 | Sandbox IPv6 literals bracketed; ambiguous spellings fail-closed + flagged by `/doctor` | A | n-a (judgement) | engine; Claudius `/doctor` (`app/api/doctor/route.ts:244-337`) has no sandbox checks and Claudius has no allowedDomains UI, so nothing to lint |
| 2.1.229 | `/login` repeats `CLAUDE_CODE_OAUTH_TOKEN` override warning | C | n-a | CLI login flow; Claudius scrubs/sets env per profile (`lib/server/accounts-store.ts:602-624`) |
| 2.1.229 | `/commit-push-pr` dangerous git flags not auto-approved | A | n-a | bundled skill/permissions |
| 2.1.229 | Self-hosted runner Windows requires `--base-dir` | C | n-a | CLI |
| 2.1.229 | [VSCode] Report a problem / `/bug` open feedback dialog | C | n-a | VS Code |
| 2.1.229 | [VSCode] `/btw` side panel resizable | C | n-a | VS Code |
| 2.1.229 | [VSCode] Session groups in sidebar | C | n-a (judgement) | VS Code-only; Claudius session rail has no grouping (`grep -rni "tagSession|session group" lib/server components/sessions` → none) |
| 2.1.228 | Hardened claude.ai-synced skills | A | n-a | engine |
| 2.1.228 | Cross-session messages show sender+body inline | B | implemented (superseded) | final behaviour is 2.1.247's collapse-by-default preview; Claudius `lib/shared/peer-message-preview.ts:1-21` + `components/chat/PeerMessageHeader.tsx`, used in `UserMessage.tsx:9,13` |
| 2.1.228 | Vertex credential fail-fast | A | n-a | engine |
| 2.1.228 | Compaction progress: retry countdown + stall hint during compaction | B | partial (low) | retry countdown rides generic `api_retry` → `SpinnerTip` (`lib/client/use-session.ts:973-978`, `components/chat/SpinnerTip.tsx:29-34`, `MessageList.tsx:637-643`); no stall hint (`grep -ni stall SpinnerTip.tsx MessageList.tsx` → none) |
| 2.1.228 | Terminal title spinner glyphs | C | n-a | terminal title |
| 2.1.228 | Write tool may overwrite unread file on newer models | A | n-a | tool rules |
| 2.1.228 | Removed auto-mode "costs slightly more" first-use note | B | n-a | no such copy in Claudius (`grep -rni "slightly more" components lib`) |
| 2.1.227 | Slash menu: blue only on selected row, matched chars bold, glyphs kept | B | implemented | `lib/shared/slash-commands.ts:407` `fuzzySlashMatchIndices`; `components/chat/SlashCommandPicker.tsx:83-84` `HighlightedCommandName` |
| 2.1.227 | Fewer event-loop stalls (file-not-found suggestions, at-mention size checks) | A | n-a | engine |
| 2.1.226 | "Bug fixes and reliability improvements" | — | n-a | no feature |
| 2.1.225 | Gateway spend-limit in usage warning (cap, reset, operator msg) | A | n-a | arrives as error text; `SDKRateLimitInfo` has no gateway fields (`sdk.d.ts:5646-5665`) |
| 2.1.225 | Workspace trust prompt for `claude agents` | C | n-a | CLI subcommand; Claudius has no trust dialog (`lib/server/trusted-cwd.ts` is a route-level cwd allowlist, not a prompt) |
| 2.1.225 | RC: photos shown to Claude directly | C | n-a | Remote Control |
| 2.1.225 | SendMessage can start conversation with RC sessions by name | A | n-a | tool |
| 2.1.225 | SendMessage: confirmed RC recipient never swapped | A | n-a | tool |
| 2.1.224 | `claude self-hosted-runner` | C | n-a | CLI/infra |
| 2.1.224 | `archive` plugin source (zip over HTTPS, SHA-256) | A | n-a (editor gap) | engine fetch; not expressible in Claudius marketplace editor (see 2.1.232 aliases row) |
| 2.1.224 | Cancel-and-confirm when removing an unavailable paste | C | n-a | TUI paste placeholders |
| 2.1.224 | `ANTHROPIC_BEDROCK_REGION_PREFIX` | B | implemented | `lib/shared/accounts.ts:44-120`, `lib/server/accounts-store.ts:720-721`, picker `app/usage/page.tsx:1128` (run-notes said A — wrong but harmless) |
| 2.1.224 | `crossSessionInbound` + `dialogExpiry` settings | B | implemented | `app/settings/page.tsx:1210,1217` |
| 2.1.224 | Sandbox credential masking (`extract`, JWT, SigV4) | A | n-a | honored only from user/managed settings; engine |
| 2.1.224 | Cross-session `SendMessage` + `ListAgents` | A | n-a | tools engine-side; inbound peer turns rendered (`PeerMessageHeader.tsx`, `lib/server/peer-source.ts`) |
| 2.1.224 | Fullscreen keeps pre-compaction scrollback | C | n-a | TUI |
| 2.1.224 | RC attached clients see compaction progress; `/clear` propagates | C | n-a | Remote Control |
| 2.1.224 | RC persistent connection-failure indicator | C | n-a | Remote Control |
| 2.1.224 | Removed 200-subagent spawn cap | A | n-a | engine |
| 2.1.224 | Managed-settings approval not re-shown after re-login | A | n-a | engine |
| 2.1.224 | Feedback transcript share includes model settings (consent) | B | implemented | `components/chat/FeedbackBanner.tsx:85-87,253-264` |
| 2.1.224 | Bash tool description notes output not shown to user | A | n-a | tool def |
| 2.1.224 | Recalled paste placeholders renumber | C | n-a | TUI |
| 2.1.224 | RC archives stale server session | C | n-a | Remote Control |
| 2.1.223 | Owner wildcard `"owner/*"` in `strictKnownMarketplaces`/`blockedMarketplaces` | B | partial | Claudius lint allows bare `owner/*` strings in the blocked list (`lib/shared/plugin-ref-lint.ts:100-116`, `app/plugins/page.tsx:715-735`), but upstream form is `{"source":"github","repo":"owner/*"}` (`sdk.d.ts` doc above `:7855`/`:8329`); Claudius writes bare strings and `strictKnownMarketplaces: true` (`lib/server/plugins.ts:182-209`) — see 2.1.232 aliases row |
| 2.1.223 | Warning when requested subagent model is restricted and parent model runs | A | n-a (carrier caveat) | engine emits it into the stream; `system/informational` is rendered (`lib/client/use-session.ts:4409-4423`) but SDK `system/notification` (`sdk.d.ts:5467-5477`) has no handler and falls to the text-less `system/notification` catch-all pill (`use-session.ts` ~:4465, `lib/client/sdk-message-filters.ts:266-300`) — if this warning rides `notification`, its text is lost |
| 2.1.223 | `/teleport` hint in cloud sessions | C | n-a | cloud sessions |
| 2.1.223 | `CLAUDE_CODE_DISABLE_1M_CONTEXT` covers all 1M models; startup warning | A | n-a | engine |
| 2.1.223 | Auto-compact bounds unrecognized model IDs (`…_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`) | A | n-a | engine |
| 2.1.223 | `/review` → alias of `/code-review` (`<level> <pr#>`, `ultra`) | A | n-a (low) | bundled skill; picker merges SDK rich commands (`lib/client/useSdkCommands.ts`, `PromptInput.tsx:227`). Static registry copy for `/review` is stale ("Review a pull request", `lib/shared/slash-commands.ts:242`) |
| 2.1.223 | `/code-review` reuses last level | A | n-a | bundled skill |
| 2.1.222 | Auto mode evaluates SendMessage via classifier | A | n-a | engine |
| 2.1.222 | Better refusal for `disable-model-invocation` skills | A | n-a | engine |
| 2.1.222 | `/diff`/file-edit diffs use raw git blob (ignore textconv) | B | implemented | `lib/server/git.ts:303-311,370-374,549` (`--no-textconv`) |
| 2.1.222 | RC auto-start can't be enabled from repo-local settings | C | n-a | Remote Control |
| 2.1.222 | Removed ultraplan | B | implemented | `/ultraplan` delisted (`lib/shared/slash-commands.ts:244-246`), prose hint dropped (`components/chat/PromptInput.tsx:192-194`); `grep -rni ultraplan` only hits those comments |
| 2.1.221 | [VSCode] Focus view (tool activity behind per-turn summary) | C | n-a (judgement) | VS Code chrome; nearest Claudius analog is `compact`/`ultra-compact` verbosity (`lib/shared/verbose.ts:11-30`) — no per-turn expandable summary w/ live running-tool indicator |
| 2.1.221 | Sandbox credential file `mode: "mask"` | A | n-a | engine |
| 2.1.221 | `claude plugin validate` Desktop-name warnings | C | n-a | CLI (Claudius added its own name lint anyway, `33ccb05`) |
| 2.1.221 | `prompt-audit` subcommand of `claude-api` skill | A | n-a | bundled skill (Claudius's own `/doctor prompt-audit` is 2.1.283 work) |
| 2.1.221 | Tool search re-enabled on Vertex 4.5+ | A | n-a | engine |
| 2.1.221 | Auto mode cache-efficient parallel checks | A | n-a | engine |
| 2.1.221 | Reduced prompt-cache cost for auto-mode checks | A | n-a | engine |
| 2.1.221 | Stats panel counts cache tokens w/ breakdown | B | implemented | `components/overlays/CostOverlay.tsx:135-136`, `components/cost/ModelBreakdown.tsx:43-44` |
| 2.1.221 | `/ultrareview` better no-shared-history errors | A | n-a | bundled skill |
| 2.1.221 | Windows startup native kernel32 call | C | n-a | Windows |
| 2.1.221 | Background sessions commit/push, draft PR only when needed | A | n-a | engine behaviour |
| 2.1.221 | `/plugin install` refreshes stale catalog + retries | A | n-a | forwarded to SDK |
| 2.1.221 | Plugins from `/plugin` activate immediately | A | n-a | engine |
| 2.1.221 | Plugins accept `"."` as `skills` path | A | n-a | engine |
| 2.1.221 | `/status` shows session kind | B | implemented | `components/overlays/StatusOverlay.tsx:33-41,83`; scheduler attached/unattended chip `lib/server/scheduler.ts:245-254`, `app/[workspaceId]/schedule/page.tsx:37` |
| 2.1.221 | Emoji autocomplete alternate shortcodes (`:thumbsup:`, `:love:`) | B | implemented | `lib/shared/emoji-shortcodes.ts:220-221` (`EMOJI_ALIASES.love`) |
| 2.1.221 | `/fork` creates its own worktree | B | missing | Claudius `/fork` is native (`lib/shared/slash-commands.ts:79`, `ChatSurface.tsx:1165-1179` → `/api/sessions/fork` → `forkSession` `lib/server/sessions-store.ts:43`), which only copies the transcript (`sdk.d.ts:824-838`); forked session reuses the source cwd. False-rationale A in run-notes |
| 2.1.221 | Claude in Chrome closes its tabs | A | n-a | extension/engine |
| 2.1.221 | Fast mode reports on the stream when credits run out | A | n-a (carrier caveat) | Claudius renders `fast_mode_state` + reason (`lib/client/use-session.ts:3771-3810`, `lib/shared/fast-mode.ts`); same `system/notification` caveat as 2.1.223 row if it rides that subtype |
| 2.1.221 | Monitor says when watch exits with no output | A | n-a | tool text |
| 2.1.221 | Gateway `model` field validation | C | n-a | gateway |
| 2.1.221 | Removed repeated "Permission mode changed while classifier queued" notice | A | n-a | engine |
| 2.1.220 | "Bug fixes and reliability improvements" | — | n-a | no feature |
| 2.1.219 | Claude Opus 5 (`claude-opus-5`), default Opus, fast mode $10/$50 | B | partial | Picker aliases are SDK-driven (`app/api/models/route.ts:56-76`), advisor knows it (`lib/shared/advisor.ts:346,370`), but the pinned "More models" list skips it: `app/api/models/probe/route.ts:37-94` has opus-5-5, opus-4-8 ("prior generation"), 4-7, 4-6 — no `claude-opus-5`. Bundled price snapshot has no opus-5/4-8 (`grep -o '"[^"]*opus[^"]*"' lib/server/litellm-prices.json` tops at 4-7; relies on 24h LiteLLM refresh, `lib/server/litellm-pricing.ts:12-19`) |
| 2.1.219 | `sandbox.network.strictAllowlist` setting | B | missing | PHANTOM in run-notes/2.1.220. `grep -rni "strictAllowlist|allowedDomains" app lib components` → none. Would live next to `sandboxFilesystemDisabled` in `components/workspaces/WorkspaceForm.tsx:79-85,225-228`, `lib/shared/session-defaults.ts`, `lib/server/session.ts:2771-2785` (`Options.sandbox`). SDK field `sdk.d.ts:8653` (+ `allowedDomains`) |
| 2.1.219 | `DirectoryAdded` hook event | B | implemented | `lib/shared/hook-events.ts:36,104` |
| 2.1.219 | `mcp_server_errors` in stream-json init | C | n-a | not in SDK types (`grep mcp_server_errors sdk.d.ts` → none); stream-json only |
| 2.1.219 | `workflowSizeGuideline` settings key | B | implemented | `app/settings/page.tsx:992-997`, `lib/server/settings.ts:205-210,421-450` |
| 2.1.219 | Nested subagent forwarding in stream-json (`--forward-subagent-text`) | C | n-a | CLI stream-json flag |
| 2.1.219 | HTTP status/error text in `/mcp` on connect failure | A | implemented (passthrough) | SDK `status.error` rendered at `app/[workspaceId]/mcp/page.tsx:288-290` |
| 2.1.219 | Warning for MCP config values with hidden leading/trailing whitespace | B | missing | built on unmerged `cc-parity/2.1.218` (`c7e56ec`: `findConfigWhitespaceWarnings` in `lib/server/mcp.ts`), not on HEAD (`grep -rn "findConfigWhitespaceWarnings|HAS_EDGE_WHITESPACE" lib app` → none). Claudius's add form trims url/command only (`mcp/page.tsx:386-399`), env/header values untrimmed, hand-edited `.mcp.json` unchecked |
| 2.1.219 | RC "only via api.anthropic.com" error names setting | C | n-a | Remote Control |
| 2.1.219 | `claude --teleport` repo mismatch message | C | n-a | CLI |
| 2.1.219 | Dynamic workflows default to medium size guideline | A | n-a | engine default; Claudius row says "Absent leaves the SDK default" (`app/settings/page.tsx:996`) |
| 2.1.219 | Managed MCP allow/deny `${VAR}` resolve from startup env | A | n-a | engine |
| 2.1.219 | `/model` picker highlights only newest model | B | n-a (low) | Claudius picker highlights no models at all (`grep -ni "newest|isNew|highlight" components/panels/widgets/ModelPicker.tsx` → only `isCurrent` comment :41); `ModelInfo` has no recency field |
| 2.1.219 | Default workflow size on running-workflow status line w/ `/config` pointer | B | missing (low) | `components/chat/WorkflowBlock.tsx` has no size/guideline display (`grep -ni "guideline|size"` → none) |
| 2.1.219 | Removed Opus 4.7 from fast mode | A | n-a | gated by SDK `ModelInfo.supportsFastMode` (`ModelPicker.tsx:855`) |
| 2.1.219 | `claude-api` skill defaults to Opus 5 | A | n-a | bundled skill |
| 2.1.219 | Nested subagents up to depth 3 by default | A | n-a | engine; Claudius routes subagent traffic generically by `parent_tool_use_id` (`lib/client/use-session.ts:2658,3067,3287`) |
| 2.1.218 | `/code-review` runs as background subagent | A | n-a | bundled skill |
| 2.1.218 | Screen-reader deletion announcements | C | n-a | TUI a11y |
| 2.1.218 | `/ultrareview` invalid-arg feedback | A | n-a | bundled skill |
| 2.1.218 | Auto mode: rm/`&`/Windows-path checks go to classifier | A | n-a | engine |
| 2.1.218 | Sandbox command restrictions for IDE interactions | A | n-a | engine |
| 2.1.218 | Trust dialogs name repository root | C | n-a | Claudius has no workspace-trust dialog (workspaces are added explicitly; `lib/server/trusted-cwd.ts:8-40` is an API cwd allowlist) |
| 2.1.218 | `/deep-research` only on manual invocation | A | n-a | bundled skill |
| 2.1.218 | Plan mode + auto: classifier judges unprovable Bash | A | n-a | engine |
| 2.1.218 | Announcement when fast mode changes due to model switch | B | missing (low) | `components/chat/FastModeNoticePanel.tsx:27` kinds = `"cooldown" | "recovered"` only; the `model-switch` kind from `c7e56ec` is unmerged |
| 2.1.218 | Benign server-managed toggles skip approval prompt | A | n-a | engine |
| 2.1.218 | Agent markdown names containing `:` rejected | B | partial (low) | filename regex blocks `:` (`lib/server/agents.ts:85`), but frontmatter `name:` field not validated on write (`agents.ts:79-97`); the fix in `c7e56ec` is unmerged |
| 2.1.218 | Skills with `context: fork` run in background (`background: false` opt-out) | A | n-a | engine; Claudius skill editor is raw text (`app/[workspaceId]/skills/page.tsx:369`), no frontmatter field catalog |
| 2.1.218 | `yes/no/on/off/1/0` accepted for skill/plugin frontmatter booleans | A | n-a | engine; Claudius interprets no skill frontmatter booleans (`grep -rn "user-invocable|disable-model-invocation" lib app components` → only skillOverrides values) |

Fixed bullets: reviewed all; none flagged F. Candidates checked and cleared — queued messages in prompt history (Claudius removes queued bubbles from `messages`, `lib/client/use-session.ts:5196-5207`, and history derives from `messages`, `ChatSurface.tsx:1801-1816`); queued `!` command sent as text (Claudius `!` runs via separate `/bash` endpoint, `lib/client/sendBash.ts:13-27`, never queued); "Ran 1 shell command" grouping (Claudius has no tool-row grouping); markdown `---`/Unicode slowness (TUI renderer); `/model` "Requires usage credits"/"Opus (1M context)" labels (Claudius uses SDK `displayName`, no own label).

## Counts
Rows: 180 (incl. 3 no-feature rows; 2.1.231 has only a Fixed bullet).
By bucket: A 84 · B 41 · C 52 · F 0 · — 3.
B by status: implemented 22 · partial 5 · missing 8 (3 low-value: workflow-size status line, fast-mode model-switch notice, MCP whitespace warning) · n-a 6 (2× /goal, teammate model, auto-mode cost note, GitHub-app tip, newest-model highlight).
B partial: marketplace schema (aliases + owner/* rows), Opus 5 pin, compaction stall hint, agent-name `:`.
B missing: GitLab/GitHub PR-MR badge, auto-continue at usage limit, @-session mention, /fork worktree, sandbox strictAllowlist, MCP whitespace warning, workflow-size status line, fast-mode model-switch notice.
