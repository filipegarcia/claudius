# claude plugin prune

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** NOT_APPLICABLE

## What it is
`claude plugin prune` removes plugin installs that are no longer enabled/referenced — a housekeeping/garbage-collection command for the on-disk plugin cache.

## Claudius today
The plugins page (`app/plugins/page.tsx`) handles enable/disable and marketplace config, but there is no "prune unused installs" action. `lib/server/plugins.ts` exposes `setEnabled`/`setMarketplaces`, not a prune/GC operation.

## Decision
Not applicable as a dedicated browser surface. Prune is a one-shot disk-cleanup verb with no per-item state to manage; surfacing it as a tile or page would be a single "Prune" button with little ongoing value, and the cleanup itself is filesystem/CLI plumbing that the SDK does not currently expose to the web layer. If desired later it is at most a small action button on the existing plugins page, not a new surface — and would need backend plumbing first. Best left to the CLI.
