# Dynamic workflows — manage background multi-agent runs

**Source:** Claude Code cheat sheet — Recent Changes
**Status:** NOT_APPLICABLE

## What it is
A surface to view and manage background multi-agent workflow runs (the cheat
sheet calls it `/workflows`). Dynamic Workflows is Opus 4.8's mode where the
model plans then fans out parallel subagents.

## Claudius today
Workflows are already surfaced live, in three places:
- Enable: the "Dynamic Workflows" (ultracode) toggle in
  `components/panels/widgets/ModelPicker.tsx`, backed by
  `app/api/sessions/[id]/ultracode/route.ts` → `session.setUltracode()` →
  `query.applyFlagSettings({ ultracode })`.
- Inline run card: `components/chat/WorkflowBlock.tsx` renders the running
  workflow (name, phases, rolling AI summary, summed tokens/tools/duration,
  result) in the transcript via `AssistantMessage.tsx`.
- Activity rail: `components/panels/BackgroundTasksPanel.tsx` shows the workflow
  as a single `local_workflow` task with live status and a Stop button (wired
  to `app/api/sessions/[id]/stop-task/route.ts`).

Crucially, the SDK exposes a workflow to embedders as ONE aggregate task
(status + rolling summary + summed metrics) — there is no per-agent breakdown
and no cross-run history persisted (no workflow-runs DB; `lib/server/` has no
workflow store). Dev previews exist at `app/[workspaceId]/dev/chat-workflow` and
`app/[workspaceId]/dev/workflow-states` purely for marketing screenshots.

## Decision
NOT_APPLICABLE for a new surface. The live, manageable surface already exists:
enable via the ultracode toggle, watch via the inline WorkflowBlock, and
stop via the Activity rail task. A dedicated `/workflows` list/observability
page would be deferred — needs backend: the SDK only emits one aggregate task
per workflow with no per-agent breakdown, and Claudius persists no run history,
so a cross-run management page would have little to render and would largely
duplicate the rail. Build it only if the SDK starts emitting per-agent progress
and a run-history store is added.
