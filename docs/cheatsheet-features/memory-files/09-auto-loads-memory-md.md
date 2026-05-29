# Auto-loads MEMORY.md at startup

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
The auto-memory index file `MEMORY.md` that Claude Code loads at session startup (truncated to roughly the first 25KB / 200 lines), serving as a table of contents into the per-topic memory files.

## Claudius today
Surfaced on the **Memory** page in the "Auto-memory" panel (`AutoMemorySection` in `app/[workspaceId]/memory/page.tsx`). `MEMORY.md` is listed (rendered bold/first), viewable as raw markdown, and is automatically maintained: creating, editing, or deleting a topic file appends/updates/removes its index line via `appendMemoryIndex` / `replaceMemoryIndexLine` / `removeMemoryIndexLine` in `lib/server/auto-memory.ts`. Backed by `app/api/memory/auto/route.ts`.

## Decision
ALREADY_EXISTS. `MEMORY.md` is viewable and auto-maintained from the `/memory` page. Note: the SDK's runtime "first 25KB / 200 lines" truncation at load is an agent-runtime behavior with no UI knob, and exposing that limit is not meaningfully useful — but it does not change the status; the index file itself is fully surfaced.
