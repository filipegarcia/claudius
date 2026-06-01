# Opus Plan Mode reminder tip

**Source:** Claude Code TUI — tip rotation (model-state-conditional spinner tip)
**Status:** MISSING

## What it is
An ambient spinner tip the CLI shows users whose default model is set to `opusplan` but who haven't actually entered Plan Mode in over 3 days. The tip's `isRelevant` predicate is `be()==="opusplan"` AND `(Date.now()-lastPlanModeUse)/86400000 > 3`, and the body reads:

> `Your default model setting is Opus Plan Mode. Press <shift+tab> twice to activate Plan Mode and plan with Claude Opus.`

It carries `cooldownSessions: 2`, so once shown it sits out the next two sessions before becoming eligible again.

## Claudius today
Plan Mode itself is well covered — `components/chat/PlanModeBanner.tsx` and `components/overlays/PlanOverlay.tsx` render the in-session state, and the cycle is exposed via `lib/shared/slash-commands.ts` plus the keybindings system. Plan-mode session config flows through `lib/shared/session-defaults.ts` (`planModeInstructions`) and `lib/server/session.ts`. The spinner-tip rotation lives in `lib/shared/tips.ts` (`DEFAULT_TIPS`, `selectTips`, `nextTipIndexWithDismissals`), but its `Tip` shape is static — `{ id, text, command? }` plus a few boolean gates (`minSessions`, `requiresPlanModeNudge`, `requiresNewUser`) — with no `isRelevant` predicate, no `cooldownSessions`, and no model/usage-age state plumbed in. There is no `opusplan` model surfaced anywhere in the codebase (grep returns zero hits in `lib/`, `components/`, `app/`), and nothing tracks a persisted `lastPlanModeUse` timestamp — the closest is the within-session latch in `app/[workspaceId]/page.tsx` that drives the existing `default-permission-mode-config` Plan-Mode follow-up nudge, which resets every reload. Not surfaced in Claudius.

## Decision
MISSING. Claudius has the Plan Mode surface but no `opusplan` default-model concept and no conditional/cooldown-aware tip mechanism. Surfacing this would mean (a) extending `lib/shared/tips.ts` `Tip` with an `isRelevant(ctx)` predicate plus `cooldownSessions`, (b) persisting `lastPlanModeUse` (probably in the per-project `.claudius.db` alongside session state), and (c) only emitting the tip when the user's default model is the plan-mode-prefixed one. Worth adding only if Claudius adopts an `opusplan`-style default model; otherwise the trigger never fires and the tip would be dead weight.
