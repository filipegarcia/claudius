# Effort levels low/medium/high/max

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Choose the reasoning-effort level for the session (low / medium / high / max, plus xhigh and adaptive auto on capable models), trading latency and cost against depth.

## Claudius today
The effort row in `components/panels/widgets/ModelPicker.tsx` renders a chip per level the active model exposes (`EFFORT_LABEL` covers low/medium/high/xhigh/max) plus an "Auto" adaptive chip. Picks post to `app/api/sessions/[id]/effort/route.ts`, which forwards the level via the SDK's `applyFlagSettings` (the route's header comment documents exactly why `/effort` is not used). The `/effort` slash command is also registered in `lib/shared/slash-commands.ts`.

## Decision
Already covered. `ModelPicker` is the dedicated browser surface for effort levels, backed by the effort API route. No new UI needed.
