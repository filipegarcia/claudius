# /simplify cleanup-only review with auto-apply

**Source:** Claude Code cheat sheet — Recent Changes
**Status:** ALREADY_EXISTS

## What it is
`/simplify` runs a cleanup-only code review (reuse / simplification /
efficiency / altitude — no bug hunting) and applies the fixes automatically.

## Claudius today
`/simplify` is a registered slash command in `lib/shared/slash-commands.ts`
(id `simplify`, category `skill`, handler `"sdk"`, argsHint `[focus]`,
"Review files, find issues, apply fixes."). Because it's a `"sdk"` handler, the
web app forwards it verbatim to the Claude Agent SDK, which runs the installed
`simplify` skill (the same skill listed in this repo's available skills). The
slash-command picker (`components/chat/SlashCommandPicker.tsx`, fed by
`PromptInput.tsx`) surfaces it with its description and `[focus]` arg hint, and
the resulting tool calls / edits stream into the transcript and the Activity
rail like any other agent work.

## Decision
ALREADY_EXISTS. The browser surface is the slash-command registry entry
(`lib/shared/slash-commands.ts`) plus the slash picker in the composer; `/simplify`
is forwarded to the SDK skill and its review + auto-applied edits render through
the normal chat/transcript path. No dedicated UI is needed — it behaves like the
other forwarded skill commands (`/review`, `/security-review`).
