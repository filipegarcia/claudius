# Skill — dynamic context injection (!`cmd`)

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** NOT_APPLICABLE

## What it is
Inside a SKILL.md body, the `` !`cmd` `` syntax runs a shell command and injects its stdout into the skill's context at load time.

## Claudius today
Skill-body authoring syntax. The body is editable in the Skills editor (`app/[workspaceId]/skills/page.tsx`); the command execution and output injection are performed by the SDK when the skill loads. Claudius never evaluates skill bodies itself.

## Decision
NOT_APPLICABLE. An SDK-side templating/execution mechanism, not a browser feature. The editor already lets authors write it; running it client-side would be both out of scope and a sandbox/security non-starter. No UI surface to add.
