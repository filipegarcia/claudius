# OAuth/MCP/state (~/.claude.json)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** NOT_APPLICABLE

## What it is
`~/.claude.json` is Claude Code's global state file: OAuth account info, MCP
approval state, onboarding flags, project history and other internal bookkeeping
that the CLI manages for itself. It is not a hand-edited config file.

## Claudius today
There is no editor for `~/.claude.json`, by design. The pieces of it that matter
to a user are surfaced through purpose-built reads instead: `/api/doctor`
inspects auth (`ANTHROPIC_API_KEY` / `~/.claude/.credentials.json` / Bedrock /
Vertex), `app/api/account/route.ts` surfaces login state, and MCP approval lives
on the `/mcp` page and in `lib/server/mcp.ts`.

## Decision
NOT_APPLICABLE. This is internal global state (OAuth tokens, approval/onboarding
bookkeeping) that the CLI owns. Exposing a raw JSON editor for it would be risky
(token corruption) and low value; the user-relevant slices already have their own
read-only or scoped surfaces (Doctor auth check, account state, MCP page).
