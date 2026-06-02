# Memory Age / Freshness Staleness Reminder

**Source:** Claude Code TUI — memory-system
**Status:** MISSING

## What it is
On load, each auto-memory's age is computed from its file mtime into a human-readable label (`today`, `yesterday`, `N days ago`); for any memory more than a day old, the loader emits a `<system-reminder>` caveat — `This memory is ${_} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.` (one binary hit, leaked from `memdir/memoryAge.ts`). The reminder rides next to the memory body so the model treats `file.ts:42` citations as hints rather than ground truth.

## Claudius today
Not surfaced in Claudius. The pieces are sitting there but unwired: `lib/server/auto-memory.ts` already stamps every entry with `modifiedMs: s.mtimeMs` (line 42) and exposes it through `MemoryFile`, `lib/client/useAutoMemory.ts` re-exports the same `modifiedMs` field to the UI, and `lib/server/system-reminders.ts` has a generic `queueReminder(host, kind, body)` channel with a ready `"memory-update"` `ReminderKind` (line 28). What does NOT exist is the age formatter (`today` / `yesterday` / `N days ago`) or any code path that emits a staleness caveat based on mtime — the only memory reminder today is `Session.notifyMemoryUpdate` in `lib/server/session.ts` (line 3179), which fires after a write/patch/delete through `/api/memory/auto`, not because a file aged past a threshold. Natural home would be a new `memoryAgeReminderBody(modifiedMs, now)` helper in `lib/server/auto-memory.ts` (matching `memoryUpdateReminderBody`'s shape at `lib/server/session.ts:533`) called from the memory-loader site so the caveat ships alongside the body the agent first sees.

## Decision
MISSING. The leaked string in `memdir/memoryAge.ts` describes a load-time, age-driven reminder, but Claudius's existing memory reminder (`memory-update`) is purely change-driven and the auto-memory loader at `lib/server/auto-memory.ts` reads `modifiedMs` only for the listing sort. Follow-up: add an `memoryAgeReminderBody` next to `memoryUpdateReminderBody` keyed off `Date.now() - modifiedMs`, surface the `today` / `yesterday` / `N days ago` label in `useAutoMemory` for the /memory list at the same time, and queue the caveat through `queueReminder(this, "memory-update", …)` (or a new `memory-stale` kind in `lib/server/system-reminders.ts`) when a memory body is first injected into a turn.
