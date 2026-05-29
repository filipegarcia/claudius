# Pause headless & resume (hooks: defer)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** NOT_APPLICABLE

## What it is
A `defer` decision in the headless/permission flow that pauses a non-interactive
(headless) run so it can be resumed later, rather than allowing or denying
immediately.

## Claudius today
No surface. In the bundled SDK, `defer` is a `HookPermissionDecision`
(`'allow' | 'deny' | 'ask' | 'defer'`) — i.e. an output decision returned by a
hook at runtime in the headless flow, not a user-configurable hook handler type
or a settings.json field. Claudius's hook editor lets you author handlers
(command/http/prompt/agent/mcp_tool); the decision a handler returns is runtime
behavior, not something the UI configures. Interactive pause/resume in Claudius
is instead handled by the live interrupt/stop and pending-prompt controls.

## Decision
NOT_APPLICABLE. `defer` is a runtime permission decision in the headless code
path, not a config knob or an authorable hook step. There is no settings/form
control to expose, and the interactive equivalents (interrupt, pending prompts)
already exist as chat controls.
