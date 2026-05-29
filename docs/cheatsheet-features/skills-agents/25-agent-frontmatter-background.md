# Agent frontmatter — background: true

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
An agent's `background: true` frontmatter makes the subagent run as a non-blocking background task when invoked.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) special-cases `background`: the new-agent `TEMPLATE` documents it (`# background: false # run as a non-blocking background task when invoked`) and the list renders a "background" meta badge (`if (fm.background === true) metaBadges.push("background")`). At runtime, background tasks have their own surfaces: `components/panels/BackgroundTasksPanel.tsx`, `app/api/sessions/[id]/background-task/` and `stop-task/`, and the `tasks` slash command.

## Decision
ALREADY_EXISTS. Authoring surface is the Agents page badge + template; runtime surface is the Background Tasks panel and its APIs. Both halves are covered.
