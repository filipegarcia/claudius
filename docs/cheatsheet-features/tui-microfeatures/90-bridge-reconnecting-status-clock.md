# Bridge Reconnecting Status with Disconnected-For Clock

**Source:** Claude Code TUI — bridge-remote
**Status:** MISSING

## What it is
When the bridge transport drops, the TUI status line replaces itself with a spinner-prefixed `Reconnecting · retrying in <delay> · disconnected <elapsed>` line — the exact composition is visible in `bridge/bridgeUI.ts` as ``${chalk.yellow(frame)} ${chalk.yellow('Reconnecting')} ${chalk.dim('·')} ${chalk.dim(`retrying in ${delayStr}`)} ${chalk.dim('·')} ${chalk.dim(`disconnected ${elapsedStr}`)}\n``. Both the retry-in countdown and the disconnected-for clock tick in place while the spinner animates; on success a `[bridge:poll] Reconnected after <duration>` log line is printed so users can see exactly how long the gap was.

## Claudius today
Not surfaced in Claudius. The natural location is the SSE error path in `lib/client/use-session.ts` (around lines 3233-3249), where `es.onerror` already distinguishes `EventSource.CONNECTING` (browser auto-retry in flight) from `EventSource.CLOSED` (permanently dead) — but the CONNECTING branch is a no-op comment and the CLOSED branch only clears the pending flag, so the user never sees a "reconnecting" indicator or a disconnected-for clock. `components/chat/StatusLine.tsx` (the same chip strip that hosts the fast-mode and ultracode indicators) is where a `Reconnecting · retrying … · disconnected …` chip would belong, and a `[stream:reconnected after Xs]` toast could land via `components/notifications/NotificationsProvider.tsx` once `es.onopen` fires after a prior `onerror`.

## Decision
MISSING. The TUI's `bridge/bridgeUI.ts` ticks a live `retrying in <delay> · disconnected <elapsed>` clock while reconnecting and prints a `[bridge:poll] Reconnected after <duration>` log on recovery; Claudius silently rides the browser's built-in `EventSource` backoff with no visible feedback. Follow-up: track the first `onerror` timestamp in `use-session.ts`, render a yellow "Reconnecting · disconnected <Ns>" chip in `StatusLine.tsx` while `readyState === CONNECTING`, and on the next successful `onopen` emit a one-shot "Reconnected after <Ns>" toast / console line.
