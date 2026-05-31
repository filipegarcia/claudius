# 'Pin the working models' menu with one-token probe

**Source:** Claude Code TUI — model state
**Status:** MISSING

## What it is
A model picker that probes each candidate version with a one-token request and lets the user pin the ones that pass — including a separate `pin1m` option for the 1M-context tier. The binary strings spell it out: `Pin model versions`, `Each candidate is tested with a one-token request:`, `Pin the working models`, `Pin the working models with 1M context`, `pin1m`, with `manual` / `skip` as the other choices.

## Claudius today
Not surfaced in Claudius. The closest adjacent surface is `components/panels/widgets/ModelPicker.tsx` (fed by `app/api/sessions/[id]/model/route.ts` + `app/api/models/route.ts`), which advertises whatever the SDK reports from `supportedModels()` but never probes a version or persists a pinned alias. The 1M-context tier is exposed only as a boolean workspace default (`enable1mContext` → SDK beta `context-1m-2025-08-07`) in `components/workspaces/WorkspaceForm.tsx` and `lib/server/session.ts`; there is no `pin1m` equivalent. It would naturally live on the `ModelPicker` SessionCard widget with a workspace-level persisted pin in `lib/server/workspaces-store.ts`.

## Decision
MISSING. The Claude Code CLI runs a one-token availability probe and lets the user lock in specific working model versions (plus a `pin1m` variant for the 1M tier); Claudius currently trusts whatever the SDK's `supportedModels()` returns and only exposes the 1M tier as a plain on/off toggle. Worth adding as a "Pin working version" affordance on `ModelPicker.tsx` with a probe call and a persisted pin on the workspace if the user wants this surfaced in the browser.
