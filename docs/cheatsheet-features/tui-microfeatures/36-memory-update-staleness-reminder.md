# Memory-update staleness reminder

**Source:** Claude Code TUI — system reminder injection
**Status:** ALREADY_EXISTS

## What it is
When the background auto-memory writer or `/memory` updates files mid-conversation, the TUI fires a `memory_update` reminder summarizing what changed and explicitly flagging that any in-context copies are now stale. The binary handler reads: `case "memory_update":{let K=[`${ig3[H.source]} updated your memory directory: ${H.summary}`];if(H.paths.length>0)K.push(`Files changed: ${H.paths.join(", ")}`);if(H.inContextPaths.length>0)K.push(`Your loaded copy of ${H.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`);` — it names the source, lists changed files, and tells the model to re-Read any loaded copies.

## Claudius today
`lib/server/session.ts` exports `memoryUpdateReminderBody(updates, inContextPaths)` (line ~486) which rebuilds the parity reminder with the same three-line shape — `"updated your memory directory: <summary>."`, `"Files changed: ..."`, and the conditional `"Your loaded copy of ... is now stale relative to disk — Read it again if you need current contents."` gated on a non-empty `inContextPaths` intersection, exactly as the CLI's `if(H.inContextPaths.length>0)` clause does. It's emitted from the in-flight session (call site at session.ts line ~2947) and tagged as `"memory-update"` in the `SystemReminderKind` union in `lib/server/system-reminders.ts`. Claudius's single write path (`/api/memory/auto`, driven by the browser UI) means `source` is always "The user" rather than the CLI's background-writer enum — the JSDoc spells out why. Pinned by `tests/unit/memory-update-reminder.test.ts`.

## Decision
ALREADY_EXISTS. The reminder is implemented as a first-class `SystemReminderKind`, with the parity-cited helper, call site, and unit tests; the staleness clause uses the same in-context-path intersection gate the CLI does. The earlier "MISSING" verdict in this file was stale — the parity comment in `session.ts` cites this micro-feature by number ("36-memory-update-staleness-reminder").
