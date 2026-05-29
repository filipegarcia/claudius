# ANTHROPIC_BETAS

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Comma-separated list of beta feature headers to send on API requests (e.g. `context-1m-2025-08-07`).

## Claudius today
The one beta header that has user-facing value — the 1M context window — is a first-class toggle: `components/workspaces/WorkspaceForm.tsx` exposes a "1M context window" checkbox (line 486, `enable1mContext`), and `lib/server/session.ts` translates it into the SDK `betas: ["context-1m-2025-08-07"]` array (line 690). Arbitrary additional beta headers can be set via the Settings → Environment editor (`app/settings/page.tsx`) by writing `ANTHROPIC_BETAS` into the `env` block.

## Decision
ALREADY_EXISTS. The valuable beta (1M context) is a dedicated workspace toggle wired through `lib/server/session.ts`; any other beta header is reachable via the generic Environment editor. A raw multi-beta input would expose internal API plumbing with little user value, so no new named field is warranted.
