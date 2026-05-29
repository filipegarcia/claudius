# --allowedTools / --disallowedTools

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--allowedTools` pre-approves tools (skip prompts for them) and `--disallowedTools` removes tools entirely for the session.

## Claudius today
The permissions page (`app/[workspaceId]/permissions/page.tsx`) manages allow / ask / deny rules per scope (user / project / local) using the same matcher syntax (`Bash(npm run *)`, `Read(./src/**)`, `mcp__server__tool`, etc.), persisted to settings.json via `app/api/settings/permissions/route.ts`. Per-agent `disallowedTools` is also editable in the agents frontmatter (`app/[workspaceId]/agents/page.tsx`).

## Decision
Already covered. The allow/deny rule editor on the permissions page is the persistent, scoped equivalent of `--allowedTools`/`--disallowedTools`, and agents expose per-agent tool removal. No new UI needed.
