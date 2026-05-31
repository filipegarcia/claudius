# Contextual 'Working on UI?' desktop-app tip

**Source:** Claude Code TUI — tip rotation
**Status:** MISSING

## What it is
A contextual tip that fires only when the agent is editing UI files (HTML / CSS / JSX / SVG / images) or when a dev-server bash tool (`vite`, `next`, `nuxt`) is detected, upselling Claude Code Desktop's live preview. The copy switches on whether the desktop app is already installed: `Working on UI? See a live preview in Claude Code Desktop · run /desktop` vs. `Working on UI? Claude Code Desktop has live preview and inline images · clau.de/desktop`. Gated by `enable_contextual_tip` and a 15-session cooldown — the relevance check (`pbO`) inspects bash tools against the dev-server set and recent read/edit file extensions.

## Claudius today
Not surfaced in Claudius. The tip rotation in `lib/shared/tips.ts` is a static `DEFAULT_TIPS` catalog with no contextual relevance check, no per-tip cooldown, and no file-extension or bash-tool gating — `selectTips()` filters only on whether the slash command exists on this surface. The natural home would be a new contextual `Tip` variant in `lib/shared/tips.ts` whose `isRelevant` looks at recent `Read`/`Edit`/`Write` tool calls and live `Bash` invocations from the session's message stream, surfaced via the existing spinner-tip renderer.

## Decision
MISSING. This is a Claude Code Desktop upsell, so a literal port doesn't apply — Claudius is itself the browser surface Claude Code Desktop's "live preview" tip points users toward. The interesting half is the mechanism: file-extension- and tool-aware contextual tips with a per-tip cooldown, which the current static `DEFAULT_TIPS` doesn't model. Worth adopting only if we add other contextual nudges (e.g. "editing migrations? open /migrations") that justify extending `Tip` with `isRelevant` + `cooldownSessions`.
