# Truncated-file follow-up reminder

**Source:** Claude Code TUI — ambient system-reminder (Read tool / memory load)
**Status:** MISSING

## What it is
When the `Read` tool returns a too-large file or a memory file is loaded over its byte/line cap, the next turn carries a silent reminder telling Claude the content was truncated, which limit was hit, and that more can be fetched with `Read`. The reminder also instructs the model not to surface the truncation to the user. The literal strings in the CLI binary are:

> `Note: The file \n was too large and has been truncated to the first \n lines. Don't tell the user about this truncation. Use \n to read more of the file if you need.`

and, for memory loads:

> `This memory file was truncated (${T.truncatedByBytes?`${wJK} byte limit`:`first ${nQ8} lines`}). Use the ${H9} tool to view the complete file at: ${K}`

Both are model-only nudges — no banner is shown in the chat.

## Claudius today
Not surfaced in Claudius. Grepping `lib/`, `components/`, and `app/` for `was too large`, `truncated to the first`, and `memory file was truncated` returns zero hits; the only neighbouring truncation reference is `app/api/workspaces/[id]/files/route.ts` rejecting edits over 2MB with a 413, which is a separate code path. The Read tool is run by the SDK runtime — Claudius never re-renders its output — so the reminder is an agent-internal artifact with no UI seam. The natural home, if we ever wanted to replicate it, would be alongside the other `system-reminder`-style injections in `lib/server/session.ts` (the same place a `memory_update` or date-change reminder would live).

## Decision
MISSING. This is a model-only nudge embedded in the SDK's Read/memory-load path; it has no user-visible surface to mirror, and exposing the truncation to the user would actively contradict the reminder's "Don't tell the user about this truncation" instruction. No action needed unless we add our own large-file Read shim, in which case the same reminder text should be re-injected from `lib/server/session.ts`.
