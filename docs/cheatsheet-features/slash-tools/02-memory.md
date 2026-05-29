# /memory

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/memory` opens the CLAUDE.md editor across scopes and lets you toggle
auto-memory (the rolling MEMORY.md the agent maintains).

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`memory`) with the description "Edit CLAUDE.md, browse memory, toggle
auto-memory." The native dispatcher in `app/[workspaceId]/page.tsx`
(`case "memory": router.push("/memory")`) opens the dedicated Memory page at
`app/[workspaceId]/memory/page.tsx`. That page is a full editor: it loads
CLAUDE.md across `user`, `project`, `project-claude`, and `local` scopes via
`useClaudeMd`, exposes an auto-memory toggle via `useAutoMemory`, has a file
list with search, and Save. Backed by `app/api/claudemd` and `app/api/memory`.

## Decision
ALREADY_EXISTS. Fully covered by the `/memory` SideNav tile and route
`app/[workspaceId]/memory/page.tsx`, including the auto-memory toggle. No new
surface needed.
