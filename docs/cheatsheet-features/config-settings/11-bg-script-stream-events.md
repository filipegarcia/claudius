# Stream events from bg scripts (Monitor tool)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** NOT_APPLICABLE

## What it is
The Monitor tool lets the agent subscribe to a live event stream emitted by a
long-running background script (rather than re-polling its output). It is agent
tooling, not a settings/config key.

## Claudius today
No live event-stream viewer. Claudius does surface background work: the
BackgroundTasksPanel + `BackgroundBashes` widget list running background shells,
and `BashViewer` shows their output — but that output is *captured from the
agent's most recent BashOutput poll*, not a pushed live stream (see the comment
in `components/panels/BashViewer.tsx`). There is no client subscription to a
Monitor-style event stream.

## Decision
NOT_APPLICABLE (deferred — needs backend). This is agent tooling whose value is
inside the model's loop, not a browser config surface. A real live-tail viewer
would require SSE plumbing from the SDK's Monitor stream through `lib/server/
session.ts` into `lib/client/use-session.ts` — deep backend work well beyond a UI
shell — and the existing polled BashViewer already covers the everyday "what is
this background script doing" need. Not a config-section UI.
