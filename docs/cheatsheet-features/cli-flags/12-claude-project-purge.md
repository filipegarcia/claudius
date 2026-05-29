# claude project purge [path]

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** UI_WORTHY

## What it is
`claude project purge [path]` deletes the stored project state for a path — the `~/.claude/projects/<sanitized-cwd>/` data: session transcripts, todos, memory, and other per-project artifacts.

## Claudius today
The workspace page (`app/[workspaceId]/workspace/page.tsx`) has a "Delete workspace" action, but it explicitly only forgets the workspace entry — "Sessions and files on disk are unaffected." There is no surface that purges the on-disk project state (transcripts, memory, project DB) the way `claude project purge` does.

## Decision
UI_WORTHY. Add a destructive "Purge project state" action — most naturally a danger-zone section on the workspace page (`app/[workspaceId]/workspace/page.tsx`) — that deletes the `~/.claude/projects/<sanitized-cwd>/` data and the per-project `.claudius.db`, behind a typed confirmation. Backend: a new `DELETE /api/workspaces/[id]/purge` (or similar) route in `lib/server/` to remove the project directory and DB safely (refuse while sessions are live). Effort: medium — the UI is a confirm dialog, but the server side must enumerate and delete the right paths without touching the repo working tree. Priority: med (real cleanup value, but destructive and infrequent).
