# Topic files load on demand

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
Per-topic auto-memory files (alongside the `MEMORY.md` index) that Claude Code reads on demand when a topic becomes relevant, rather than loading them all upfront.

## Claudius today
Fully surfaced with CRUD on the **Memory** page (`AutoMemorySection` in `app/[workspaceId]/memory/page.tsx`). Topic files are listed, viewed, created (`CreateMemoryForm` with `type`/`name`/`description`/`body` frontmatter), edited (`EditMemoryForm`), and deleted, with the `MEMORY.md` index kept in sync. Backed by `app/api/memory/auto/route.ts` and `lib/server/auto-memory.ts` (`listAutoMemory`, `readMemoryFile`, `writeMemoryFile`, `patchMemoryFile`, `deleteMemoryFile`).

## Decision
ALREADY_EXISTS. Topic files have full browser CRUD on `/memory`. The "load on demand" timing is an agent-runtime behavior, but every topic file is fully manageable in the UI. No new surface needed.
