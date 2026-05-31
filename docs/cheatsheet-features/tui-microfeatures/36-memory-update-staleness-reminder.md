# Memory-update staleness reminder

**Source:** Claude Code TUI — system reminder injection
**Status:** MISSING

## What it is
When the background auto-memory writer or `/memory` updates files mid-conversation, the TUI fires a `memory_update` reminder summarizing what changed and explicitly flagging that any in-context copies are now stale and should be re-read. The binary handler reads: `case "memory_update":{let K=[`${ig3[H.source]} updated your memory directory: ${H.summary}`];if(H.paths.length>0)K.push(`Files changed: ${H.paths.join(", ")}`);if(H.inContextPaths.length>0)K.push(`Your loaded copy of ${H.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`);` — i.e. it names the source, lists changed files, and tells the model to re-Read any loaded copies.

## Claudius today
Not surfaced in Claudius. The auto-memory write/patch/delete paths in `lib/server/auto-memory.ts` (and the `/api/memory/auto` route + `lib/client/useAutoMemory.ts` UI) mutate files on disk, but no SSE event or system-reminder is broadcast back into the live session to tell the in-flight agent its previously loaded MEMORY.md / topic files are stale. It would naturally live as a new `memory_update` server event in `lib/server/session.ts` (sibling of the existing reminder injection), tracked alongside the auto-memory write API and replayed to the agent the next turn.

## Decision
MISSING. The CRUD + browser UI are complete, but the mid-conversation staleness hint that Claude Code's TUI injects is not wired up — if the user or background writer edits a memory file while a session is running, the agent keeps using its cached copy with no nudge to re-Read. Worth adding as a session-scoped reminder emitted from the auto-memory write/patch/delete handlers if we want the agent to notice mid-stream edits.
