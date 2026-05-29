# CLAUDE_CODE_SESSION_ID

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Forces a specific session id, used by hooks/CI so an external orchestrator can correlate a run with a known id.

## Claudius today
Claudius manages session lifecycle and ids itself (`lib/server/session-manager.ts`, `lib/server/session.ts`); ids are created by the app and surfaced read-only in the StatusLine/session picker and session pages. There is no use case for a human to pin a session id in the browser — it is a CI/automation input consumed before a session exists.

## Decision
NOT_APPLICABLE. This is a CI/hook orchestration input (pin the id from outside), not a user-facing setting. Claudius owns session-id creation, and a browser control to override it would be meaningless and could collide with the manager's bookkeeping. It can still be passed as an env var to the server process if someone scripts CI around Claudius, but there is no UI to build.
