# CLAUDE_CODE_DISABLE_1M_CONTEXT

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Disables the 1M-token context window beta even where it would otherwise be available.

## Claudius today
1M context is opt-IN in Claudius, off by default. `components/workspaces/WorkspaceForm.tsx` has a "1M context window" checkbox (line 486, `enable1mContext`, default false, with a note that it raises cost and is Sonnet-only), and `lib/server/session.ts` only adds `betas: ["context-1m-2025-08-07"]` when the toggle is on (line 690). Leaving the box unchecked is exactly the "disable 1M context" state this env var forces.

## Decision
ALREADY_EXISTS. Because Claudius defaults 1M context off and gates it behind an explicit workspace toggle (`components/workspaces/WorkspaceForm.tsx` → `lib/server/session.ts`), the user is already in full control of whether the 1M beta is sent. The disable-env-var is redundant with the existing opt-in toggle; no new surface needed.
