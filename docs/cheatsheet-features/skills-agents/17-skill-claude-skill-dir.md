# Skill — ${CLAUDE_SKILL_DIR}

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** NOT_APPLICABLE

## What it is
`${CLAUDE_SKILL_DIR}` is a variable available inside a SKILL.md body that expands to the skill's own directory (used to reference bundled scripts/data via absolute paths).

## Claudius today
Pure skill-body authoring syntax. The body is editable in the Skills editor (`app/[workspaceId]/skills/page.tsx`); the variable is expanded by the SDK at runtime. Claudius does not (and should not) interpolate skill bodies.

## Decision
NOT_APPLICABLE. An SDK-expanded environment variable with no UI value — the editor already lets authors write it, and substitution is runtime/SDK behavior. No browser surface warranted.
