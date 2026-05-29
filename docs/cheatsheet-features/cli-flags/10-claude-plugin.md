# claude plugin

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude plugin` manages plugins and marketplaces (install, enable/disable, list).

## Claudius today
The plugins page (`app/plugins/page.tsx`) lists installed plugins (from the live SDK session) and configured plugins per scope, supports enable/disable toggles, marketplace management, and install. Backed by `lib/server/plugins.ts`, `app/api/plugins/route.ts`, `app/api/plugins/available`, and `app/api/plugins/reload`.

## Decision
Already covered. The plugins page is the browser surface for plugin management. No new UI needed for the core `claude plugin` verb (see the separate `plugin prune` entry for the one missing sub-command).
