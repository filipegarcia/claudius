# Skill frontmatter — effort override

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `effort` frontmatter overrides the reasoning-effort level (low/medium/high/xhigh/max) for the duration of the skill.

## Claudius today
Not surfaced on the Skills page (`app/[workspaceId]/skills/page.tsx`), which only special-cases `description` and `allowed-tools`. An `effort:` line in SKILL.md is preserved and parsed but invisible in the UI. The Agents page already badges `effort` (`metaBadges.push(\`effort ${fm.effort}\`)`), so the convention exists for the sibling surface.

## Decision
ALREADY_EXISTS. An `effort:` line is already authorable and persisted via the SKILL.md editor on `app/[workspaceId]/skills/page.tsx` (parsed by `lib/server/skills.ts`) — the editor is the working browser surface; no capability is missing. Optional polish (not a new surface): add an `effort` badge to the Skills list row, matching the Agents page badge.
