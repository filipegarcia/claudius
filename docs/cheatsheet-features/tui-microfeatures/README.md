# TUI micro-features survey

This directory catalogs small/obscure Claude Code TUI ergonomics that the broader cheatsheet didn't cover, gap-checked against Claudius. Each file is one feature, with its trigger, the verbatim TUI strings/identifiers where available, and what Claudius does today. Findings grounded in `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` binary strings and observed session behavior — files marked UNVERIFIED could not be confirmed and should be re-checked manually.

## MISSING (gaps to consider)

- `01-opus-plan-mode-reminder-tip.md` — conditional spinner tip for `opusplan` default-model users who haven't entered Plan Mode in 3+ days.
- `03-default-permission-mode-config-nudge.md` — `/config` nudge once the user has used Plan Mode but never persisted a default permission mode.
- `05-desktop-app-contextual-ui-tip.md` — contextual "Working on UI?" tip triggered by recent UI-file edits or dev-server bash tools.
- `06-powerup-onboarding-tip-new-users.md` — first-run `/powerup` interactive-tutorial nudge gated by `numStartups < 10`.
- `08-console-api-key-statsig-tip.md` — `/claude-api` Console-acquisition tip gated by login state, no primary API key, and Statsig flag.
- `09-team-artifacts-priority-tip.md` — top-priority async-content spinner tip that scans for shared team artifacts on session start.
- `10-opus-high-load-sonnet-nudge.md` — manual "Opus is experiencing high load, use /model to switch to Sonnet" nudge after repeated 529s.
- `17-fast-mode-disabled-reason-diagnostics.md` — six concrete "Fast mode disabled — <reason>" labels surfacing which lever to pull.
- `19-pin-model-versions-1m-probe.md` — `Pin model versions` menu with one-token probe and a `pin1m` variant for the 1M tier.
- `20-opus-4-8-top-of-feed-tip.md` — pinned top-of-feed "Opus 4.8 is here!" setup tip pointing at `/effort xhigh`.
- `21-model-deprecation-warning-notification.md` — high-priority `model-deprecation-warning` ambient banner for deprecated selected models.
- `22-kept-model-as-cancel-line.md` — system transcript line "Kept model as <X>" when the `/model` menu is cancelled without a change.
- `23-remote-set-model-rejected-notice.md` — "Remote session couldn't switch to <model>" banner when a remote/teleport host rejects a `/model` switch.
- `24-1m-context-credits-required-hint.md` — "Extra usage is required for long context" hint with dual `/usage-credits` + `/model` remediation.
- `27-ultrathink-prose-deep-reasoning-reminder.md` — per-turn reasoning-budget bump when the prompt contains the word `ultrathink`.
- `28-date-change-silent-reminder.md` — ambient `<system-reminder>` updating "today" mid-session when the calendar date rolls over.
- `29-linter-modified-file-reminder.md` — system reminder informing Claude that a formatter/linter modified a file it just wrote.
- `30-ide-selection-open-file-reminder.md` — hedged "user selected lines / opened file" reminders from the connected IDE plugin.
- `31-stale-todowrite-gentle-nudge.md` — low-pressure `todo_reminder` after N turns without TodoWrite, dumping current todos inline.
- `32-stale-task-tools-teammate-nudge.md` — team-mode counterpart `task_reminder` after N turns without TaskCreate/TaskUpdate.
- `33-plan-mode-reentry-reminder.md` — "## Re-entering Plan Mode" reminder pointing at a persisted plan file from a prior session.
- `34-auto-mode-exit-reminder.md` — "## Exited Auto Mode" system reminder injected when the user Shift+Tabs out of auto-accept.
- `35-mcp-agent-deferred-delta-reminders.md` — mid-session delta reminders when MCP servers, agent types, or deferred tools come online/offline.
- `36-memory-update-staleness-reminder.md` — `memory_update` reminder flagging that in-context copies of MEMORY files are stale after a mid-session write.
- `39-verify-plan-reminder.md` — `verify_plan_reminder` after plan completion telling Claude to verify inline (not via Task or sub-agent).
- `40-truncated-file-followup-reminder.md` — silent reminder when a Read or memory load was truncated, instructing Claude not to surface it.

## PARTIAL (Claudius covers some of it)

- `02-multi-claude-color-rename-nudge.md` — `/color` and `/rename` exist and SessionTabs label sessions, but the "2+ concurrent sessions" conditional spinner nudge is not wired.
- `04-prompt-queue-up-arrow-hint.md` — queueing and click-to-edit are richer than the TUI, but the throttled "Press up to edit queued messages" placeholder isn't there.
- `07-spinner-tips-override-settings.md` — Claudius has its own rotating spinner tips with dismissal weighting, but no `spinnerTipsEnabled`/`spinnerTipsOverride` settings and no per-tip `cooldownSessions`.
- `11-opus-4-high-demand-banner.md` — `fallbackModel` and `ModelPicker` exist, but the targeted "high demand for Opus 4 — use /model now" banner is not surfaced.
- `12-auto-model-fallback-transcript-line.md` — SDK fallback swap works, but the "Switched to X because Y is not available..." transcript line is missing (no `model_fallback` `SystemEntry` kind).
- `13-weekly-limit-now-using-fallback.md` — weekly-limit detection, labels, and countdown exist, but the "Now using <fallback>" takeover toast pairing the model change with the weekly-limit reason is missing.
- `14-approaching-limit-lever-hints.md` — "Approaching <limit>" warning and utilization % are covered, but the concrete `/model sonnet`, `/effort medium`, and `/usage-credits` remediation chips are not.
- `16-fast-mode-overloaded-resets-toast.md` — fast-mode state chip exists, but the differentiated overloaded-vs-quota reason, live reset countdown, and recovery toast are not surfaced.
- `18-draws-from-credits-model-suffix.md` — Fast-mode badge and 1M cost hint exist, but the explicit "Draws from usage credits" sublabel on toggle/rows/confirmation is missing.
- `25-ultraplan-prose-keyword-launcher.md` — `/ultraplan` slash command exists, but the prose-keyword detector that surfaces an "ultraplan-active" banner from bare prose is not wired.
- `26-workflow-keyword-pill-dismiss-restore.md` — the "Dynamic workflow requested for this turn" pill ships, but Alt+W chord, `ultraplan|ultrathink|ultrareview` triggers, restore state, telemetry, and `ctrl+s stash` hint are not.
- `37-midturn-message-inject-reminders.md` — mid-turn user input is queued and a one-shot goal reminder can be prepended, but the forceful "MUST address" wrapper, "this is automated, not an ack" framing, and coordinator/peer variants are missing.

## ALREADY_EXISTS (covered by current UI)

- `15-fast-mode-auto-cooldown-recovery.md` — SDK-driven `fastModeState` chip in `StatusLine.tsx` already reflects cooldown and auto-recovery transitions with no extra plumbing.
- `38-agent-mention-routing-reminder.md` — composer `@agent-<name>` token is fully wired through `AtMentionPicker` + `at-mention.ts`; the reminder injection itself is owned by the SDK.

## UNVERIFIED (could not confirm in evidence sources)

- (none — every feature in this directory was grounded against the Claude Code SDK binary and/or the live Claudius codebase before being filed.)
