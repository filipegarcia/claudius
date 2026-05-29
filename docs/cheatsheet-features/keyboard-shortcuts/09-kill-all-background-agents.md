# Kill all background agents (Ctrl+X Ctrl+K)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** UI_WORTHY

## What it is
A chorded shortcut that kills *all* running background agents/tasks at once, with a
confirmation prompt to avoid accidental mass-termination.

## Claudius today
The Activity rail (`components/panels/BackgroundTasksPanel.tsx`) lists running
subagents, background shells, and process tasks, each with a per-item Stop button
(`stopTask`) backed by `app/api/sessions/[id]/stop-task/route.ts`. There is no
single "stop everything" action — the user must click each task's CircleStop button
individually.

## Decision
UI_WORTHY. Add a "Stop all" button to the Activity rail header (or the "Running"
/ "Tasks" section header) in `components/panels/BackgroundTasksPanel.tsx`. On click,
show a `confirm()` (matching the existing `closeAllTabs` confirm pattern), then fan
out the existing `POST /api/sessions/[id]/stop-task` over every running
`taskId`/shell. No new backend is needed — it composes the per-task endpoint that
already exists. Low effort, contained to the panel. Priority: med.
