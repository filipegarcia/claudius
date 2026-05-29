# claude -p (headless SDK)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** NOT_APPLICABLE

## What it is
`claude -p "prompt"` runs Claude Code non-interactively: it prints the result and exits, intended for scripting and piping into the SDK / shell.

## Claudius today
Claudius is itself an interactive wrapper around the Agent SDK — it always runs a streaming, interactive session over SSE (`lib/server/session.ts`). There is no headless print-and-exit surface, and a browser UI for one would have no value.

## Decision
Not applicable. `-p` is a CLI/scripting affordance whose entire point is to avoid an interactive UI. Claudius's reason for existing is the opposite (a rich interactive surface), so there is no meaningful browser feature to add. Programmatic/headless use belongs to the SDK or CLI, not the web app.
