# /add-dir

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/add-dir <path>` adds an additional working directory the agent is allowed to
access beyond the session's root cwd.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`info`, argsHint `<path>`). The native dispatcher in `app/[workspaceId]/page.tsx`
(`case "add-dir"`) takes the path argument and POSTs to
`app/api/settings/additional-dirs/route.ts` with
`{ scope: "project", cwd, add: [dir] }`, persisting into the settings file's
`permissions.additionalDirectories` (toasts "restart session to apply"). The
same field is also editable as a multi-line "Additional directories" input in
the workspace defaults form (`components/workspaces/WorkspaceForm.tsx`, the
`defaultAddlDirs` state → `defaults.additionalDirectories`), and consumed at
session start via `lib/shared/session-defaults.ts` / `lib/server/session.ts`.

## Decision
ALREADY_EXISTS. Covered by the `/add-dir` native command wired to
`app/api/settings/additional-dirs`, plus the additional-directories field in the
Workspace form. No new surface needed.
