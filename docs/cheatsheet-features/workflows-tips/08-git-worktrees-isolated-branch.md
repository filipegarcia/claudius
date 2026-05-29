# Git worktrees — isolated branch (--worktree)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Run a session in a dedicated git worktree (`--worktree`) so the agent works on an isolated checkout of a branch and its edits don't collide with your main working tree.

## Claudius today
`components/overlays/WorktreesOverlay.tsx` lists the repo's worktrees (via `app/api/worktrees/route.ts` -> `lib/server/worktrees.ts`) and lets you open a fresh chat session in any worktree path. The `/worktrees` slash command is registered in `lib/shared/slash-commands.ts`. When the agent moves into a worktree, `components/chat/StatusLine.tsx` paints a "worktree" badge (see feature 11). The SDK also exposes `EnterWorktree`/`ExitWorktree` harness tools.

## Decision
Already covered for the core "work in an isolated worktree" flow: `WorktreesOverlay` opens sessions in existing worktrees and the status line surfaces when an agent is in one. (Note: *creating* new worktrees from the UI is a separate gap — see feature 12.)
