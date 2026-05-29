# Skill — $ARGUMENTS placeholder

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** NOT_APPLICABLE

## What it is
Inside a SKILL.md body, `$ARGUMENTS` is a placeholder that the SDK substitutes with whatever the user typed after the slash command.

## Claudius today
This is skill-authoring body syntax. The SKILL.md body is fully editable in the Skills editor textarea (`app/[workspaceId]/skills/page.tsx`), so authors can already write `$ARGUMENTS`. Expansion happens inside the SDK at invocation time; Claudius just persists the file and forwards the slash command (with arguments) via the picker.

## Decision
NOT_APPLICABLE. It's a template token interpreted by the SDK, not a UI feature. The editor already lets authors type it, and the slash-command picker already passes user arguments through to the SDK (`handler: "sdk"` in `lib/shared/slash-commands.ts`). No distinct browser surface to add.
