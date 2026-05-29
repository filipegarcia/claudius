# Skill frontmatter — paths (YAML list)

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `paths` frontmatter (a YAML list of globs/paths) scopes the skill so it only auto-activates when work touches matching files.

## Claudius today
Not surfaced on the Skills page (`app/[workspaceId]/skills/page.tsx`). Only `description` and `allowed-tools` are special-cased. A `paths:` list typed into SKILL.md is preserved and parsed by `parseFrontmatter` (`lib/server/skills.ts`) but has no badge, search coverage, or template hint.

## Decision
ALREADY_EXISTS. A `paths:` list is already authorable and persisted via the SKILL.md editor on `app/[workspaceId]/skills/page.tsx` (parsed by `lib/server/skills.ts`) — the editor is the working browser surface; no capability is missing. Optional polish (not a new surface): render the `paths` list as compact mono chips on the list row so a path-scoped skill is visible at a glance.
