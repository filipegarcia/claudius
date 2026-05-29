# /workflows

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/workflows` views and manages background multi-agent workflow runs — the
parallel/sequential subagent orchestrations Claude Code can spin up (Dynamic
Workflows / ultracode).

## Claudius today
Multi-agent workflows surface in several real places:

- The right-rail Background Tasks panel
  (`components/panels/BackgroundTasksPanel.tsx`) lists `local_workflow` (and
  `local_agent`) tasks under "Tasks" with live status, AI-generated progress
  summaries, summed tokens/tools/duration, the workflow name, and a per-task
  **Stop** button (`stopTask(t.taskId)`) — i.e. view *and* manage.
- In chat, `components/chat/WorkflowBlock.tsx` renders each workflow tool-use as
  an aggregate card joined to its `local_workflow` task by `tool_use_id`, with
  expand/collapse and a status chip.
- The "ultracode" / Dynamic Workflows toggle is a session control
  (`app/api/sessions/[id]/ultracode/route.ts`, surfaced via `ModelPicker` /
  `SessionCard`).

Task plumbing flows through `lib/server/session.ts` and `lib/client/use-session.ts`.
(There are also dev-only preview pages `app/[workspaceId]/dev/chat-workflow` and
`dev/workflow-states` used for the marketing gallery, not the live surface.)

## Decision
ALREADY_EXISTS. Viewing and managing background multi-agent workflow runs is
covered by the Background Tasks panel (`components/panels/BackgroundTasksPanel.tsx`,
with Stop) plus the in-chat `WorkflowBlock` and the ultracode session toggle.
The SDK exposes a workflow only as one aggregate task (no per-agent breakdown),
so the current surface matches what the backend provides. No new surface needed.
