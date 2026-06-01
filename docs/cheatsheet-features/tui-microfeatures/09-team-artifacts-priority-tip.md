# Team-artifacts spinner tip (priority 4)

**Source:** Claude Code TUI — tip rotation (highest-priority dynamic spinner tip)
**Status:** MISSING

## What it is
The CLI's highest-priority spinner tip: a `"team-artifacts"` entry with `priority:4` whose body is computed dynamically by an async network/IO scan on session start. The binary fingerprint is:

> `team-artifacts",priority:4,content:async()=>{let H=await vh7().catch((_)=>{return t_("tips_team_artifact_show",_ instanceof Error?"content_scan_error":"content_unknown_error"),[]});if(H.length===0)return"";return yh7(H),hh7(),Eh7(H)},cooldownSessions:1,isRelevant:async()=>Nh7()`

So the tip (a) only fires when an async `isRelevant` predicate (`Nh7()`) says so, (b) runs a scan (`vh7()`) and on rejection emits one of three telemetry events — `tips_team_artifact_show` paired with `"content_scan_error"` for a thrown `Error` or `"content_unknown_error"` for a non-Error rejection — and (c) returns an empty string (no tip) when the scan finds nothing, otherwise formats the artifacts into a single-line tip. `cooldownSessions:1` keeps it from re-firing every session.

## Claudius today
Not surfaced in Claudius. `lib/shared/tips.ts` is the spinner-tip source of truth and its `Tip` shape is deliberately static — `{ id, text, command?, minSessions?, requiresPlanModeNudge?, requiresNewUser? }` — with no `priority`, no async `content` thunk, no `cooldownSessions`, and no `isRelevant` predicate. The catalog (`DEFAULT_TIPS`) is a hand-curated list of feature-discovery tips; `selectTips()` is pure and synchronous, filtering only on `availableCommands` plus the user's `spinnerTipsEnabled` / `spinnerTipsOverride` settings keys. The renderer lives in `components/chat/SpinnerTip.tsx` and the server broadcasts tips via the `tips` SSE event in `lib/server/session.ts`, neither of which prioritizes or dynamically computes a tip body. There is no team-artifact scan, no `vh7`/`Nh7`-equivalent probe, and the `tips_team_artifact_show` / `content_scan_error` / `content_unknown_error` telemetry events do not exist anywhere in `lib/` or `components/`. The natural home would be an async branch in `selectTips()` (or a server-side feed appended there) that produces a high-priority `Tip` after a workspace-scoped artifact scan in `lib/server/`.

## Decision
MISSING. The whole notion — scan for team-shared artifacts on session start, surface the result as the top-priority rotating tip, fall back silently when the scan returns nothing or errors — has no analog in Claudius's tip pipeline. Worth adding only if Claudius grows a "team artifacts" surface (shared skills, agents, MCP servers, or plugins from a team registry) that would benefit from a session-start nudge; until then both the trigger and the content would be empty. If pursued, the minimal shape is: extend `Tip` in `lib/shared/tips.ts` with optional `priority`, `cooldownSessions`, and async `content`/`isRelevant`, resolve them server-side in `lib/server/session.ts` before the `tips` event is broadcast, and let `components/chat/SpinnerTip.tsx` continue to render whatever string lands in `text`.
