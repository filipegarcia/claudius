# --effort

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--effort <level>` sets the reasoning-effort level (low/medium/high/xhigh/max) for supported models.

## Claudius today
Effort is a live chat control: the ModelPicker (`components/panels/widgets/ModelPicker.tsx`) shows the supported effort levels and posts to `app/api/sessions/[id]/effort/route.ts`, which calls `Query.applyFlagSettings`. A persistent `effortLevel` is also in the Settings catalog (`app/settings/page.tsx`, "Thinking & effort"). The related "ultracode" toggle (`app/api/sessions/[id]/ultracode/route.ts`) runs xhigh + dynamic workflows.

## Decision
Already covered. Effort is both a per-session live control and a persisted settings value. No new UI needed.
