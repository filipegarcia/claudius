# Status line worktree path (workspace.git_worktree)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
The status line can display the active git worktree path (the `workspace.git_worktree` JSON field), so you always know which checkout the agent is operating in.

## Claudius today
`components/chat/StatusLine.tsx` computes `worktreeBadge(agentCwd, sessionRoot)` (from `lib/client/worktree.ts`) and renders a `data-testid="status-line-worktree"` badge whenever the agent's cwd differs from the session root. The tooltip shows the full worktree path and warns that edits there won't appear in the main tree. `lib/server/session.ts` derives the agent cwd from the SDK's `cwd_changed` event and a `worktreeRootFromPath` fallback heuristic.

## Decision
Already covered. The status-line worktree badge in `components/chat/StatusLine.tsx` is exactly this feature — it surfaces the active worktree path. No new UI needed.
