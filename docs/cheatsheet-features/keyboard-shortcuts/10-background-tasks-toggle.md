# Background tasks toggle (Ctrl+B)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Ctrl+B toggles the view of background-running tasks (subagents, shells, monitors).

## Claudius today
The right-hand Activity rail (`components/panels/BackgroundTasksPanel.tsx`, mounted
in `app/[workspaceId]/page.tsx`) is always visible and shows running subagents
("Tasks"), background shells + monitors ("Running"), scheduled loops, and a live
tool feed. Each background shell can be opened in a live-tail viewer
(`BashViewer`). Collapsible sections let the user fold/expand each group.

## Decision
ALREADY_EXISTS. Background-task visibility is a persistent, first-class browser
surface (`components/panels/BackgroundTasksPanel.tsx`), richer than a terminal
toggle — it's always on rather than hidden behind a chord. The CLI `/tasks`
command's `runNative` handler even points the user to this rail.
