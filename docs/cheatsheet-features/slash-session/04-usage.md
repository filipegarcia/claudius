# /usage

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Shows token usage, cost, and cache breakdown for the account/session.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "usage"`, alias `stats`, handler `native`). The dispatcher routes `/usage` to the global Usage & account page. A session-scoped `/cost` overlay (`CostOverlay`) and a dedicated workspace `cost` page also exist for per-session cost/usage breakdowns.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"usage"`, around line 823 → `router.push("/usage")`), the `app/usage/page.tsx` page, and the `/api/usage` + `/api/limits` backends. Per-session cost/cache detail is at `components/overlays/CostOverlay.tsx` and the workspace cost page.
