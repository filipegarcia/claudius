# Background Shell Stall Watchdog

**Source:** Claude Code TUI — tasks-teammate
**Status:** MISSING

## What it is
Every backgrounded Bash gets a 5s-interval watchdog that stats the shell's output file: if size hasn't grown in 45s and the tail matches an interactive-prompt pattern (`(y/n)`, `[y/N]`, `Press any key`, `Continue?`, `Overwrite?`), a one-shot model notification fires citing the command — the binary string `" appears to be waiting for interactive input"` is the suffix of the full leak line `Background command X appears to be waiting for interactive input` (`tasks/LocalShellTask/LocalShellTask.tsx`, 2 occurrences). The nudge suggests echo-piping or a non-interactive flag so the agent can self-correct without the user babysitting the shell.

## Claudius today
Not surfaced in Claudius. Background shells are tracked by `BackgroundBash` (`lib/client/types.ts:314`) and rendered by `components/panels/widgets/BackgroundBashes.tsx` / `components/panels/BashViewer.tsx`, but the output is only what the agent itself has pulled via `BashOutput` (see the comment at `components/panels/BashViewer.tsx:26-44` — "v1 limitation: this surfaces what the agent has already pulled via BashOutput"). There is no server-side file-stat poll, no tail-pattern matcher, and no notify-the-model channel; the natural home for it would be alongside `session.ts`'s shell tracking, with a system-reminder emission piggy-backing on the existing reminder pipeline.

## Decision
MISSING. The watchdog lives entirely TUI-side in `tasks/LocalShellTask/LocalShellTask.tsx` and operates on the local file the SDK writes shell output into — a file Claudius never owns, because it consumes the SDK's `BashOutput` tool_result blocks rather than tailing the shell directly. Building parity would require either teaching the agent to call `BashOutput` on a 5s cadence (wasting tokens) or duplicating the SDK's shell plumbing inside `lib/server/session.ts`. A lighter analog worth considering: a client-side timer that flags a `BackgroundBash` whose last `tool_result.content` ends in one of the same prompt regexes and hasn't changed in 45s, surfacing the warning in `BackgroundBashes.tsx` rather than as a model reminder — same UX win, no SDK fork.
