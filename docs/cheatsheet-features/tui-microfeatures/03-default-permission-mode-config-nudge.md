# Default-permission-mode config nudge

**Source:** Claude Code TUI — tip rotation
**Status:** ALREADY_EXISTS

## What it is
A conditional spinner tip that only fires once the user has actually used Plan Mode but has never persisted a default permission mode in settings. The binary string shows the tip object: `id:"default-permission-mode-config"`, content `"Use /config to change your default permission mode (including Plan Mode)"`, with `isRelevant` returning `q && !K` where `q = Boolean(H.lastPlanModeUse)` and `K = Boolean(_?.permissions?.defaultMode)`, gated by `cooldownSessions:10`.

## Claudius today
Mirrored directly in the rotating tips catalog. `lib/shared/tips.ts` defines the `id: "default-permission-mode-config"` entry ("Liked Plan Mode? Make it sticky in Workspace settings -> Permission mode...") with a `requiresPlanModeNudge: true` gate, and `selectClientTips` drops it unless the caller passes `planModeNudgeEligible: true`. `app/[workspaceId]/page.tsx` computes that flag as `planModeUsed && !activeWorkspace?.defaults?.permissionMode` — the Claudius analog of the TUI's `q && !K` — using a within-session latch that flips to true the first time it observes `permissionMode === "plan"`. The destination the tip points at is the `Permission mode` select in `components/workspaces/WorkspaceForm.tsx`, which writes `defaults.permissionMode` through `lib/server/workspaces-store.ts`. The TUI's `cooldownSessions: 10` is intentionally not mirrored — Claudius's dismiss-weighting (`DISMISSED_TIP_SHOW_PROBABILITY` in `lib/shared/tips.ts`) is the "show less, not never" analog.

## Decision
ALREADY_EXISTS. The post-Plan-Mode "make it sticky" nudge ships as a first-class tip in `lib/shared/tips.ts`, gated by the same two preconditions the TUI uses, and pointing at the Workspace settings field that backs Claudius's equivalent of `permissions.defaultMode`. No new UI needed.
