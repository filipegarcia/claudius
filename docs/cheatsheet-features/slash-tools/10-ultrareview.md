# /ultrareview

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/ultrareview` runs a cloud-based, parallel multi-agent code review (deeper and
broader than `/review`) and reports the consolidated findings.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "sdk"` (category
`skill`, argsHint `[PR]`, "Deep multi-agent code review"). Like `/review`, the
`sdk` handler in `app/[workspaceId]/page.tsx` forwards it verbatim to the SDK via
the `asSlashCommand` no-echo path; the cloud multi-agent run streams progress
and findings back into the chat. Any spawned subagents appear as tasks in the
Background Tasks panel (`components/panels/BackgroundTasksPanel.tsx`).

## Decision
ALREADY_EXISTS. `/ultrareview` works today through the SDK forward path
(`cmd?.handler === "sdk"` branch in `app/[workspaceId]/page.tsx`). The cloud
review is orchestrated by the SDK/hosted service and streams into the existing
chat + background-tasks surfaces; there is no separate browser UI to build. No
new surface needed.
