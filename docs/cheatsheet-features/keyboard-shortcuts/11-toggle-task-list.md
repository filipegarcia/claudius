# Toggle task list (Ctrl+T)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Ctrl+T toggles the to-do / task list the agent maintains via the TodoWrite tool.

## Claudius today
The agent's todo list shows in two always-visible places: the `TodosBanner`
(`components/chat/TodosBanner.tsx`, dismissible until the list next changes) above
the composer, and the "To-dos" collapsible section in the Activity rail
(`TodoList` widget in `components/panels/BackgroundTasksPanel.tsx`), which also has
a `+` button (`AddTodosForm`) to ask the agent to append items.

## Decision
ALREADY_EXISTS. The todo list is surfaced inline via `components/chat/TodosBanner.tsx`
and the Activity rail's "To-dos" section. Both update live from `session.latestTodos`,
so the browser shows the list continuously rather than behind a toggle.
