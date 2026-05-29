# Skill — ${CLAUDE_EFFORT}

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** NOT_APPLICABLE

## What it is
`${CLAUDE_EFFORT}` expands inside a SKILL.md body to the current effort level, letting a skill branch on how hard it should think.

## Claudius today
Skill-body authoring syntax expanded by the SDK at runtime. The body is editable in the Skills editor (`app/[workspaceId]/skills/page.tsx`). The effort level itself is already a first-class chat control (`app/api/sessions/[id]/effort/route.ts` and the model/effort picker), but the in-body variable is just a runtime substitution token.

## Decision
NOT_APPLICABLE. A pure env-var substitution token with no UI value of its own — the editor lets authors type it and the SDK expands it. (The effort *control* exists separately and is out of scope here.) No browser surface to add.
