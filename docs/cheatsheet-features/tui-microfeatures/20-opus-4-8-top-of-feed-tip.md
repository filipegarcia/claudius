# 'Opus 4.8 is here!' top-of-feed setup tip

**Source:** Claude Code TUI — tip rotation
**Status:** MISSING

## What it is
A first-run setup tip pinned to the very top of the feed (binary id `tengu-top-of-feed-tip`) announcing the new default model with a configuration hint: `Opus 4.8 is here!` / `Now defaults to high effort` / `/effort xhigh for your hardest tasks`. Distinct from the simpler `Opus 4.8 is now available! /model to switch` notification — this one is a persistent top-of-feed setup nudge, not a transient model-availability ping.

## Claudius today
Not surfaced in Claudius. The closest equivalents are the rotating spinner tips in `lib/shared/tips.ts` (rendered under the working spinner, not pinned to the top of the feed) and the feed banners under `components/chat/` (`RecapBanner.tsx`, `GoalBanner.tsx`, `ContextWarningBanner.tsx`, `PlanModeBanner.tsx`, etc.) — none of which announce new models or surface an effort-level setup hint. Model and effort selection itself already exists in `components/panels/widgets/ModelPicker.tsx` (backed by `app/api/sessions/[id]/effort/route.ts`), but there is no announcement layer that points users at `xhigh` on first run. A natural home would be a new top-of-feed banner in `components/chat/` (alongside `RecapBanner.tsx`) gated by a one-shot "seen Opus 4.8 tip" flag.

## Decision
MISSING. Worth adding as a one-shot top-of-feed banner in `components/chat/` that announces the current default model and links to `ModelPicker.tsx` pre-focused on effort — but only if Claudius wants to mirror Claude Code's model-launch nudges. The underlying machinery (effort levels, `ModelPicker`, dismissible banner pattern) is already in place; this is purely a new announcement surface.
