# Fast-mode auto-cooldown with auto-recovery

**Source:** Claude Code TUI — ambient status line
**Status:** ALREADY_EXISTS

## What it is
When Fast mode trips its rate limit the SDK fires `tengu_fast_mode_fallback_triggered` and the TUI quietly toggles Fast mode off (`Fast mode cooldown triggered ( ), duration ...`), then re-enables it later (`Fast mode cooldown expired, re-enabling fast mode`). The lightning indicator flips off and back on without user action — the underlying event carries `cooldown_duration_ms` and `cooldown_reason`.

## Claudius today
The SDK's per-result `fast_mode_state` (`"off" | "cooldown" | "on"`) is read in `lib/client/use-session.ts` (around line 2666) and stored as `fastModeState`. `components/chat/StatusLine.tsx` (Props line 59, render around line 270) renders a lightning chip whenever `fastModeState !== "off"`: amber `⚡ on` when active, muted `⚡ cooldown` while the SDK has temporarily disabled it. Because the chip is driven straight off the SDK-reported state, the flip-off-on-rate-limit and flip-back-on-after-expiry both surface in Claudius with no extra plumbing. A `components/chat/FastModeNoticePanel.tsx` transient banner additionally marks the `on → cooldown` and `cooldown → on` edges (derived from a prior-state ref in `use-session.ts`) to mirror the TUI's "re-enabling fast mode" line. The on/off user toggle itself lives in `components/panels/widgets/ModelPicker.tsx` via `app/api/sessions/[id]/fast/route.ts` → `session.setFast()`.

## Decision
ALREADY_EXISTS. The cooldown / recovery transitions are reflected in the status-line lightning chip via `fastModeState` plumbed from `use-session.ts` to `StatusLine.tsx`, and the edge transitions get a transient `FastModeNoticePanel` toast. No new UI needed — the SDK does not expose `cooldown_duration_ms` or `cooldown_reason` to clients, so a per-cooldown countdown would have to wait on an SDK change.
