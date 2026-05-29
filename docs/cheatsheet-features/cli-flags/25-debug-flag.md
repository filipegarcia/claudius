# --debug

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** NOT_APPLICABLE

## What it is
`--debug` turns on verbose debug logging for the CLI/SDK, printing internal diagnostics to the terminal/log.

## Claudius today
Server-side debug logging is gated by env vars (e.g. `CLAUDIUS_DEBUG_SESSIONS=1`, used in `lib/server/session.ts`), written to the server logs — not a user-facing browser feature. The chat verbosity selector (`lib/shared/verbose.ts`) controls how much the chat UI shows, which is a separate, higher-level concept already surfaced.

## Decision
Not applicable. `--debug` is a developer/diagnostics log-verbosity switch with no end-user browser value; it's an env var on the server process. The user-facing analog (how chatty the conversation view is) already exists as the chat verbosity levels. No new UI warranted.
