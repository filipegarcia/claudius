# Skill frontmatter — model override

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `model` frontmatter overrides the model used while the skill runs (e.g. force a Haiku/Sonnet/Opus tier for that skill).

## Claudius today
The Skills page (`app/[workspaceId]/skills/page.tsx`) does not surface `model` — only `description` and `allowed-tools` get first-class treatment. A `model:` line typed into SKILL.md is persisted and parsed (`parseFrontmatter` in `lib/server/skills.ts`) but never shown as a badge or seeded in the template. Note: the Agents page (`app/[workspaceId]/agents/page.tsx`) DOES surface per-agent `model`, so the pattern already exists for the sibling surface.

## Decision
ALREADY_EXISTS. A `model:` line is already authorable and persisted via the SKILL.md editor on `app/[workspaceId]/skills/page.tsx` (parsed by `lib/server/skills.ts`) — the editor is the working browser surface; no capability is missing. Optional polish (not a new surface): render a `model` badge in the list row, mirroring the Agents page's existing `fm.model` badge.
