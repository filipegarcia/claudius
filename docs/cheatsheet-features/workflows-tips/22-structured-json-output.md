# Structured JSON output (--output-format json)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** NOT_APPLICABLE

## What it is
`--output-format json` makes the headless CLI emit machine-readable JSON instead of human-formatted text, for piping into other tools.

## Claudius today
This is a flag that only modifies the *stdout* shape of the headless `claude -p` invocation. Claudius consumes the SDK's structured message stream internally (`lib/server/session.ts` -> SSE -> `lib/client/use-session.ts`) and renders it as a rich conversation; there is no human-readable-vs-JSON toggle because the browser already works from structured events. Sessions can be exported via `app/api/sessions/[id]/transcript` / export route for downstream use.

## Decision
Not applicable. `--output-format json` only matters for the headless CLI's text output; it has no analog in a browser that already renders the structured SDK stream natively. Transcript export already covers "get the data out." No browser surface to add.
