# Skill frontmatter — description trigger

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill's `description` frontmatter field is the auto-invocation trigger: Claude reads it to decide when the skill applies.

## Claudius today
The Skills page (`app/[workspaceId]/skills/page.tsx`) renders `description` prominently — it's shown under each skill name in the list, included in the search index (name + description + tools), and the new-skill `TEMPLATE` seeds a `description:` line with guidance ("Be specific — Claude reads this to decide when to invoke it."). The full frontmatter is editable in the SKILL.md textarea, and `lib/server/skills.ts` parses it via `parseFrontmatter`.

## Decision
ALREADY_EXISTS. Surfaced and editable in `app/[workspaceId]/skills/page.tsx`; parsed by `lib/server/skills.ts`. The description is a first-class, visible field, not just raw text.
