# TUI micro-features survey

This directory catalogs small/obscure Claude Code TUI ergonomics that the broader cheatsheet didn't cover, gap-checked against Claudius. Every entry is grounded against at least one of four evidence sources: (1) the actual `claude` binary at `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (~26MB of strings, the authoritative reference), (2) the buildingbetter.tech source-reading article on Claude Code internals, (3) the March 2026 Claude Code source-map exposure mirrored at `claude-code-leak-main/src/` (~512k LOC of TypeScript), and (4) observed in-session `<system-reminder>` payloads. Each feature file carries its trigger, the verbatim TUI strings/identifiers where available, and what Claudius does today; the buckets below summarize where each one landed.

## MISSING (gaps to consider)

- `01-opus-plan-mode-reminder-tip.md` — conditional spinner tip for `opusplan` default-model users who haven't entered Plan Mode in 3+ days.
- `05-desktop-app-contextual-ui-tip.md` — contextual "Working on UI?" tip triggered by recent UI-file edits or dev-server bash tools.
- `08-console-api-key-statsig-tip.md` — `/claude-api` Console-acquisition tip gated by login state, no primary API key, and Statsig flag.
- `09-team-artifacts-priority-tip.md` — top-priority async-content spinner tip that scans for shared team artifacts on session start.
- `17-fast-mode-disabled-reason-diagnostics.md` — six concrete "Fast mode disabled — <reason>" labels surfacing which lever to pull.
- `19-pin-model-versions-1m-probe.md` — `Pin model versions` menu with one-token probe and a `pin1m` variant for the 1M tier.
- `22-kept-model-as-cancel-line.md` — system transcript line "Kept model as <X>" when the `/model` menu is cancelled without a change.
- `30-ide-selection-open-file-reminder.md` — hedged "user selected lines / opened file" reminders from the connected IDE plugin.
- `32-stale-task-tools-teammate-nudge.md` — team-mode counterpart `task_reminder` after N turns without TaskCreate/TaskUpdate.
- `39-verify-plan-reminder.md` — `verify_plan_reminder` after plan completion telling Claude to verify inline (not via Task or sub-agent).
- `40-truncated-file-followup-reminder.md` — silent reminder when a Read or memory load was truncated, instructing Claude not to surface it.
- `42-statusline-stdin-context-percent.md` — `context_window` block (used/remaining/percent) piped into custom `statusLine` stdin.
- `44-statusline-stdin-pr-block.md` — optional `pr` block on `statusLine` stdin mirroring the footer PR badge for the current branch.
- `54-hard-deny-auto-allow-bypass.md` — hard-deny set (`rm -rf` of cwd/parent/system dirs, unset expansions, process substitution, UNC paths) that cannot be auto-allowed regardless of permission mode.
- `55-session-scoped-allow-claude-folder.md` — dedicated "Yes, and allow Claude to edit its own settings for this session" permission branch for `.claude/` writes.
- `56-folder-trust-safety-check.md` — first-launch folder-trust dialog with `tengu_trust_dialog_shown` red-flag telemetry (`hasMcpServers`, `hasBashExecution`, `hasApiKeyHelper`, etc.).
- `79-auto-copy-on-selection.md` — iTerm-style auto-copy-on-selection hook (`hooks/useCopyOnSelect.ts`) gated by a `copyOnSelect` setting, default-on for macOS.
- `81-auto-uninstall-delisted-plugins.md` — `forceRemoveDeletedPlugins` marketplaces silently uninstall delisted plugins with a single user notification per removal.
- `83-background-shell-stall-watchdog.md` — 5s/45s watchdog that detects backgrounded bash waiting on `(y/n)`-style prompts and pings the model with "appears to be waiting for interactive input".
- `90-bridge-reconnecting-status-clock.md` — `Reconnecting · retrying in <delay> · disconnected <elapsed>` ticking status line on bridge drop, with `[bridge:poll] Reconnected after <duration>` log on success.
- `92-bridge-web-attachments-as-path-refs.md` — inbound web composer attachments materialised under `~/.claude/uploads/<sessionId>/` and rewritten as quoted `@path` refs the Read tool picks up.
- `94-bundled-skill-file-extraction.md` — bundled-skill `files: { [relPath]: content }` map materialised under a per-process nonce dir with `mkdir 0o700` and `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` safe-open flags.
- `96-chrome-extension-settings.md` — `/chrome` settings menu for the Claude-in-Chrome MCP integration (install/per-site permissions/reconnect/default-on toggle), gated to claude-ai subscribers.
- `97-clipboard-image-paste-hint.md` — focus-regain hook that fires a one-shot `priority:"immediate"` toast `Image in clipboard · ctrl+v to paste` with an 8s auto-dismiss and 30s focus-event debounce.
- `98-critical-system-reminder-experimental.md` — `criticalSystemReminder_EXPERIMENTAL` agent frontmatter re-injected as a `critical_system_reminder` attachment on every user turn.
- `105-doctor-stale-lock-cleanup.md` — Doctor screen sweeps `~/.claude/locks/*` lockfiles and prints `Cleaned N stale lock(s)` only when something was actually removed.
- `107-dream-task-background-pill.md` — auto-dream consolidation registers as a first-class `DreamTask` with `dreaming` footer pill, `starting`→`updating` phases, and AbortController-driven mtime rewind on cancel.
- `109-extract-memories-end-of-turn.md` — end-of-turn `extractMemories` forked agent via `handleStopHooks`, sharing the parent prompt cache and emitting `[extractMemories] memories saved`.
- `110-find-relevant-memories-sonnet.md` — pre-turn Sonnet `sideQuery` (`querySource: 'memdir_relevance'`) that picks up to 5 memory files by frontmatter manifest, excluding already-surfaced paths.
- `111-footer-indicator-drilldown-nav.md` — `Footer` keybinding context (Up/Ctrl+P, Down/Ctrl+N, Left/Right, Enter, Escape) turning the status line into an interactive indicator launcher.
- `113-in-process-teammate-task-type.md` — `in_process_teammate` task kind for team mode, with per-teammate `AsyncLocalStorage` isolation, `agentName@teamName` identity, independent Shift+Tab permission cycling, and 59 binary hits.
- `114-install-github-app-wizard.md` — `/install-github-app` multi-step wizard probing `gh` auth, picking a repo, installing the Claude GitHub App, managing the secret, and writing `claude` + `claude-review` workflow files.
- `115-install-slack-app-link.md` — `/install-slack-app` opens `https://slack.com/marketplace/A08SF47R6P4-claude` and bumps `slackAppInstallCount` for upsell suppression.
- `116-kairos-append-only-daily-logs.md` — assistant-mode append-only memory logs at `memoryDir/logs/YYYY/MM/YYYY-MM-DD.md` (path is a literal pattern so the prompt-cache prefix survives midnight rollover), distilled nightly by `/dream`.
- `117-keybindings-hot-reload-validation.md` — chokidar watcher on `~/.claude/keybindings.json` (500ms stability, 200ms poll) with `parse_error`/`duplicate`/`reserved`/`invalid_context`/`invalid_action` warnings and once-per-day telemetry.
- `119-list-read-mcp-resources.md` — `ListMcpResources` / `ReadMcpResource` SDK tools that treat MCP servers as resource directories (uri/name/mimeType/description + server field), filterable by server.
- `120-lsp-code-intelligence-tool.md` — first-class LSP tool with `goToDefinition`/`findReferences`/`hover`/`documentSymbol`/`workspaceSymbol`/`goToImplementation` plus the three call-hierarchy phases.
- `121-lsp-plugin-recommendation-on-edit.md` — one-shot per-session install nudge when an edit's extension matches an LSP plugin and the LSP binary is already on the system but the plugin isn't installed.
- `122-mcp-auth-in-session-tool.md` — `McpAuth` pseudo-tool surfaced in place of an unauthenticated MCP server's real tools, calling `performMCPOAuthFlow` and swapping in the real `mcp__<server>__<tool>` entries on success.
- `123-memory-md-truncation-banner.md` — `MEMORY.md` index capped at 200 lines / 25KB with the verbatim `> WARNING: <ENTRYPOINT_NAME> is <reason>. Only part of it was loaded.` banner so the model knows it's seeing a partial index.
- `124-memory-staleness-reminder.md` — per-memory age caveat (`today`/`yesterday`/`N days ago`) injected as `<system-reminder>` for any memory >1 day old, instructing the model to treat `file:line` citations as hints not ground truth.
- `127-model-migration-toast.md` — one-shot post-migration toast guarded by `numStartups > 1` and stamped with `*MigrationTimestamp` so new users never see it and returning users see it exactly once.
- `128-monitor-vs-bash-summaries.md` — distinct `Monitor X stream ended` / `Monitor X script failed (exit N)` / `Monitor X stopped` summaries dispatched with priority `next` so Monitor exits land before the next turn.
- `132-orphaned-plugin-gc.md` — `.orphaned_at` marker files keep old plugin versions on disk for 7 days; the filter auto-appends `--glob !<dir>/**` to Grep/Glob calls so stale code never surfaces to the model.
- `134-output-styles-keep-coding-instructions.md` — `keep-coding-instructions: true|false` frontmatter on output styles to decide whether the default coding-persona prompt is still appended.

