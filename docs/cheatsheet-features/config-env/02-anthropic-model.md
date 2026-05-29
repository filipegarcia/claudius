# ANTHROPIC_MODEL

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Sets the default model Claude Code uses. The env-var equivalent of the `model` setting / `/model` command.

## Claudius today
Model selection has a first-class browser surface. The chat right-rail uses `ModelPicker` (`components/panels/widgets/ModelPicker.tsx`) backed by the session-scoped `app/api/sessions/[id]/model/route.ts`; new-session defaults are picked in `components/workspaces/WorkspaceForm.tsx` (a `Model` field, line 384) fed by the sessionless `app/api/models/route.ts`; and the persisted `model` settings.json key has a dedicated field in Settings → Model & UI (`app/settings/page.tsx`, line 347).

## Decision
ALREADY_EXISTS. The env var maps onto the `model` setting, which has three surfaces: the chat `ModelPicker`, the workspace-create Model field, and the Settings → Model & UI field. No new UI needed.
