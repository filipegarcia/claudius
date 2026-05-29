# /model

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/model` switches the active model and exposes effort-level control for models
that support it.

## Claudius today
There are two surfaces. (1) A live, session-scoped model picker:
`components/panels/widgets/ModelPicker.tsx`, fed by
`app/api/sessions/[id]/model/route.ts` (and the sessionless `app/api/models`
for the workspace-create form). It lists available models, shows "effort" /
"fast" capability badges, and renders the Effort chip row (low / medium / high
/ xhigh / max + Auto) plus the Dynamic Workflows (ultracode) toggle right
underneath — so model switch and effort control sit together exactly as the
cheat sheet describes. (2) A persisted default `model` field in the Settings
page (`app/settings/page.tsx`, written to `settings.json`).

## Decision
ALREADY_EXISTS. `ModelPicker.tsx` + `/api/sessions/[id]/model` already deliver
"switch model with effort-level control" as a live chat control, and the
Settings page covers the persisted default. No new surface needed.
