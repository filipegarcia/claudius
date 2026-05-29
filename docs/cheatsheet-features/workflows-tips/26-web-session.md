# Web session (--remote)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** NOT_APPLICABLE

## What it is
`--remote` runs the session on claude.ai's hosted infrastructure rather than the local machine, so work continues server-side and can be picked up elsewhere.

## Claudius today
Claudius is a local-first wrapper: every session runs against the locally launched SDK process (`lib/server/session-manager.ts` / `session.ts`) with local SQLite persistence. The hosted/remote-control flows in `lib/shared/slash-commands.ts` (`/remote-control`, `/teleport`, `/web-setup`, `/desktop`) are all tagged `external` — surfaced for awareness only, intentionally not wired into the local app.

## Decision
Not applicable. `--remote` hands execution to Anthropic's hosted platform, which is outside Claudius's local-process architecture; the related commands are already classified `external` (awareness-only). Building local UI for a hosted-only flow would 404 against this app's backend. No browser surface to add.
