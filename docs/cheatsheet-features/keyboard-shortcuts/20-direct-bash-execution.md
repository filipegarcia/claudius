# Direct bash execution (!)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
A leading `!` in the CLI composer runs the rest of the line directly as a bash
command (bypassing the model), echoing output into the conversation.

## Claudius today
The composer (`components/chat/PromptInput.tsx`) only treats `/` (slash commands)
and `@` (file mentions) as prefixes — there is no `!` bash prefix. Ad-hoc shell is
served elsewhere: the workspace shell route (`app/api/workspaces/[id]/shell`) and
the agent's own Bash tool (whose background runs surface in the Activity rail's
"Running" section with the `BashViewer` live tail).

## Decision
NOT_APPLICABLE. Direct `!`-bash isn't wired into the composer, and Claudius already
has dedicated paths for shell execution (the workspace shell endpoint and the
agent's Bash tool with the live-tail viewer). Adding a `!` escape hatch in the chat
composer would duplicate those and blur the chat/terminal boundary, so it isn't a
clean new surface.
