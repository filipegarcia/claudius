# Skill frontmatter — disallowed-tools

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `disallowed-tools` frontmatter blocks specific tools from being used while the skill is active — the inverse of `allowed-tools`.

## Claudius today
The Skills page (`app/[workspaceId]/skills/page.tsx`) only special-cases `description` and `allowed-tools` (chips + search index + template). `disallowed-tools` is preserved when typed into the SKILL.md textarea and `parseFrontmatter` reads it, but there is no chip, search coverage, or template hint for it — so it's invisible in the list view.

## Decision
ALREADY_EXISTS. The field is already authorable and persisted via the SKILL.md editor on `app/[workspaceId]/skills/page.tsx` (parsed by `lib/server/skills.ts`) — the editor is the working browser surface, no capability is missing. Optional polish (not a new surface): render `disallowed-tools` as red-tinted chips beside the `allowed-tools` chips and add a commented template hint, mirroring how the Agents page badges `disallowedTools`.
