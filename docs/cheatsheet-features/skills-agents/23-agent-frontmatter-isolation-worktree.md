# Agent frontmatter — isolation: worktree

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
An agent's `isolation: worktree` frontmatter runs the subagent inside a dedicated git worktree so its edits are isolated from the main tree.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) does NOT special-case `isolation` — the new-agent `TEMPLATE` and the list-row meta badges cover `effort`, `background`, `memory`, `maxTurns`, `permissionMode`, `skills`, and `mcpServers`, but not `isolation`. The field round-trips through the textarea and is parsed by `lib/server/agents.ts`, but it's invisible in the list. Worktrees themselves are surfaced elsewhere: `components/overlays/WorktreesOverlay.tsx` + `app/api/worktrees/route.ts` (`lib/server/worktrees.ts`) list/open worktrees, and the chat StatusLine paints a "worktree" badge when a session's cwd moves into one (`lib/client/worktree.ts`).

## Decision
ALREADY_EXISTS. An `isolation: worktree` line is already authorable and persisted via the agent editor on `app/[workspaceId]/agents/page.tsx` (parsed by `lib/server/agents.ts`), and the worktree runtime is already surfaced — `components/overlays/WorktreesOverlay.tsx` (+ `app/api/worktrees/route.ts`) lists/opens worktrees and the chat StatusLine shows a "worktree" badge when a session moves into one (`lib/client/worktree.ts`). Both authoring and runtime browser surfaces exist. Optional polish (not a new surface): an `isolation` meta badge on the agent list row.
