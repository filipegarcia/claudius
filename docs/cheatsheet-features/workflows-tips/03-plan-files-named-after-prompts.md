# Plan files named after prompts

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** NOT_APPLICABLE

## What it is
When Claude Code writes a plan to disk, it names the file after the prompt with a memorable suffix (e.g. `fix-auth-race-snug-otter.md`). This is an internal file-naming convention for plan artifacts.

## Claudius today
There is no plan-file naming surface in Claudius. Plans surface live in the conversation via `components/chat/PlanModeBanner.tsx` / `WorkflowBlock.tsx` and approve through `app/api/sessions/[id]/plan/route.ts`. Any plan markdown the agent writes to disk lands in the workspace and is browsable through the existing Files page (`app/[workspaceId]/files/page.tsx`).

## Decision
Not applicable. This is an internal naming convention applied by the SDK/agent when it writes a file — there is no decision or control for a browser to expose. The resulting files are already viewable through the Files page; no dedicated UI adds value.
