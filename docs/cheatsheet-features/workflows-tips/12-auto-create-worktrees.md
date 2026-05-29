# Auto-create worktrees (/batch)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** UI_WORTHY

## What it is
The `/batch` skill can auto-create worktrees so large-scale, parallel changes each get their own isolated checkout/branch without manual `git worktree add`.

## Claudius today
`/batch` is registered as an SDK-forwarded skill in `lib/shared/slash-commands.ts`, so invoking it from the composer already works. But the *worktree-creation* surface is read-only: `app/api/worktrees/route.ts` exposes only `GET` (listing) and `WorktreesOverlay.tsx` tells users to "Create one with `git worktree add ...`" — there is no UI button or POST endpoint to create a worktree.

## Decision
UI_WORTHY but **deferred — needs backend**. A "New worktree" action in `WorktreesOverlay.tsx` (path/branch inputs, optional sparsePaths) is the natural surface, but it needs a new `POST /api/worktrees` route plus a `createWorktree` helper in `lib/server/worktrees.ts` — the current API is GET-only. The skill-driven `/batch` path already works via the composer; the gap is the explicit "create" UI/endpoint. Priority low.
