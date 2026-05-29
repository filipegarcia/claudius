# Skill frontmatter — context: fork

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `context: fork` frontmatter runs the skill in a forked subagent context (isolated from the main conversation's context window) instead of inline.

## Claudius today
Not surfaced on the Skills page (`app/[workspaceId]/skills/page.tsx`). A `context: fork` line in SKILL.md is preserved and parsed but has no badge or template hint. When such a skill actually runs forked, its work shows up through the existing subagent/Task rendering (`components/chat/TaskBlock.tsx`) — so the runtime behavior is already visualized; only the authoring-time indicator is missing.

## Decision
ALREADY_EXISTS. A `context: fork` line is already authorable and persisted via the SKILL.md editor on `app/[workspaceId]/skills/page.tsx` (parsed by `lib/server/skills.ts`), and the forked-run behavior already renders at runtime through `components/chat/TaskBlock.tsx` — both the authoring and runtime browser surfaces exist. Optional polish (not a new surface): a "forked" badge on the list row to flag isolated skills at a glance.
