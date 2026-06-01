# Fast-mode overloaded / fast-limit reset toasts

**Source:** Claude Code TUI — error & recovery
**Status:** PARTIAL

## What it is
Two distinct toasts surface when fast mode flips off: `Fast mode overloaded and is temporarily unavailable / resets in <time>` (capacity) and `Fast limit reached and temporarily disabled / resets in <time>` (quota). A live countdown ticks down to the reset, and a recovery toast `Fast limit reset / now using fast mode` confirms when fast mode flips back on.

## Claudius today
Claudius reads the SDK's per-result `fast_mode_state` (`"off" | "cooldown" | "on"`) in `lib/client/use-session.ts` and renders a persistent `⚡ cooldown` / `⚡ on` chip in `components/chat/StatusLine.tsx`. On top of that, `use-session.ts` derives a `cooldown` / `recovered` *edge* notice from a `prevFastModeStateRef` (gated on `!replayingRef` so a fully-elapsed cycle during replay doesn't pop mid-rehydrate), which `components/chat/FastModeNoticePanel.tsx` renders as a transient amber/emerald banner above the composer in `app/[workspaceId]/page.tsx` with text "Fast mode temporarily unavailable" and "Fast mode reset — back to fast" — auto-fading after 8s. What's still missing is the differentiated reason ("overloaded" capacity vs "limit reached" quota) and the live `resets in <time>` countdown: the SDK exposes neither a fast-mode reason nor a fast-mode reset timestamp, and `SDKRateLimitInfo.resetsAt` is the overall subscription window, not the fast-mode cooldown (the scope note in `FastModeNoticePanel.tsx` calls this out explicitly). The setter lives in `lib/server/session.ts#setFast` and the route at `app/api/sessions/[id]/fast/route.ts`.

## Decision
PARTIAL. The transition moments and the recovery confirmation are now surfaced — `FastModeNoticePanel` mirrors the TUI's transient toast on the `→ cooldown` and `cooldown → on` edges. The reason discriminator and live `resets in <time>` countdown remain out of reach until the SDK propagates a fast-mode reason and a fast-mode-specific reset timestamp; once it does, the notice headline + a countdown line can be threaded through the existing `fastModeNotice` shape with no new plumbing.
