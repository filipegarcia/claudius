# spinnerTipsEnabled / spinnerTipsOverride config (+ per-tip cooldownSessions)

**Source:** Claude Code TUI — tip rotation
**Status:** PARTIAL

## What it is
Two `settings.json` knobs control the CLI's spinner-tip rotation: `spinnerTipsEnabled` toggles the whole feature on/off, and `spinnerTipsOverride` takes `{ "excludeDefault": true, "tips": ["Custom tip"] }` to swap the built-in rotation for a custom list. Each built-in tip also carries its own `cooldownSessions` throttle (literals seen include 1, 5, 10, 15, 25, 30) so individual tips don't reappear every session. Override tips are mapped to `custom-tip-${K}` objects with `cooldownSessions: 0` — custom tips are never throttled.

## Claudius today
Claudius has its own browser-side spinner-tip rotation that is the analog of this feature, but it is not configured via `settings.json` and does not implement the per-tip `cooldownSessions` throttle. `lib/shared/tips.ts` is the single source of truth for tip content (a `DEFAULT_TIPS` catalog plus `selectTips()` for server gating); `components/chat/SpinnerTip.tsx` renders one rotating line under the working spinner, with `lib/client/useTipDismissals.ts` applying a per-tip "show ~20% as often" weighting when the user clicks the `x` dismiss control. The file's own header comment notes that the SDK's `spinnerTipsOverride` only renders in a terminal and "never in Claudius's programmatic use" — which is why Claudius ships its own catalog instead of honoring those settings keys.

## Decision
PARTIAL. Claudius already has the equivalent surface (rotating tips under the spinner) with a dismissal-weighted rotation, but no `settings.json` override and no per-tip cooldown throttle. If user-customizable tips are wanted, the natural shape would be a new `spinnerTipsOverride`-style key honored by `lib/shared/tips.ts` (or a server-side feed appended in `selectTips()`), and a `cooldownSessions` field on the `Tip` type wired through `useTipDismissals` so individual tips can declare their own minimum re-show gap.
