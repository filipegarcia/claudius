# Reverse search history (Ctrl+R)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Ctrl+R is the readline incremental reverse search through prompt history — type a
fragment and it surfaces the most recent matching past prompt.

## Claudius today
The composer implements shell-style history recall: Cmd/Ctrl+↑ walks back through
previously sent prompts and Cmd/Ctrl+↓ walks forward, restoring the live draft past
the newest entry (`recallHistory` in `components/chat/PromptInput.tsx`, fed by
`promptHistory` computed in `app/[workspaceId]/page.tsx`). For matching the
transcript content there is also full-text transcript search (Cmd+F →
`TranscriptSearch`).

## Decision
ALREADY_EXISTS. Prompt-history recall is present via Cmd/Ctrl+↑/↓ in
`components/chat/PromptInput.tsx`, and transcript search via Cmd+F. The recall is
*sequential*, not fuzzy-incremental like Ctrl+R; that distinction isn't worth a
dedicated searchable-history picker given the small per-session history and the
existing transcript search.
