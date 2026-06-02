# criticalSystemReminder_EXPERIMENTAL Agent Frontmatter

**Source:** Claude Code TUI — memory-system
**Status:** MISSING

## What it is
Per-agent frontmatter field carrying a short message that is re-injected as a `critical_system_reminder` attachment on every user turn — load-bearing instructions that should not get lost as the conversation grows. The shape is leaked in `tools/AgentTool/loadAgentsDir.ts`: `criticalSystemReminder_EXPERIMENTAL?: string // Short message re-injected at every user turn`, with the value plumbed through `Tool.ts`, `runAgent`, `loadAgentsDir`, and `attachments.ts` so each user turn re-attaches the reminder rather than relying on the model to remember it from the original system prompt.

## Claudius today
Not surfaced in Claudius. Agent frontmatter is parsed generically by `lib/server/agents.ts` (`parseFrontmatter`, line 122) so a `criticalSystemReminder_EXPERIMENTAL:` line would round-trip on disk and through the editor at `app/[workspaceId]/agents/page.tsx`, but nothing reads it: the SDK-managed main-thread agent (`Session.agent`, `lib/server/session.ts` line 811) applies the agent's system prompt once at start, and there is no per-turn re-attachment. The natural home would be `lib/server/system-reminders.ts` — its `takePendingReminders(host)` already drains a queue of one-shot `<system-reminder>` blocks alongside `takeGoalReminder()` at the inputQueue site, so a new persistent (non-draining) hook on the same site could re-emit the agent's `criticalSystemReminder_EXPERIMENTAL` on every user turn while the agent is active.

## Decision
MISSING. The leak in `tools/AgentTool/loadAgentsDir.ts` (`criticalSystemReminder_EXPERIMENTAL?: string // Short message re-injected at every user turn`) describes a per-turn attachment channel that Claudius does not implement — agent frontmatter is parsed but no field is re-injected each turn. Follow-up if we want parity: read `frontmatter.criticalSystemReminder_EXPERIMENTAL` from the active agent (resolved via `Session.agent` against `listAgents()` in `lib/server/agents.ts`) and, at the inputQueue site in `lib/server/session.ts` that already calls `takePendingReminders`, prepend a non-draining `<system-reminder>` wrapping the field — gated behind an `_EXPERIMENTAL` flag the same way the leaked name signals upstream.
