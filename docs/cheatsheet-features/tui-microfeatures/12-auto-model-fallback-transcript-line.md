# Automatic model-fallback system message

**Source:** Claude Code TUI — model state
**Status:** ALREADY_EXISTS

## What it is
When the requested model isn't available because of demand, Claude Code
auto-switches to the configured fallback and prints a one-line system message
into the transcript. The binary fragments stitch together as
`Switched to <new> because <old> is not available due to high demand for <old>`,
emitted alongside the `tengu_model_fallback_triggered` telemetry event. It is
distinct from the manual `/model` switcher confirmation — this line fires
automatically, without user input, the moment the SDK swaps in `fallbackModel`.

## Claudius today
Both the fallback mechanism and the transcript announcement are wired.
`lib/server/workspaces-store.ts` and `lib/server/session.ts` pipe
`fallbackModel` straight into the SDK's `Options.fallbackModel`, the workspace
form (`components/workspaces/WorkspaceForm.tsx`) exposes the field, and
`app/api/sessions/route.ts` accepts it per-request. On the read side,
`lib/client/types.ts` declares a `model_fallback` `SystemEntry` kind,
`lib/client/use-session.ts` (the `sysAny.subtype === "model_fallback"` branch)
lifts the SDK event into a `SystemEntry` — reusing the SDK's `content` when
present and otherwise rebuilding the
`Switched to <fallback_model> because <original_model> is not available` label
from the structured payload, with `trigger` (`overloaded` /
`model_not_found`) stashed in `detail`. `components/chat/SystemPill.tsx` renders
the kind with an amber `Cpu` icon, mirroring the `init` pill's icon but
recoloured so it scans as a state-change rather than a session-start.

## Decision
ALREADY_EXISTS. The moment-of-swap is now in-thread: the SDK's
`model_fallback` system message becomes a `SystemPill` with the exact
"Switched to X because Y is not available …" wording the CLI prints, paired
with the `overloaded` / `model_not_found` trigger. No further UI to build.
