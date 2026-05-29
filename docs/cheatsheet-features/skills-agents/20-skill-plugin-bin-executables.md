# Skill — plugin bin/ executables

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** NOT_APPLICABLE

## What it is
A plugin can ship executables in a `bin/` directory that get put on PATH so a skill's Bash tool calls can invoke them.

## Claudius today
This is a plugin packaging + runtime-PATH concern handled entirely by the SDK/plugin loader. Claudius has a Plugins page (`app/plugins/page.tsx`) for installing/managing plugins, but the `bin/` executables are filesystem assets the SDK wires onto PATH — there is no per-executable browser concept to render. Skill bodies (which would call these binaries) are editable in `app/[workspaceId]/skills/page.tsx`.

## Decision
NOT_APPLICABLE. Plugin packaging/PATH wiring is SDK/CLI-internal; the executables are not a UI-addressable entity. Plugin install/management already lives at `app/plugins/page.tsx`; nothing meaningful to add for the `bin/` shipping mechanism specifically.
