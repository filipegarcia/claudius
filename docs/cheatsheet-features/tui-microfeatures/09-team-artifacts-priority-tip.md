# Team-artifacts spinner tip (priority 4)

**Source:** Claude Code TUI — tip rotation
**Status:** MISSING

## What it is
The highest-priority entry in the CLI's spinner-tip rotation: a `"team-artifacts"` tip with `priority:4` whose `content` is computed dynamically via an async network/IO scan on session start. The binary fingerprint is:

> `team-artifacts",priority:4,content:async()=>{let H=await vh7().catch((_)=>{return t_("tips_team_artifact_show",_ instanceof Error?"content_scan_error":"content_unknown_error"),[]});if(H.length===0)return"";return yh7(H),hh7(),Eh7(H)},cooldownSessions:1,isRelevant:async()=>Nh7()`

So the tip (a) only fires when an async `isRelevant` predicate (`Nh7()`) says so, (b) runs a scan (`vh7()`) that emits one of three telemetry events — `tips_team_artifact_show` on success, `content_scan_error` on a thrown `Error`, `content_unknown_error` on a non-Error rejection — and (c) returns an empty string (no tip) when the scan finds nothing, otherwise formats the artifacts into a single-line tip. `cooldownSessions:1` keeps it from re-firing every session.

## Claudius today
Not surfaced in Claudius. `lib/shared/tips.ts` is the spinner-tip source of truth and its `Tip` shape is intentionally static — `{ id, text, command? }` — with no `priority`, no async `content`, no `isRelevant` predicate, and no `cooldownSessions` field. The catalog (`DEFAULT_TIPS`) is a hand-curated list of feature-discovery tips, `selectTips()` filters only on `availableCommands`, and `nextTipIndexWithDismissals()` just rotates through with a dismissed-tip weighting. There is no team-artifact concept, no content-scan IO, and no telemetry channel matching `tips_team_artifact_show` / `content_scan_error` / `content_unknown_error` anywhere in `lib/` or `components/`. The renderer lives in `components/chat/SpinnerTip.tsx` and the server broadcasts tips via the `tips` SSE event in `lib/server/session.ts`, neither of which prioritizes or dynamically computes a tip body. A natural home would be a new optional `priority` / `isRelevant` / async `content` shape on `Tip`, with the scan running server-side in `lib/server/` before the `tips` event is broadcast.

## Decision
MISSING. The whole notion — scan for team-shared artifacts on session start, surface the result as the top-priority rotating tip, fall back silently when the scan returns nothing or errors — has no analog in Claudius's tip pipeline. Worth adding only if Claudius grows a "team artifacts" surface (shared skills/agents/MCP servers/plugins from a team registry) that would benefit from a session-start nudge; until then, both the trigger and the content would be empty. If pursued, the minimal shape is: extend `Tip` in `lib/shared/tips.ts` with optional `priority`, `cooldownSessions`, and async `content`/`isRelevant`, resolve them server-side in `lib/server/session.ts`, and let `components/chat/SpinnerTip.tsx` continue to render whatever string lands in `text`.
