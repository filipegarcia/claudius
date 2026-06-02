# findRelevantMemories — Sonnet-driven semantic recall

**Source:** Claude Code TUI — memory system
**Status:** MISSING

## What it is
A pre-turn recall pass that walks the memory directory, builds a manifest of each file's frontmatter (`description`, `type`, mtime), and asks a Sonnet sideQuery to return up to five filenames most likely to help the current user query — explicitly excluding already-surfaced paths and recently-used-tool reference docs. Wired straight into the main loop so the recall does not burn a main-model turn on `ls`/`grep`. The leak file `memdir/findRelevantMemories.ts` carries the call site (`querySource: 'memdir_relevance',`) confirming the side-query is tagged with a dedicated source for telemetry / budgeting.

## Claudius today
Not surfaced in Claudius. The on-disk half is fully present — `lib/server/auto-memory.ts` lists topic files with mtimes (`listAutoMemory`, line 26), parses frontmatter `name` / `description` / `type` (line 136-154), and maintains a single-line-per-file index in `MEMORY.md` (`appendMemoryIndex` / `replaceMemoryIndexLine` / `removeMemoryIndexLine` lines 249-307). What is missing is the selector: nothing in `lib/server/session.ts` runs a Sonnet sideQuery against the manifest before a turn — the agent is expected to read `MEMORY.md` itself and pull files in via the file tools. There is no `querySource: 'memdir_relevance'` tag, no exclusion list of "already-surfaced paths", and no recently-used-tool reference-doc filter. The closest neighbour is the `memory_update` reminder injected by `notifyMemoryUpdate` (`lib/server/session.ts` line 3162-3180) when files change mid-session, which only signals staleness — it does not pre-select files for the next turn.

## Decision
MISSING. Topic files, frontmatter and the `MEMORY.md` index are all in place via `lib/server/auto-memory.ts`, so the data layer for `memdir/findRelevantMemories.ts` already exists. To match the leak surface, add a server-side `findRelevantMemories(projectCwd, query, exclude)` that reads the manifest produced by `listAutoMemory` (plus the frontmatter parse already in `auto-memory.ts`), runs a separate Sonnet `query()` tagged `querySource: "memdir_relevance"` for budgeting, and queues the picks as a system-reminder via the existing `queueReminder` path in `lib/server/session.ts` before the next user turn — so the main model spends its turn answering, not grepping the memory dir.
