# --add-dir

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--add-dir <path>` adds an extra working directory the agent is allowed to read/operate in, beyond the primary cwd.

## Claudius today
Additional directories are managed in the Settings "additional-dirs" surface (`app/api/settings/additional-dirs/route.ts`) and as a workspace default (`additionalDirectories` in `components/workspaces/WorkspaceForm.tsx`). The create-session route (`app/api/sessions/route.ts`) threads `additionalDirectories` into the session.

## Decision
Already covered. Add-dir exists both as a persistent settings/workspace-default surface and is applied per session at creation. No new UI needed.
