# Default-permission-mode config nudge

**Source:** Claude Code TUI — tip rotation
**Status:** MISSING

## What it is
A conditional spinner tip that only fires once the user has actually used Plan Mode but has never persisted a default permission mode in settings. The binary string shows the tip object: `id:"default-permission-mode-config"`, content `"Use /config to change your default permission mode (including Plan Mode)"`, with `isRelevant` returning `q && !K` where `q = Boolean(H.lastPlanModeUse)` and `K = Boolean(_?.permissions?.defaultMode)`, gated by `cooldownSessions:10`.

## Claudius today
The two underlying pieces exist but are not wired into a conditional nudge. Workspace-level default permission mode is configurable in `components/workspaces/WorkspaceForm.tsx` (the `Permission mode` select writing `defaults.permissionMode`) and persisted via `lib/server/workspaces-store.ts`; the SDK-side `permissions.defaultMode` shape lives in `lib/server/settings.ts`. Plan Mode itself is surfaced by `components/chat/PlanModeBanner.tsx` and `components/overlays/PlanOverlay.tsx`. The rotating tips catalog in `lib/shared/tips.ts` (`DEFAULT_TIPS` / `selectTips`) is unconditional — every tip is either always-eligible or gated only on slash-command availability; there is no `isRelevant`-style predicate that reads session state like `lastPlanModeUse` or settings like `permissions.defaultMode`, and no per-tip `cooldownSessions`.

## Decision
MISSING. The tip's two preconditions are observable in Claudius (Plan Mode is a real mode the user can enter, and workspace defaults already carry `permissionMode`), but the nudge itself — "you used Plan Mode, want to make it sticky?" — is not surfaced. Worth adding as a conditional entry in `lib/shared/tips.ts` with an `isRelevant` predicate plus a cooldown, pointing users at the `Permission mode` field in `WorkspaceForm.tsx` (Claudius's equivalent of `/config`).