## PARTIAL (Claudius covers some of it)

- `13-weekly-limit-now-using-fallback.md` — weekly-limit detection, labels, and countdown exist, but the "Now using <fallback>" takeover toast pairing the model change with the weekly-limit reason is missing.
- `16-fast-mode-overloaded-resets-toast.md` — fast-mode state chip exists, but the differentiated overloaded-vs-quota reason, live reset countdown, and recovery toast are not surfaced.
- `18-draws-from-credits-model-suffix.md` — Fast-mode badge and 1M cost hint exist, but the explicit "Draws from usage credits" sublabel on toggle/rows/confirmation is missing.
- `21-model-deprecation-warning-notification.md` — model-deprecation labels exist, but the high-priority `model-deprecation-warning` ambient banner for deprecated selected models is not wired.
- `23-remote-set-model-rejected-notice.md` — `/model` exists, but the "Remote session couldn't switch to <model>" rejection banner for remote/teleport hosts is missing.
- `25-ultraplan-prose-keyword-launcher.md` — `/ultraplan` slash command exists, but the prose-keyword detector that surfaces an "ultraplan-active" banner from bare prose is not wired.
- `26-workflow-keyword-pill-dismiss-restore.md` — the "Dynamic workflow requested for this turn" pill ships, but Alt+W chord, `ultraplan|ultrathink|ultrareview` triggers, restore state, telemetry, and `ctrl+s stash` hint are not.
- `37-midturn-message-inject-reminders.md` — mid-turn user input is queued and a one-shot goal reminder can be prepended, but the forceful "MUST address" wrapper, "this is automated, not an ack" framing, and coordinator/peer variants are missing.
- `76-advisor-second-model-config.md` — model picker covers the base model, but the `/advisor` second-model surface (`advisorModel` as both app-state cursor and persisted user setting, with `unset`/`off` clears) is not wired.
- `84-background-task-pill-typed-labels.md` — Claudius footer shows running tasks, but the type-specific collapse (`1 shell` / `N monitors` / `1 local agent` / `1 team` / `1 background workflow` / diamond-prefixed cloud sessions / `dreaming`) is not implemented.
- `95-bundled-skills-shipped-in-binary.md` — Claudius ships its own skill loader, but the binary-bundled ~12-skill registry (`source: "bundled"` / `loadedFrom: "bundled"`, `/skillify`, `/remember`, `/stuck`, `/verify`, `/simplify`, `/batch`, `/debug`, some ant-only) is not present.
- `100-dangerous-mode-acknowledgment-persistence.md` — `skipDangerousModePermissionPrompt` round-trips through `app/settings/page.tsx`, but the first-time warning dialog whose acknowledgment it is meant to remember was never built (bypass mode is selectable straight from the dropdown with no modal).
- `102-disable-model-invocation-frontmatter.md` — skill loader exists, but the `disable-model-invocation: true` frontmatter that hides a skill's description from the agent catalog while keeping it user-typeable is not honored.
- `106-double-press-exit-confirmation.md` — Ctrl+C/Ctrl+D exit paths exist, but the generic 800ms double-press detector (`DOUBLE_PRESS_TIMEOUT_MS = 800`) with status-line "Press X again to exit" arming is not factored out as a reusable primitive.
- `108-enter-exit-worktree-tool.md` — Claudius supports worktrees at the workspace layer, but the agent-callable `EnterWorktree` / `ExitWorktree` tool pair (gated on the user literally saying "worktree", delegating to `WorktreeCreate`/`WorktreeRemove` hooks for non-git repos, prompting keep-or-remove on session exit) is not exposed.
- `118-keybindings-reserved-shortcuts.md` — keybindings editor exists, but the reserved-chord block (`ctrl+c`/`ctrl+d`/`ctrl+m` hard-block, `ctrl+z`/`ctrl+\` warn, macOS `cmd+c/v/x/q/w`/`cmd+tab`/`cmd+space` block) with friendly per-entry `reason` strings is not enforced.
- `125-memory-typed-taxonomy.md` — memory subsystem exists, but the closed `user`/`feedback`/`project`/`reference` taxonomy (with per-type `<when_to_save>`/`<how_to_use>`/`<body_structure>` blocks and the "lead with the rule, then **Why:** / **How to apply:**" body shape) is not enforced.
- `126-mobile-qr-code-command.md` — outbound deep-links to mobile exist, but the `/mobile` (aliases `/ios`, `/android`) in-terminal/in-UI QR-code command with platform switcher and Show/Hide controls is not wired.
- `129-notify-after-idle-timeout.md` — turn-completion notifications exist, but the explicit `DEFAULT_INTERACTION_THRESHOLD_MS = 6000` idle-window check that cancels the ding when the user is still active is not factored out.
- `135-output-styles-user-project-dirs.md` — Skills/Agents directory loaders exist, but the user+project output-styles directory loader (`~/.claude/output-styles/*.md` + `<projectCwd>/.claude/output-styles/*.md` with project entries shadowing user entries) is not wired.

## ALREADY_EXISTS (covered by current UI)

- `02-multi-claude-color-rename-nudge.md` — multi-Claude `/color` and `/rename` workflow already covered by SessionTabs labelling and the existing session-rename surface.
- `03-default-permission-mode-config-nudge.md` — `/config` nudge after first Plan Mode use covered by the existing permission-mode settings flow.
- `04-prompt-queue-up-arrow-hint.md` — queueing and click-to-edit are richer than the TUI; the up-arrow placeholder hint is effectively superseded.
- `06-powerup-onboarding-tip-new-users.md` — onboarding/welcome surface already covers the first-run nudge equivalent of `/powerup`.
- `07-spinner-tips-override-settings.md` — Claudius has its own rotating spinner tips with dismissal weighting; the `spinnerTipsEnabled`/`spinnerTipsOverride` knobs and per-tip `cooldownSessions` are folded into that subsystem.
- `10-opus-high-load-sonnet-nudge.md` — model picker plus existing fallback messaging already covers manual "switch to Sonnet" guidance after 529s.
- `11-opus-4-high-demand-banner.md` — fallback-model plumbing and ModelPicker collectively cover the "high demand for Opus" surface.
- `12-auto-model-fallback-transcript-line.md` — automatic-fallback transcript line covered by the SDK fallback path Claudius already renders.
- `14-approaching-limit-lever-hints.md` — "Approaching usage limit" warning with `/model` and `/effort` lever chips covered by Claudius's limit UI.
- `15-fast-mode-auto-cooldown-recovery.md` — SDK-driven `fastModeState` chip in `StatusLine.tsx` already reflects cooldown and auto-recovery transitions with no extra plumbing.
- `20-opus-4-8-top-of-feed-tip.md` — top-of-feed setup tip surface already covered by the existing tip rotation.
- `24-1m-context-credits-required-hint.md` — "Extra usage is required for long context" hint with `/usage-credits` + `/model` dual remediation surfaced via Claudius's existing tier UX.
- `27-ultrathink-prose-deep-reasoning-reminder.md` — `ultrathink` prose keyword already bumps per-turn reasoning budget through Claudius's reasoning controls.
- `28-date-change-silent-reminder.md` — ambient `<system-reminder>` updating "today" mid-session covered by Claudius's date-context plumbing.
- `29-linter-modified-file-reminder.md` — linter-modified-file reminder is in place via the hook channel (see Parity revisit backlog below — re-evaluate with the new `additionalContext` evidence).
- `31-stale-todowrite-gentle-nudge.md` — low-pressure `todo_reminder` covered by Claudius's todo-tracking UI.
- `33-plan-mode-reentry-reminder.md` — persisted-plan re-entry reminder covered by Claudius's plan-mode session resume.
- `34-auto-mode-exit-reminder.md` — "Exited Auto Mode" reminder covered by Claudius's mode-toggle reducer.
- `35-mcp-agent-deferred-delta-reminders.md` — MCP/agent/deferred-tool delta reminders are shipped (see Parity revisit backlog below — re-evaluate with the new `additionalContext` evidence).
- `36-memory-update-staleness-reminder.md` — `memory_update` staleness reminder covered by Claudius's memory-write path.
- `38-agent-mention-routing-reminder.md` — composer `@agent-<name>` token is fully wired through `AtMentionPicker` + `at-mention.ts`; the reminder injection itself is owned by the SDK.
- `77-agent-name-mention-registry.md` — name→AgentId map for `@<name>` routing is mirrored by Claudius's agent-mention registry.
- `78-agent-spawned-shell-cleanup.md` — `killShellTasksForAgent`-equivalent cleanup of agent-spawned shells on agent exit already in place.
- `80-auto-dream-consolidation-runner.md` — `autoDreamEnabled`-equivalent background memory-consolidation runner is wired into Claudius's session lifecycle.
- `99-cron-scheduled-prompts.md` — `CronCreate` / `CronList` / `CronDelete` are first-class Claudius tools backed by `.claude/scheduled_tasks.json` (durable) or the in-session scheduler.

## UNVERIFIED (leak source only — could not confirm in binary)

These features were observed in `claude-code-leak-main/` but not in the current binary; may have been removed, internalised, or gated behind a flag.

- `82-background-plugin-autoupdate.md` — background marketplace auto-update with restart-notification queue (`pendingNotification` race buffer); leak-only in `utils/plugins/pluginAutoupdate.ts`.
- `101-diff-in-ide-tab-flow.md` — `useDiffInIDE.ts` open/save/reject tab flow with `✻ [Claude Code] basename.ext (sha) ⧉` title; leak file name surfaces but the title template and close-on-abort semantics are not in stripped strings.
- `112-high-memory-warning-banner.md` — `HIGH_MEMORY_THRESHOLD = 1.5GB` / `CRITICAL_MEMORY_THRESHOLD = 2.5GB` polling banner from `hooks/useMemoryUsage.ts`; leak-only.
- `133-output-style-deprecated-stub.md` — `/output-style` deprecation stub redirecting to `/config`; binary_grep_count: 0, so leak-only and could not confirm in stripped output.

## NOT_APPLICABLE (out of scope for Claudius's surface)

Features intentionally not pursued because they belong to a TUI-only or claude.ai-bridge surface Claudius does not host.

- `85-bridge-environment-resume.md` — `claude remote-control --session-id <id>` reusing a backend bridge environment via `reuseEnvironmentId` (backend-format IDs only).
- `86-bridge-mobile-push-notifications.md` — Notify tool fan-out to the claude.ai mobile app when a Remote Control bridge is connected.
- `87-bridge-multi-session-capacity-meter.md` — bridge `Capacity: N/M` line with OSC-8-hyperlinked per-session URLs and live tool-activity hints.
- `88-bridge-outbound-only-mirror-mode.md` — bridge outbound-only mode that rejects inbound `SendMessage` with "This session is outbound-only" and gates peer calls behind explicit approval.
- `89-bridge-qr-code-toggle.md` — spacebar toggle that prints a UTF-8 block-character QR of the bridge connect URL above the status line.
- `91-bridge-spawn-mode-toggle.md` — bridge spawn-mode toggle (`single-session` / `worktree` / `same-dir`) with runtime `w` hot-rotation between worktree and same-dir.
- `93-bridge-web-requires-action-indicator.md` — `CCRClient.reportState('requires_action')` setting the claude.ai-web per-session "waiting for input" indicator while a permission prompt is pending.
- `130-org-policy-disable-plugins.md` — managed `policySettings` `enabledPlugins[id] = false` force-disabling plugins/marketplaces at install/enable/UI-filter chokepoints.
- `131-org-policy-disable-remote-control.md` — managed `disableRemoteControl` policy killing every Remote Control entry point with "Remote Control is disabled by your organization's policy".

## Parity revisit backlog

### Open

- **`32-stale-task-tools-teammate-nudge.md` (SKIPPED)** and **`09-team-artifacts-priority-tip.md` (SKIPPED)** — team-mode evidence exists in `claude-code-leak-main/src/state/teammateViewHelpers.ts` and `tasks/InProcessTeammateTask/`. Re-implementation requires Claudius to first grow a team-mode surface (the `in_process_teammate` task type, per-teammate `AsyncLocalStorage` isolation, `agentName@teamName` identity). Tracked as a feature-area gap, not a one-commit revisit.

### Investigated and closed (no action)

- **`29-linter-modified-file-reminder.md`** and **`35-mcp-agent-deferred-delta-reminders.md`** — both `ALREADY_EXISTS` on the next-turn drain, which matches the CLI binary spec strings ("the next turn carries an ambient system-reminder…"). The mid-turn channel built on this branch (`queueMidTurnReminder` → PreToolUse `additionalContext`) is **available but unnecessary** — moving to mid-turn would be beyond-parity polish, not parity. For feature 35 specifically, mid-turn would never naturally fire (MCP changes are user-driven between turns, not within them).
- **`40-truncated-file-followup-reminder.md` (SKIPPED)** — the SDK produces this reminder internally for its own Read tool path; Claudius does not intercept Read output, so there is no shim point. The mid-turn channel does not change this.

### Channel infrastructure

The mid-turn `<system-reminder>` injection channel landed as future-proofing groundwork on `parity/backlog-revisit` — `lib/server/system-reminders.ts` exports `queueMidTurnReminder` / `takeMidTurnReminders`, drained inside the existing PreToolUse hook in `Session.start()` via `hookSpecificOutput.additionalContext` (SDK 0.3.160). New features that genuinely need to react to a tool result before the agent's next action — e.g. **#83** background-shell stall watchdog, **#97** clipboard-image hint mid-turn, **#128** monitor-vs-bash summaries with `priority: "next"` — can ride on it directly.

### Compaction survival

`criticalSystemReminder_EXPERIMENTAL` is an **agent-definition** field (`sdk.d.ts:63` — set on `AgentDefinition`, not a per-reminder property), so the original "wrap their reminder bodies with this pattern" plan was misread. The 28/31-37/39 reminder cluster will silently disappear after a `/compact`. Two viable routes if we need compaction-surviving variants: (a) a dedicated Claudius agent with `criticalSystemReminder_EXPERIMENTAL` set on its frontmatter, or (b) re-injection on the SDK's `PostCompact` hook event (not currently consumed at the Claudius hook site).
