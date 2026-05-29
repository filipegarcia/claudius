# /debug — troubleshoot from debug log

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill that enables debug logging and troubleshoots from the resulting log output.

## Claudius today
`/debug` is a registered slash command in `lib/shared/slash-commands.ts` (`id: "debug"`, category `skill`, `handler: "sdk"`, "Enable debug logging and troubleshoot."). The picker forwards it to the SDK to run the installed skill.

## Decision
ALREADY_EXISTS. Surfaced via the `debug` registry entry in `lib/shared/slash-commands.ts`, invokable from `components/chat/SlashCommandPicker.tsx`. The troubleshooting logic is the skill's own; no extra browser UI is warranted.
