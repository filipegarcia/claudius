# Shell as background session (! <cmd>)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** UI_WORTHY

## What it is
Prefixing composer input with `!` (e.g. `! npm run dev`) runs the command as a background shell session that keeps running and streams output, without going through a model turn.

## Claudius today
Agent-spawned background shells *are* surfaced: `components/panels/BackgroundTasksPanel.tsx` and `components/panels/widgets/BackgroundBashes.tsx` list `local_bash` tasks with a live-tail viewer (`components/panels/BashViewer.tsx`). **But** the *user-initiated* `! <cmd>` path does not exist: `PromptInput.submit()` (`components/chat/PromptInput.tsx`) sends input verbatim with no leading-`!` intercept (only `/` opens the slash picker), and the input route (`app/api/sessions/[id]/input/route.ts`) has no `!` handling. There is a separate workspace shell (`app/api/workspaces/[id]/shell`) used elsewhere (git console).

## Decision
UI_WORTHY (med). Add a leading-`!` intercept in the composer that launches a background shell and shows it in the existing Background Tasks panel (reusing `BashViewer`/`BackgroundBashes`). The *display* half is already built; the gap is the input path. This needs a small backend: a route to spawn a user-initiated background bash bound to the session and stream its output (the SDK background-task plumbing and `lib/server/shell.ts` exist, so it's a thin shell over existing primitives rather than from scratch). Priority med.
