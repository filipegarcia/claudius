# /batch — large parallel changes across worktrees

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill for large-scale, parallel changes across the codebase (the cheat sheet frames it as fanning work across worktrees).

## Claudius today
`/batch` is a registered slash command in `lib/shared/slash-commands.ts` (`id: "batch"`, category `skill`, `handler: "sdk"`, argsHint `<instruction>`). The picker forwards it to the SDK, which executes the installed skill. The skill's own worktree fan-out is internal SDK behavior; the browser surface is the command entry and its argument hint.

## Decision
ALREADY_EXISTS. Surfaced via the `batch` registry entry in `lib/shared/slash-commands.ts`, invokable from `components/chat/SlashCommandPicker.tsx`. The parallel-worktree mechanics live inside the skill on the SDK side; Claudius correctly exposes the command without manufacturing redundant UI.
