# Skill frontmatter — allowed-tools

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `allowed-tools` frontmatter lists the tools the skill may use without a permission prompt.

## Claudius today
The Skills page (`app/[workspaceId]/skills/page.tsx`) parses `allowed-tools` and renders each tool as a chip beneath the skill (capped at 5 with a "+N" overflow), includes them in the search index, and the new-skill `TEMPLATE` seeds an `allowed-tools:` YAML list (Read/Grep/Glob/Bash). The full list is editable in the SKILL.md textarea.

## Decision
ALREADY_EXISTS. Visualized as tool chips and seeded in the template on `app/[workspaceId]/skills/page.tsx`; parsed by `lib/server/skills.ts`. First-class surface, not just raw text.
