# Shell command execution as background sessions

**Source:** Claude Code cheat sheet — Recent Changes
**Status:** NOT_APPLICABLE

## What it is
Run a shell command as a background session via the terminal `! <cmd>` prefix —
the command runs detached and its output is tracked.

## Claudius today
The `! <cmd>` composer prefix is a terminal-CLI affordance; the Claudius
composer (`components/chat/PromptInput.tsx`) has no `!`-prefix handler and
intentionally routes text to the agent or to the slash-command picker. What
Claudius DOES surface is the result of background shells the agent launches:
a `local_bash` task shows up in the right-rail "Running" section
(`components/panels/BackgroundTasksPanel.tsx` →
`components/panels/widgets/BackgroundBashes.tsx`), with a Stop control wired to
`app/api/sessions/[id]/stop-task/route.ts`, and its live output is viewable in
`components/panels/BashViewer.tsx`. There is also
`app/api/sessions/[id]/background-task/route.ts` (the Ctrl+B "push foreground
work to background" equivalent). Claudius has a separate dedicated workspace
shell at `app/api/workspaces/[id]/shell/`, not a chat-composer `!` escape.

## Decision
NOT_APPLICABLE. The `! <cmd>` prefix is a terminal-only input convention with
no natural browser-composer equivalent (Claudius is an agent chat, not a
terminal emulator). The valuable half of the feature — observing and stopping
background shells — already has a full browser surface (Running section +
BashViewer + stop-task). Adding a `!`-prefix shortcut would be a terminal-ism
that doesn't fit the composer's slash/at-mention model, so no UI is warranted.
