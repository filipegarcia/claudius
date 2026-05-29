# MAX_THINKING_TOKENS

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Caps the number of extended-thinking tokens the model may spend (0 disables thinking entirely).

## Claudius today
Thinking is controlled through higher-level, model-aware surfaces rather than a raw token cap. The chat exposes an effort-level control (`app/api/sessions/[id]/effort/route.ts`) and an "ultracode" toggle (`app/api/sessions/[id]/ultracode/route.ts`), and `lib/server/session.ts` opts into adaptive extended thinking (`thinking: { type: "adaptive" }`, line 770). Settings → Thinking & effort surfaces the `alwaysThinkingEnabled`, `showThinkingSummaries`, and `effortLevel` settings.json keys (`app/settings/page.tsx`, catalog lines 699-716). The raw `MAX_THINKING_TOKENS` env var can additionally be set via the Settings → Environment editor.

## Decision
ALREADY_EXISTS. Thinking budget is governed by the effort-level chat control and the Thinking & effort settings section (both better UX than a raw token integer); the env var itself is reachable through the generic Environment editor. The SDK steers thinking via `effortLevel` + adaptive thinking, so a raw-token field would duplicate existing controls with worse ergonomics.
