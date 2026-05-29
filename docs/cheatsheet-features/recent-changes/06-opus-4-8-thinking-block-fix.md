# Opus 4.8 thinking-block fix

**Source:** Claude Code cheat sheet — Recent Changes
**Status:** NOT_APPLICABLE

## What it is
A bugfix: modifying a thinking block caused API errors on Opus 4.8. The fix is
internal to how requests preserve/round-trip thinking blocks.

## Claudius today
No browser surface and none warranted — this is an internal correctness fix in
the request/thinking-block handling layer (owned by the Claude Agent SDK /
model API, not by Claudius UI). Claudius does render thinking as synthetic
"thinking" rows (e.g. the `kind === "thinking"` entries in
`components/panels/BackgroundTasksPanel.tsx` and the assistant message stream),
but it never edits thinking blocks itself — it consumes them.

## Decision
NOT_APPLICABLE. Pure internal bugfix with no user-facing control or view to
add. Claudius picks up the fix transparently by depending on the corrected SDK;
there is nothing to build in the browser.
