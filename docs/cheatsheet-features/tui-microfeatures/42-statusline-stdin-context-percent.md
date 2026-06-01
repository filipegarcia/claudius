# statusLine stdin includes pre-computed context % used/remaining

**Source:** Claude Code TUI — ambient status line
**Status:** MISSING

## What it is
The JSON piped to a user's `statusLine` command's stdin includes a
`context_window` block with `total_input_tokens`, `context_window_size`,
`current_usage` (input / output / cache_read / cache_creation), plus two
pre-calculated fields `used_percentage` and `remaining_percentage` so a one-liner
jq can render `Context: 42% remaining`:

> `"context_window": { "total_input_tokens": number, ... "context_window_size": number, ... "current_usage": { "input_tokens": number, "output_tokens": number, "cache_creation_input_tokens": number, "cache_read_input_tokens": number } | null, "used_percentage": number | null, "remaining_percentage": number | null ... input=$(cat); remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty'); [ -n "$remaining" ] && echo "Context: $remaining% remaining"`

## Claudius today
Not surfaced in Claudius. The Settings page "Status line script" input
(`app/settings/page.tsx`) only persists `statusLine.command` into settings.json
for the CLI/SDK to consume — Claudius itself never spawns the user's status-line
script or pipes JSON into it, so the pre-computed `context_window.used_percentage`
/ `remaining_percentage` payload has no consumer in the browser. Context usage is
shown ambiently via `components/overlays/ContextOverlay.tsx`,
`components/chat/ContextWarningBanner.tsx`, and `lib/client/useContextWatcher.ts`,
all of which compute their own percentages from `app/api/sessions/[id]/context/route.ts`.

## Decision
MISSING in the CLI-parity sense — Claudius doesn't execute a user-defined
status-line command, so the stdin contract is moot here. The equivalent UX
(context % at a glance) is already covered by `ContextOverlay` and the warning
banner. No new UI needed unless we ever want to run a packaged user script and
emulate the CLI stdin schema; if so, the natural seam is the existing
`statusLine` settings block in `app/settings/page.tsx` plus a renderer near the
chat composer.
