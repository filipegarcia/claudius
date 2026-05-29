# modelOverrides

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** UI_WORTHY

## What it is
A `modelOverrides` map in settings.json that remaps the entries shown in the
model picker to custom model IDs (e.g. point "sonnet" at a gateway/proxy model
ID). Useful for Bedrock/Vertex/proxy deployments where the friendly aliases must
resolve to deployment-specific IDs.

## Claudius today
No dedicated UI. The Settings catalog in `app/settings/page.tsx` *explicitly
omits* `modelOverrides` (it is listed among the keys excluded from the curated
catalog). It is only reachable today through the generic "Other" key editor /
Raw JSON mode — which gives no structure, validation, or pairing against the
actual model picker. The model picker itself is fed by `app/api/models/route.ts`
(SDK `supportedModels()` with a static fallback).

## Decision
UI_WORTHY (low). Add a small "Model overrides" sub-section to the Settings page
"Model & UI" card: a key→value editor where the left column is an alias from the
model picker and the right column is the custom ID. Pure settings.json read/write
— no new backend, reuse the existing `update()` patch path (similar shape to the
existing EnvEditor). Low priority: it matters mainly for proxy/enterprise setups,
and the generic Other editor is a usable stopgap.
