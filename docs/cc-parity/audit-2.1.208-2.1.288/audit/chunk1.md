# CC parity audit — chunk1 (2.1.281–2.1.284)

Repo audited: <repo> @ cf6b644 (SDK 0.3.288). Every non-Fixed bullet has a row; F rows are Fixed bullets naming a Claudius-reimplemented surface.

Key meta-findings: 2.1.281 `attribution` row, 2.1.282 maxProseWidth browser cap and ultracode plain-styling are PHANTOM implementations (never in any commit). 2.1.284 has no run note: its parity work (commit c8cdef2, /mcp reconnect all + /rate-limit-options) sits on origin/sdk-update/0.3.284 and was never merged; its plan (23c741e) mis-classified Sonnet 5.5, the safeguards notice, Monitor rows and the usage-limit block as A/C.

| version | bullet (short) | bucket | status | evidence |
|---|---|---|---|---|
| 2.1.284 | Sonnet 5.5 (`claude-sonnet-5-5`) default Sonnet, $2/$10, $0.20 cache read | B | partial | Picker rows come from SDK `supportedModels()` + `sonnet` alias (app/api/models/route.ts:61) and advisor lists include it (lib/shared/advisor.ts:358-375), BUT: probe list hardcodes Sonnet 5/4.6 only (app/api/models/probe/route.ts:79-88, grep `sonnet-5-5` in app/api → 0); Opus-overload nudge pins `claude-sonnet-5` (components/chat/OpusOverloadNudgePanel.tsx:20); live cost estimator `priceFor()` prices every sonnet at $3/$15/$0.30 (lib/shared/cost-pricing.ts:25-54, used at lib/server/session.ts:7720, lib/client/use-session.ts:2633); bundled LiteLLM snapshot has no sonnet-5* ids (grep lib/server/litellm-prices.json) so offline cost page falls back to first `claude-sonnet*` entry (lib/server/litellm-pricing.ts:270-297). 2.1.284 bot plan (orphan commit 23c741e) wrongly called this A. |
| 2.1.284 | "Yes, but ask again next time" answer for auto-mode out-of-dir read | B | implemented | Existing "Allow once" (no standing grant) in components/chat/PermissionPrompt.tsx:164-169 gives the same semantics for every permission request. |
| 2.1.284 | Gateway spend limit $ amounts in /usage + statusline (`used_usd`,`limit_usd`,`period`) | B | partial | CostOverlay shows `$used / $limit` (components/overlays/CostOverlay.tsx:264-273) from a cast-read of guessed fields (lib/server/session.ts:8574-8629); `spend_limit` is absent from sdk.d.ts (grep → 0) and `period` ("this month") is never read. Unverifiable shape; low value. |
| 2.1.284 | `effortSlider:*` / `toggleUltracode` keybinding actions | C | n-a | TUI /effort slider keys. Claudius /keybindings is a free-text editor (app/[workspaceId]/keybindings/page.tsx:181-183, lib/server/keybindings.ts) — any action string already editable; no action catalog to extend. |
| 2.1.284 | `/rate-limit-options` in /help + command menu | B | missing | grep `rate-limit-options` in lib/shared/slash-commands.ts → 0 entries (only comments: components/chat/RateLimitHitPanel.tsx:7,65, components/chat/SystemPill.tsx:532, lib/client/use-session.ts:2700). Implemented on UNMERGED commit c8cdef2 (origin/sdk-update/0.3.284, never reached main — `git merge-base --is-ancestor c8cdef2 HEAD` false). |
| 2.1.284 | `/mcp reconnect all` | B | missing | Only per-server Reconnect: lib/client/useMcp.ts:114-141, app/[workspaceId]/mcp/page.tsx:168,252. grep `reconnectAll/reconnect all` in app/lib/components → 0. Implemented on UNMERGED commit c8cdef2 (origin/sdk-update/0.3.284). |
| 2.1.284 | Gateway startup warnings for empty `availableModels` | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.284 | Gateway `auth: { google: {} }` telemetry forward | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.284 | Gateway `private_key_jwt` client auth | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.284 | Usage-limit wait: state + countdown + usage-credits option as one block; no repeated countdown | B | partial | RateLimitHitPanel already renders state+countdown in one block (components/chat/RateLimitHitPanel.tsx:86-104) but the usage-credits option only appears for `errorCode === credits_required` (:110-138); ordinary limits always show "Upgrade your plan/Team" links (:145-149) with no `/usage-credits` option and no subscription gating (grep `subscriptionType` in RateLimitHitPanel.tsx/SystemPill.tsx → 0). See F row for the related 2.1.284 fix. |
| 2.1.284 | Better "No such tool" error for Chrome tools | A | n-a | Engine tool-error text. |
| 2.1.284 | Monitor event rows show what each event printed; no repeated 'Waiting for N' line | B | partial | Claudius drops every `<task-notification>` wrapper (lib/client/use-session.ts:3580-3584, lib/client/sdk-message-filters.ts:223-232); a monitor only appears as a task row in BackgroundTasksPanel (components/panels/BackgroundTasksPanel.tsx:199). No per-event output row. Low value / judgement. |
| 2.1.284 | Workflow tool sandbox hardening | A | n-a | Engine. |
| 2.1.284 | Settings-schema startup/memory improvement | A | n-a | Engine. |
| 2.1.284 | `/claude-api` hillclimb improvements | A | n-a | Bundled skill content. |
| 2.1.284 | /tasks /copy /hooks list column alignment | C | n-a | TUI text layout. |
| 2.1.284 | `claude plugin marketplace add` replacement notice | C | n-a | CLI subcommand; Claudius edits `extraKnownMarketplaces` list (lib/server/plugins.ts:182), no add-from-source flow. |
| 2.1.284 | Startup refusal names the conflicting credential (forceLoginMethod/OrgUUID) | A | n-a | Engine startup error text (SDK surfaces it via the startup-refusal reason). |
| 2.1.284 | Auto-memory neutralizes invisible chars / imitation tags | A | n-a | Engine memory ingestion. |
| 2.1.284 | `claude remote-control` asks for trust | C | n-a | Remote Control CLI. |
| 2.1.284 | Artifact pages: design plan in page, reuse user's name as title | A | n-a | Bundled artifact skill behaviour. |
| 2.1.284 | Artifact tool handles chat/project links / bare ids | A | n-a | Tool-internal. |
| 2.1.284 | Interactive sessions start in auto mode when no permission mode configured | B | partial | Claudius pins `bypassPermissions` for new workspaces (lib/server/workspaces-store.ts:169-171) and the Session constructor falls back to `"default"` (lib/server/session.ts:2258) instead of letting the CLI default/`permissions.defaultMode` decide. Deliberate product choice — judgement call. |
| 2.1.284 | Ultracode is its own /effort toggle: no longer forces xhigh, stays on at any effort (`/effort ultracode on/off`) | B | partial | use-session mirror updated (commit ef40cb5) but UI still composes Ultracode as an effort tier: composite chip calls `pickEffort("xhigh")` then toggle (components/panels/widgets/ModelPicker.tsx:591-619); Dynamic Workflows toggle gated on xhigh support with sublabel "xhigh effort + parallel subagents" (:634-662); `setEffort` sends `effortLevel` without `ultracode` so any effort pick turns ultracode OFF (lib/client/use-session.ts:5831-5839) — CLI keeps it on (send both keys, sdk.d.ts:2940-2943); typed `/effort` is forwarded to the SDK which rejects it (use-session.ts:5813-5818; registry handler `sdk` at lib/shared/slash-commands.ts:127) so `/effort ultracode on` can't work. |
| 2.1.284 | Dropped-connection retries share one budget | A | n-a | Engine retry logic. |
| 2.1.284 | Safeguards-flag notice explains why + offers edit & retry | B | missing | SDK emits `model_refusal_fallback` / `model_refusal_no_fallback` system messages with `content`, `api_refusal_explanation`, `refused_user_message_uuid` (the edit-and-retry target) (sdk.d.ts:5412-5460) and an `onUserDialog` `refusal_fallback_prompt` kind (sdk.d.ts:1766-1780). grep `refusal/model_refusal/onUserDialog/dialog_kind` in lib/ components/ → 0. Subtypes handled by use-session.ts don't include them. 2.1.284 bot plan called this A ("API-returned text") — false rationale. |
| 2.1.284 | Safety model switches with pinned Opus: API picks target | A | n-a | Engine/API. |
| 2.1.284 | Non-interactive first turn waits 2s for named MCP servers | A | n-a | Engine. |
| 2.1.284 | /recap declines when relayed from chat thread/routine/webhook | A | n-a | Claudius /recap (native, lib/shared/slash-commands.ts:122) is only user-typed; relay paths don't exist. |
| 2.1.284 | /artifacts filter tabs (All/Mine/Shared) | C | n-a | TUI layout of /artifacts. Claudius has no Artifacts surface at all (see 2.1.281 footer-pill row). |
| 2.1.284 | Artifact publishing refuses network-share files | A | n-a | Tool-internal. |
| 2.1.284 | [VSCode] Optional message timestamps setting | C | n-a | VS Code extension. |
| 2.1.284 | [VSCode] Plugin load errors in Manage plugins rows | C | n-a | VS Code extension (Claudius already lists load errors: app/plugins/page.tsx:551-577). |
| 2.1.284 | [VSCode] Ultracode on/off switch under Effort slider | C | n-a | VS Code extension — same gap tracked on the 2.1.284 Ultracode row. |
| 2.1.284 | [VSCode] `CLAUDE_CONFIG_DIR` absolute-only | C | n-a | VS Code extension. |
| 2.1.284 | [Claude Tag] Added model family choices such as "Opus (latest)" for a  | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Added the spend that counts toward your organization-wide | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Changed Claude to post its private sign-in notice at ever | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Improved "Notify members now" in admin settings: one pres | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Improved Claude's wait notice on self-hosted environments | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Improved the error shown when adding a channel manager fa | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Improved a channel's access lists in admin settings to sh | C | n-a | Slack product. |
| 2.1.284 | [Claude Tag] Improved adding repositories as a channel manager: when y | C | n-a | Slack product. |
| 2.1.283 | `x-claude-code-prompt-id` gateway hint header | A | n-a | Engine request headers (env opt-in). |
| 2.1.283 | `availableModelsMatch` managed setting | A | n-a | Engine enforces managed model policy. Note: Claudius re-adds SDK-gated aliases via ALWAYS_SHOWN_ALIASES (app/api/sessions/[id]/model/route.ts:42-59,141) so a denied Fable can still be listed — low value. |
| 2.1.283 | `deniedModels` managed setting | A | n-a | As above (engine-enforced; ALWAYS_SHOWN_ALIASES caveat). |
| 2.1.283 | MCP/WebFetch/WebSearch outputs in OTel `tool.output` | A | n-a | Engine telemetry. |
| 2.1.283 | `/doctor prompt-audit` (`/checkup prompt-audit`) | B | implemented | app/api/doctor/route.ts:121-200 (`promptAuditChecks`), lib/shared/prompt-audit.ts, lib/server/prompt-audit.ts, app/doctor/page.tsx:160, components/chat/ChatSurface.tsx:1514, lib/shared/slash-commands.ts:228. |
| 2.1.283 | Click-to-expand truncated messages from other sessions | B | implemented | components/nav/NotificationsDrawer.tsx:226-237 (peek expand). Note: uses a >60-char heuristic, not the DOM measurement the 2.1.283 note claims. |
| 2.1.283 | `path` on `plugin_errors` entries | B | implemented | lib/shared/parse-init.ts:127-128 → app/plugins/page.tsx:577. |
| 2.1.283 | Gateway `load_test_mode` | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.283 | Gateway `mantle` upstream | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.283 | /mcp tool list: more tools, paging, org-blocked tools marked | B | partial | Tool list exists (app/[workspaceId]/mcp/page.tsx:306-310) but no org-blocked marker; SDK `McpServerStatus.tools` carries no blocked flag (sdk.d.ts:1269-1281) — would need cross-referencing managed deny rules. Paging half is C. Low value. |
| 2.1.283 | MCP tool images also saved to a file | A | n-a | Engine tool-result handling. |
| 2.1.283 | /tasks rows: status icon, paging | C | n-a | TUI; Claudius BackgroundTasksPanel already has status icons (components/panels/BackgroundTasksPanel.tsx:192-199). |
| 2.1.283 | Picker lists gain page keys / mouse | C | n-a | TUI. |
| 2.1.283 | Dim list pointer while search box focused | C | n-a | TUI focus rendering. |
| 2.1.283 | Compaction spinner: timer from compaction start, streamed summary tokens | B | implemented | Elapsed timer, no fake percentage: components/chat/ContextWarningBanner.tsx:21-45. Token-count half not exposed by SDK (`SDKStatus = 'compacting'` only, sdk.d.ts:5892) → n-a. |
| 2.1.283 | MCP sign-in browser landing page restyle | A | n-a | Engine-served OAuth callback page; Claudius has no MCP OAuth callback route (find app -path '*oauth*' → only app/api/accounts/oauth). |
| 2.1.283 | Skill tool reply for skill from failed plugin | A | n-a | Tool-internal. |
| 2.1.283 | prompt-audit: stale paths, stale commands, contradicting files lead the report | B | partial | Stale paths lead (app/api/doctor/route.ts:183-195) but stale-command and contradicting-instruction-file detection explicitly deferred (route.ts:183-185); grep `staleCommand/contradict` in lib/ → 0. |
| 2.1.283 | Recovery from unreadable installed_plugins.json | A | n-a | Engine plugin registry; Claudius doesn't read installed_plugins.json (grep → 0). |
| 2.1.283 | Artifact DB ordered-query paging hint | A | n-a | Tool-internal. |
| 2.1.283 | First-reply latency (pattern compile) | A | n-a | Engine. |
| 2.1.283 | First-request latency (preconnect reuse) | A | n-a | Engine. |
| 2.1.283 | Startup: -p/Remote skip interactive UI; lazy classifier/Artifact | A | n-a | Engine. |
| 2.1.283 | Startup no longer waits for Artifact feature check | A | n-a | Engine. |
| 2.1.283 | 3P providers / telemetry-off sessions start in auto mode | B | partial | Grouped with the 2.1.284 auto-mode default row (workspaces-store.ts:169-171, session.ts:2258). Judgement. |
| 2.1.283 | /ultrareview launch dialog warns about uploading uncommitted changes | B | missing | /ultrareview is a pass-through (lib/shared/slash-commands.ts:247, handler `sdk`); no Claudius confirmation before launch. Low value. |
| 2.1.283 | /model Opus row drops "(1M context)" | A | n-a | Labels come from SDK `supportedModels()`; grep `1M context` finds no hardcoded picker label (only probe descriptions). |
| 2.1.283 | Prompt suggestions appear less often after 20 unused | B | missing | Claudius renders every SDK `prompt_suggestion` (components/chat/PromptSuggestions.tsx:10, ChatSurface.tsx:2420-2423); the throttle is a TUI-side heuristic (SDK has no acceptance feedback field). grep for an unused-streak counter → 0. Low value. |
| 2.1.283 | `--system-prompt` + `-file` forms together | C | n-a | CLI flags. |
| 2.1.283 | `Skill(...)` deny-rule matching | A | n-a | Engine permission matcher. |
| 2.1.283 | /rewind /diff keybinding actions | C | n-a | TUI. |
| 2.1.283 | /workflows list sizing | C | n-a | TUI. |
| 2.1.283 | `claude plugin eval` git ≥2.31 | C | n-a | CLI subcommand. |
| 2.1.283 | Auto-armed artifact watch expires after 3.5h | A | n-a | Tool-internal. |
| 2.1.283 | Self-hosted runner git hooks | C | n-a | Runner product. |
| 2.1.283 | Self-hosted runner GIT_SSL_* | C | n-a | Runner product. |
| 2.1.283 | Reverted 2.1.282 `claude-ai` name reservation | A | n-a | Engine skill loading; nets out 2.1.282 rows for `claude-ai`. grep `claude-ai` in lib/app/components → 0. |
| 2.1.283 | [Cloud sessions] Improved adding a repository to a running cloud session: a | C | n-a | Cloud product. |
| 2.1.283 | [Cloud sessions] Changed new routine schedules to default to a few minutes  | C | n-a | Cloud product. |
| 2.1.283 | [Claude Tag] Added a "Channels Claude can search" admin setting that l | C | n-a | Slack product. |
| 2.1.283 | [Claude Tag] Added a Back to Slack button on the page shown after conn | C | n-a | Slack product. |
| 2.1.282 | `maxProseWidth` setting (cap prose width, tables/code full width) | B | partial | Only a passthrough catalog row whose copy says it doesn't affect Claudius (app/settings/page.tsx:1297-1307). Markdown `p/ul/ol` have no width cap (components/chat/Markdown.tsx:259-264); `git log --all -S'prose-max-width'` → empty, so the 2.1.282 note's `lib/client/prose-width.ts` / `--prose-max-width` / ChatSizeSection slider never existed (PHANTOM). |
| 2.1.282 | Startup notice + /status + doctor entries for ignored/telemetry-off vars in project settings | B | missing | Doctor has no telemetry check (grep `otel/telemetry` in app/api/doctor/route.ts → 0). Pairs with 2.1.282 change that project/local settings' OTEL vars are ignored. Low value. |
| 2.1.282 | `allowClaudeInChromeWithManagedMcp` managed setting | C | n-a | `claude --chrome`; Claudius /chrome is a no-op (lib/shared/slash-commands.ts:187). |
| 2.1.282 | Gateway `store.readiness_grace_seconds` | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.282 | /feedback drafts scrollbar (fullscreen) | C | n-a | TUI. |
| 2.1.282 | Faster resume of very large sessions | A | n-a | Engine. |
| 2.1.282 | Windows EBADF resume error text | A | n-a | Engine error text. |
| 2.1.282 | Claude Desktop unknown-model error | C | n-a | Desktop. |
| 2.1.282 | Unusual Unicode in permission prompts | C | n-a | Terminal rendering. |
| 2.1.282 | /artifacts list layout + paging | C | n-a | TUI; no Artifacts surface in Claudius. |
| 2.1.282 | claude-api skill: refusal billing docs | A | n-a | Bundled skill. |
| 2.1.282 | claude-api skill: `ant apply` | A | n-a | Bundled skill. |
| 2.1.282 | Auto mode server-side classifier by default (telemetry off) | A | n-a | Engine. |
| 2.1.282 | `sandbox.excludedCommands` precedence under managed settings | A | n-a | Engine settings resolution. |
| 2.1.282 | Project/local settings ignore OTEL export/content vars | A | n-a | Engine. (Claudius's project-scope env editor can still write them — surfaced by the doctor row above.) |
| 2.1.282 | Windows/WSL invalid managed policy blocks HKCU | A | n-a | Engine. |
| 2.1.282 | `Skill(anthropic-skills:*)`/`Skill(claude-ai:*)` allow rules cover only synced skills | A | n-a | Engine matcher. |
| 2.1.282 | Skills/commands in `anthropic-skills`/`claude-ai` namespace no longer load (claude-ai reverted in 2.1.283) | A | n-a | Engine loading; grep `anthropic-skills/claude-ai` in lib/app/components → 0. |
| 2.1.282 | MCP servers named `anthropic-skills`/`claude-ai` list no skills/prompts | A | n-a | Engine. |
| 2.1.282 | Ultracode visuals plain (no ripple/border flourish/keyword glimmer); spinner tip removed | B | partial | PHANTOM in 2.1.282 note: gradient border + `✦` prefix still at components/panels/widgets/ModelPicker.tsx:937-959 (`border-fuchsia-500/40 bg-gradient-to-r from-amber-500/15 to-fuchsia-500/15`, `✦ ${label}`); composer workflow hint still renders Sparkles (components/chat/PromptInput.tsx:1784,1802); `git log --all -S'plain?: boolean'` → empty. Tip half: no workflow tip in lib/shared/tips.ts → n-a. Folded into the 2.1.284 Ultracode gap. |
| 2.1.282 | Clawd mascot feet | C | n-a | Terminal banner. |
| 2.1.282 | [Cloud sessions] Added Claude GitHub App status to Settings › Connectors ›  | C | n-a | Cloud product. |
| 2.1.282 | [Cloud sessions] Added "Open repository" and "Open compare page" links to t | C | n-a | Cloud product. |
| 2.1.282 | [Cloud sessions] Added attaching a repository from a different GitHub owner | C | n-a | Cloud product. |
| 2.1.282 | [Cloud sessions] Improved how quickly the Routines page and the sidebar's S | C | n-a | Cloud product. |
| 2.1.282 | [Claude Tag] Changed the bordered cards Claude uses in Slack replies f | C | n-a | Slack product. |
| 2.1.282 | [Claude Tag] Changed newly connected Slack workspaces to follow the cu | C | n-a | Slack product. |
| 2.1.281 | Gateway: Claude apps gateway support for newer Claude Desktop keys in `de | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.281 | Gateway: `assume_role` on Claude apps gateway Bedrock upstreams: the gate | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.281 | Gateway: `guardrail: {id, version}` on Claude apps gateway Bedrock upstre | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.281 | Gateway: `telemetry.resource_attributes` to the Claude apps gateway confi | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.281 | `"attribution": false` setting (hide commit/PR attribution) | B | partial | No catalog row: app/settings/page.tsx:957-958 says attribution is omitted; only reachable as raw JSON via the generic Other editor (app/settings/page.tsx:1383-1395). `includeCoAuthoredBy` row (:1118-1122) lacks `deprecated: true` though SDK marks it deprecated (sdk.d.ts:6781). PHANTOM: 2.1.281 note claims `AttributionCatalogField` shipped; `git log --all -S'AttributionCatalogField'` → empty. |
| 2.1.281 | MCP URL-mode elicitation | B | implemented | components/chat/McpElicitationPrompt.tsx:38-75 (url mode, safe-URL check, opens and resolves accept — no lingering dialog); lib/server/session.ts:2827,3464. |
| 2.1.281 | `claude plugin validate` MCP checks | C | n-a | CLI subcommand. |
| 2.1.281 | /insights auto-mode recommendation | A | n-a | /insights forwarded to SDK (lib/shared/slash-commands.ts:217). |
| 2.1.281 | Scrollbar on /skills /mcp /plugin lists (fullscreen) | C | n-a | TUI. |
| 2.1.281 | Claude Desktop sign-in/usage-limit messages | C | n-a | Desktop. |
| 2.1.281 | Managed settings fetch no futile retries | A | n-a | Engine. |
| 2.1.281 | Interactive startup defers git/telemetry/model checks | A | n-a | Engine. |
| 2.1.281 | Faster resume, file cache matches reads | A | n-a | Engine. |
| 2.1.281 | Faster resume of compacted sessions | A | n-a | Engine. |
| 2.1.281 | Prompt-too-long recovery summarizes huge first prompt | A | n-a | Engine. |
| 2.1.281 | Auto-mode classifier cache reuse after resume | A | n-a | Engine. |
| 2.1.281 | Auto-mode denial covers the outcome | A | n-a | Engine. |
| 2.1.281 | Dangerous-rm check broadened | A | n-a | Engine. |
| 2.1.281 | macOS sandbox allowLocalBinding hint | A | n-a | Engine. |
| 2.1.281 | `--agents` accepts JSON file path / empty prompt | C | n-a | CLI flag; Claudius passes agents via SDK options. |
| 2.1.281 | /batch works with WorktreeCreate hook | A | n-a | Bundled command/engine. |
| 2.1.281 | Plugin hook-failure errors name plugin; validate warns on unquoted ${CLAUDE_PLUGIN_ROOT} | A | n-a | Engine error text + CLI validate. |
| 2.1.281 | claude.ai-synced skills shown by short name in / menu, /skills, /context, /plugin | A | n-a | Claudius renders SDK-provided command names (lib/shared/slash-commands.ts:296-340); naming decided engine-side (unverifiable locally). |
| 2.1.281 | /deep-research reliability | A | n-a | Bundled skill. |
| 2.1.281 | artifact-design skill plain prose | A | n-a | Bundled skill. |
| 2.1.281 | Compressed artifact uploads | A | n-a | Tool-internal. |
| 2.1.281 | Large CLAUDE.md notice counts instruction files together incl. @-imports | B | partial | Doctor `claudeMdSizeChecks` sums only raw project + .claude/CLAUDE.md (app/api/doctor/route.ts:86-101): no @-import resolution (resolver exists: `resolveContent` in lib/server/claudemd.ts, already used by prompt-audit), no CLAUDE.local.md / user / .claude/rules files. |
| 2.1.281 | Debug logs name ignored settings env vars | A | n-a | Engine logging. |
| 2.1.281 | Tabbed dialog ↑/↓ focus | C | n-a | TUI. |
| 2.1.281 | /help /sandbox tab keys | C | n-a | TUI. |
| 2.1.281 | Standard dialog frame for several prompts | C | n-a | TUI. |
| 2.1.281 | /workflows /mcp list paging, `x` stops run | C | n-a | TUI. |
| 2.1.281 | /plugin details Home/End | C | n-a | TUI. |
| 2.1.281 | Background workflow row: name, progress, agent count, elapsed, tokens, large-workflow warning | B | implemented | Analog: WorkflowBlock status + tokens + duration (components/chat/WorkflowBlock.tsx:92-96) and BackgroundTasksPanel rows. Per-agent count not exposed by SDK (WorkflowBlock.tsx:21-24). |
| 2.1.281 | /plugin Installed columns | C | n-a | TUI. |
| 2.1.281 | /skills row layout | C | n-a | TUI. |
| 2.1.281 | Narrow list rows | C | n-a | TUI. |
| 2.1.281 | /diff scrollbar | C | n-a | TUI. |
| 2.1.281 | /hooks detail says hook kind + where to change it; plain notices for disabled/safe-mode/managed-only | B | partial | Claudius /hooks lists only user/project/local settings hooks (lib/server/hooks.ts:23-36) with a disableAllHooks toggle (app/[workspaceId]/hooks/page.tsx:164-169); no plugin/skill/agent-frontmatter hooks, no managed-hooks-only notice (grep `allowManagedHooksOnly` → 0). Low value. |
| 2.1.281 | Screen-reader /mcp 'off' | C | n-a | Screen-reader mode. |
| 2.1.281 | Remote Control confirmation focus delay | C | n-a | Remote Control. |
| 2.1.281 | Send-now moves running tools to background instead of cancelling | B | implemented | app/api/sessions/[id]/queue/send-all/route.ts:6-49 (`priority: "now"`, no interrupt); lib/server/session.ts:3712-3720. |
| 2.1.281 | Server-side classifier also gates read-only/sandboxed commands | A | n-a | Engine. |
| 2.1.281 | `CLAUDE_CODE_AUTO_MODE_SERVER` on direct API | A | n-a | Engine env. |
| 2.1.281 | Dangerous rm prompt 2-min wait then deny | A | n-a | Engine-side timeout; Claudius only renders the canUseTool request. |
| 2.1.281 | AGENTS.md on Bedrock/Vertex/Foundry/gateways/telemetry-off | A | n-a | Engine loading. (Claudius Memory page never lists AGENTS.md — lib/server/claudemd.ts:6 scopes — pre-existing, out of slice.) |
| 2.1.281 | Gateway refuses `\??\` envHelper paths | C | n-a | Claude apps gateway (enterprise proxy) config — no Claudius surface |
| 2.1.281 | Self-hosted runners pass system prompts as files | C | n-a | Runner product. |
| 2.1.281 | Queued messages shown above the spinner | B | implemented | Analog: QueueIndicator strip between transcript and composer (components/chat/ChatSurface.tsx:2424-2432). Spinner-relative placement is TUI layout. |
| 2.1.281 | Session artifact links → one footer pill opening /artifacts (lists session artifacts first) | B | missing | Claudius has no Artifact surface: grep `"Artifact"/enableArtifact/artifacts` in components/lib/app → only unrelated hits; no /artifacts in lib/shared/slash-commands.ts. Artifact tool exists in SDK (sdk-tools.d.ts:3132 ArtifactInput). Judgement (claude.ai-account feature). |
| 2.1.281 | Artifact pages may load scripts from unpkg.com | A | n-a | Tool-internal. |
| 2.1.281 | Fullscreen hover tints row | C | n-a | TUI. |
| 2.1.281 | /mcp row layout | C | n-a | TUI. |
| 2.1.281 | /workflows row layout | C | n-a | TUI. |
| 2.1.281 | Remote Control attachment downloads | C | n-a | Remote Control. |
| 2.1.281 | MCP resource list + @-mention skip MCP Apps UI resources | A | n-a | Claudius @-mention lists files + agents only (components/chat/at-mention.ts:13-18); resource tool is engine. |
| 2.1.281 | `plugin uninstall --json` / dialog says data kept | C | n-a | CLI subcommand; Claudius has no uninstall flow (grep `uninstall` → 0). |
| 2.1.281 | /tasks: `x` on running /ultrareview asks confirmation | B | missing | Single-task stop has no confirm (components/panels/BackgroundTasksPanel.tsx:320,649,801); only stop-all confirms (:382). No way to identify an ultrareview task from TaskInfo. Low value. |
| 2.1.281 | Removed leftover '(removed)' /agents menu entry | C | n-a | Claudius /agents is its own native page (lib/shared/slash-commands.ts:91). |
| 2.1.281 | [VSCode] Continue/Stop prompt when auto mode falls back to billed classifier | C | n-a | VS Code/JetBrains panel. (If the SDK exposes it as an `onUserDialog` kind, Claudius declares none — see 2.1.284 safeguards row.) |
| 2.1.281 | [Web] Fast mode switch in composer model menu | C | n-a | Cloud web; Claudius already has a fast-mode toggle (components/panels/widgets/ModelPicker.tsx:113-114). |
| 2.1.281 | [Web] ded a settings shortcut on the GitHub setup tip and a "Tro | C | n-a | Cloud web product. |
| 2.1.281 | [Web] proved the file card shown when a cloud session can't open | C | n-a | Cloud web product. |
| 2.1.281 | [Claude Tag] Added a short line in the Slack thread after someone pres | C | n-a | Slack product. |
| 2.1.281 | [Claude Tag] Changed the routine list Claude gives when asked in a Sla | C | n-a | Slack product. |
| 2.1.281 | Bulleted lists of plain numbers (`- 316.`) shown with wrong numbers | F | missing | `ol({ children })` drops the `start` prop (components/chat/Markdown.tsx:262-264). Verified with mdast-util-from-markdown: `- 316.` parses to `list{ordered,start:316}` and a numbered list split by a code block yields `list:1, code, list:2` — Claudius renders both restarting at "1.". |
| 2.1.284 | Usage-limit warnings suggest upgrading to users already on top Max; point at /usage-credits | F | partial | RateLimitHitPanel/SystemPill always show "Upgrade your plan" (claude.ai/upgrade/max) + Team links for ordinary limits (components/chat/RateLimitHitPanel.tsx:14,145-149; RateLimitUpgradeLinks :38-59), regardless of plan. SDK `subscription_type` is only 'pro'/'max'/'team'/'enterprise' (sdk.d.ts:4264-4266) so Max 20x can't be detected — partial fix only (hide for team/enterprise, add usage-credits link). |
