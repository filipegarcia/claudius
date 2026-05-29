# Status line refreshInterval

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** UI_WORTHY

## What it is
A `refreshInterval` field on the `statusLine` settings object that re-runs the
status-line command every N seconds in addition to event-driven updates (the
`statusLine` object also supports `padding` and `hideVimModeIndicator`).

## Claudius today
Partially handled, and currently destructive. The Settings page "Model & UI"
card has a "Status line script" input, but it reads/writes only
`statusLine.command` and rebuilds the object as `{ type: "command", command }`
(`app/settings/page.tsx`). So editing the command **clobbers** any existing
`refreshInterval` / `padding` / `hideVimModeIndicator`. Those sub-fields are
reachable today only via Raw JSON mode.

## Decision
UI_WORTHY (low). Expand the Status line section to a small group: keep the
command input but merge into (not replace) the existing `statusLine` object, and
add a "Refresh interval (s)" number input (plus optionally `padding` /
`hideVimModeIndicator`). Pure settings.json edit — no backend. Low priority, but
worth doing if only to stop the current edit from silently dropping the other
status-line fields.
