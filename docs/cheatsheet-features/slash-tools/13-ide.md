# /ide

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** NOT_APPLICABLE

## What it is
`/ide` shows and manages IDE integrations — the connection between the Claude
Code CLI and an editor (VS Code, JetBrains) for in-editor diffs, selection
context, and lockfile-based attach.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "external"` (category
`integrations`, "Manage IDE integrations"). In `app/[workspaceId]/page.tsx`,
`external`-handler commands fall into the `cmd?.handler === "external"` branch
which just shows a toast: "/ide is terminal/hosted only." There is no API group
or page for IDE attach.

## Decision
NOT_APPLICABLE. IDE integration is a property of the terminal CLI attaching to a
local editor process (extension + lockfile handshake). Claudius *is* the
browser front-end — there is no terminal session to pair with an IDE, and the
in-editor diff/selection features it brokers are already provided natively by
Claudius's own Files/Git pages and chat. Correctly classified as `external`
(awareness-only); no meaningful browser surface to build.
