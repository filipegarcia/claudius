# Agent frontmatter — maxTurns

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
An agent's `maxTurns` frontmatter caps the number of agentic round-trips the subagent may take before it stops.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) special-cases `maxTurns`: the new-agent `TEMPLATE` documents it (`# maxTurns: 20 # cap agentic round-trips before stopping`) and the list renders a meta badge (`if (typeof fm.maxTurns === "number") metaBadges.push(\`≤${fm.maxTurns} turns\`)`). The frontmatter is editable in the textarea and parsed by `lib/server/agents.ts`.

## Decision
ALREADY_EXISTS. Surfaced as a "≤N turns" badge and seeded in the template on `app/[workspaceId]/agents/page.tsx`; parsed by `lib/server/agents.ts`.
