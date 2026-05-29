# Import files (@path syntax)

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
A CLAUDE.md directive — a line of the form `@path` — that inlines another file's contents into the memory at load time, allowing memory to be composed from smaller files.

## Claudius today
Fully implemented and visualized. `lib/server/claudemd.ts` (`resolveContent`) expands `@<path>` import lines recursively — relative-to-base resolution, `MAX_IMPORT_HOPS = 5` depth cap, cycle detection, and missing-file markers — emitting one provenance segment per inlined file. The Memory page's "Resolved" view (`ResolvedView` in `app/[workspaceId]/memory/page.tsx`) renders each segment with its `source` label (e.g. `@path → (inline)`) and import `depth`.

## Decision
ALREADY_EXISTS. Import expansion is implemented in `resolveContent` and surfaced in the `/memory` "Resolved" view with full provenance (source path, depth, cycle/missing handling). No new surface needed.
