# CLAUDE_CODE_FORK_SUBAGENT=1

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Enables forked subagents on external/non-internal builds — an internal/advanced runtime gate for how subagents are spawned.

## Claudius today
Subagents are already surfaced richly: `lib/server/session.ts` sets `forwardSubagentText: true` and `agentProgressSummaries: true` (lines 731-739) so the `TaskBlock` renders the nested subagent transcript and live progress, and the BackgroundTasksPanel shows running subagents. But the fork *mechanism* gate itself is an internal build flag with no user-facing behavior to configure.

## Decision
NOT_APPLICABLE. This is an internal runtime/build gate for subagent forking, not a user-facing setting. The valuable, observable part (subagent transcripts + progress) already ships and is on by default; the flag has no browser surface worth adding. It remains reachable, without value, through the generic Environment editor in Settings.
