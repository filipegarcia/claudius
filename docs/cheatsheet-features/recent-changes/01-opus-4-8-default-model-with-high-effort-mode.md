# Opus 4.8 default model with high-effort mode

**Source:** Claude Code cheat sheet — Recent Changes
**Status:** ALREADY_EXISTS

## What it is
Opus 4.8 ships as the default model with high-effort reasoning enabled by
default. Users can still switch models and pick an effort level.

## Claudius today
Model and effort selection live in `components/panels/widgets/ModelPicker.tsx`,
opened from the SessionCard in the right-rail Activity panel
(`components/panels/BackgroundTasksPanel.tsx`). The picker is fed by
`app/api/sessions/[id]/model/route.ts` (session-scoped, the SDK's live
`supportedModels()`) and `app/api/models/route.ts` (sessionless, used by the
workspace-create form). Effort is applied through
`app/api/sessions/[id]/effort/route.ts` → `session.setEffort()` →
`query.applyFlagSettings({ effortLevel })`. The picker renders per-model
`supportedEffortLevels` plus an "Auto" (adaptive thinking) chip, and badges
models that support `effort` / `fast`.

The "default" model and "high-effort by default" are decided by the Claude Code
CLI / SDK, not by Claudius — the picker simply advertises whatever the SDK
reports as current, so a new default model and default effort flow through
automatically with no UI change.

## Decision
ALREADY_EXISTS. The browser surface is the full model+effort picker
(`ModelPicker.tsx`) on the SessionCard, backed by `/api/sessions/[id]/model` and
`/api/sessions/[id]/effort`. The "Opus 4.8 is default / high-effort by default"
behavior is an SDK-level default that the existing picker already reflects;
there is no separate UI to build.
