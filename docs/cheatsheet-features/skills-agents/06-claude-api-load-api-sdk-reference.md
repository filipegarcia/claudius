# /claude-api — load API/SDK reference

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill that loads the Claude API / Anthropic SDK reference and helps build, debug, optimize, and migrate Claude API code.

## Claudius today
`/claude-api` is a registered slash command (`lib/shared/slash-commands.ts`, `id: "claude-api"`, category `skill`, `handler: "sdk"`, "Claude API reference / migration helper."). The picker forwards it to the SDK to run the installed skill.

## Decision
ALREADY_EXISTS. Surfaced via the `claude-api` registry entry in `lib/shared/slash-commands.ts`, invokable from `components/chat/SlashCommandPicker.tsx`. The reference-loading behavior is internal to the skill; no additional browser UI is needed.
