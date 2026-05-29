# Restore cleared input (Ctrl+Y)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
Ctrl+Y is the readline "yank" — it pastes back text that was just killed (e.g. with
Ctrl+U), restoring a cleared input buffer.

## Claudius today
The composer is a native `<textarea>`; undo (Cmd/Ctrl+Z) is provided by the browser
and restores recent edits. Separately, the composer already persists a per-session
draft (`/api/sessions/[id]/prompt-draft` in `components/chat/PromptInput.tsx`) so
in-progress text survives tab switches, and shell-style history recall
(Cmd/Ctrl+↑/↓) brings back previously sent prompts.

## Decision
NOT_APPLICABLE. Kill-ring yank is a readline pairing with Ctrl+U and has no browser
meaning. Native undo plus the existing draft persistence and history recall already
cover "get my text back," so no new surface is warranted.
