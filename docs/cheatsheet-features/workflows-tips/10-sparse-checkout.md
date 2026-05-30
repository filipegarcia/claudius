# Sparse checkout (sparsePaths)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** IMPLEMENTED

**Implemented:** `app/settings/page.tsx` now renders a "Worktree" settings section with comma-separated `sparsePaths` and `symlinkDirectories` editors (wired through `lib/server/settings.ts`'s typed `worktree` field), persisted via the existing settings read/write routes.

## What it is
When creating worktrees, `sparsePaths` limits the checkout (via git sparse-checkout cone mode) to only the listed directories — dramatically faster in large monorepos because only those paths are written to disk.

## Claudius today
There is no `sparsePaths` control anywhere in the UI. `app/settings/page.tsx` explicitly omits the nested `worktree` settings object (its comment notes "complex nested objects (worktree, attribution, hooks…) are omitted"). The SDK supports it: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` defines `worktree.sparsePaths?: string[]` and `worktree.symlinkedDirs`.

## Decision
UI_WORTHY (low). Add a worktree-settings section — most naturally a card in `app/settings/page.tsx` (or a panel on the worktrees overlay) — with a list editor for `sparsePaths` (and the sibling `symlinkedDirs`). Settings already persist arbitrary keys via the settings read/write routes, so this is a focused UI addition over existing persistence; the only work beyond the form is wiring the nested `worktree` object into the settings editor's allowlist. Priority low.
