# CLAUDE_CODE_DISABLE_AUTO_MEMORY

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Disables auto-memory (Claude reading from / writing to the auto-memory directory).

## Claudius today
Auto-memory has a dedicated browser surface. Settings → Memory exposes the `autoMemoryEnabled` toggle ("When false, Claude will not read from or write to the auto-memory directory"), the `autoDreamEnabled` consolidation toggle, and `autoMemoryDirectory` (`app/settings/page.tsx`, lines 407-434). There is also a full `/memory` page for the workspace memory store.

## Decision
ALREADY_EXISTS. The env var maps onto the `autoMemoryEnabled` setting, which is a labeled toggle in Settings → Memory (`app/settings/page.tsx`), backed by the per-scope settings.json the SDK reads. No new surface needed.
