# Fast-mode overloaded / fast-limit reset toasts

**Source:** Claude Code TUI — error & recovery
**Status:** PARTIAL

## What it is
Two distinct toasts surface when fast mode flips off: `Fast mode overloaded and is temporarily unavailable / resets in <time>` (capacity) and `Fast limit reached and temporarily disabled / resets in <time>` (quota). A live countdown ticks down to the reset, and a recovery toast `Fast limit reset / now using fast mode` confirms when fast mode flips back on.

## Claudius today
Claudius already tracks the SDK's `fast_mode_state` ("off" | "cooldown" | "on") in `lib/client/use-session.ts` (folded from each result event around line 2574) and renders a `⚡ cooldown` / `⚡ on` chip in `components/chat/StatusLine.tsx` (lines 247–259). What's missing is the toast text and the reset countdown: there's no distinction between "overloaded" vs "limit reached", no `resets in <time>` countdown surface, and no recovery toast when it flips back to "on". The setter lives in `lib/server/session.ts#setFast` and the route at `app/api/sessions/[id]/fast/route.ts`.

## Decision
PARTIAL. The state machine is wired and the chip already signals cooldown, but the differentiated reason + live countdown + recovery toast are not surfaced. Worth extending the SDK result handler in `lib/client/use-session.ts` to capture a reset timestamp + reason and rendering a transient toast/banner near `components/chat/StatusLine.tsx` (or as a `components/chat/FeedbackBanner.tsx`-style notice) when fast mode enters cooldown and again when it returns.
