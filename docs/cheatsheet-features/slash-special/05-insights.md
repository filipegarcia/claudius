# /insights

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/insights` asks Claude to analyze the user's sessions and generate a report on
usage patterns / workflow insights.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "insights"`, category `info`,
`handler: "sdk"`). The slash dispatcher in `app/[workspaceId]/page.tsx`
(`cmd?.handler === "sdk"` branch in `handleSend`) forwards it to the agent via the
no-echo `asSlashCommand` send path, and the SDK produces the report as a normal
assistant turn rendered inline in the chat. It also appears in the `/help` picker
(`HelpOverlay`) and the slash autocomplete.

## Decision
ALREADY_EXISTS. `/insights` is an SDK-interpreted, agent-generated report: the
browser correctly forwards it through the existing slash send path and renders the
result inline, and exposes it in the command picker. A dedicated analytics page is
not warranted here — the report is produced by the agent on demand, not from a
local data store Claudius owns. (Note: Claudius separately has real local cost /
usage surfaces at `/cost` and `/usage`; `/insights` is the agent's narrative
analysis, which the SDK path already covers.)
