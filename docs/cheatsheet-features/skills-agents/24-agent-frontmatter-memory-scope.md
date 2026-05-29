# Agent frontmatter — memory scope

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
An agent's `memory` frontmatter (user | project | local) auto-loads the matching memory scope into the subagent's context.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) special-cases `memory`: the new-agent `TEMPLATE` documents it (`# memory: project # user | project | local — auto-load agent memory`), and the list view renders it as a meta badge (`if (fm.memory) metaBadges.push(\`mem:${fm.memory}\`)`). The frontmatter is editable in the textarea and parsed by `lib/server/agents.ts`.

## Decision
ALREADY_EXISTS. Surfaced as a `mem:<scope>` badge and seeded in the template on `app/[workspaceId]/agents/page.tsx`; parsed by `lib/server/agents.ts`.
