# CLAUDECODE=1

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
A marker env var Claude Code exports into the shells it spawns so scripts and hooks can detect they are running under Claude Code.

## Claudius today
This is an output marker the agent runtime sets for its child processes, not a user-configurable input. There is nothing for a person to set or toggle in a browser — it exists for shell scripts / hooks to read at runtime. Hooks themselves are managed at `/hooks`, but the marker is automatic.

## Decision
NOT_APPLICABLE. `CLAUDECODE=1` is a runtime-exported detection flag consumed by spawned scripts, not a setting. It has no meaningful browser surface — there is nothing to configure, and exposing it would mislead users into thinking it is a knob.
