# Coordinator / peer / mid-turn user message inject

**Source:** Claude Code TUI — system reminder injection
**Status:** PARTIAL

## What it is
When a coordinator, a peer Claude session, or the user sends a message while Claude is mid-turn, the TUI doesn't deliver it as a normal user turn — it injects a sidecar `task-notification` at the end of the current turn whose wording varies by sender. Coordinator is mandatory (`Address this before completing your current task`), peer is permissive (`A peer session sent a message while you were working … decide whether/how to respond` — explicitly flagged as "from another Claude session, not your user"), and the human variant is forceful: `IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.` The wrapper marks every variant as automated ("NOT a message from the user … Do NOT interpret this as user acknowledgement") so the model can't mistake the inject for a fresh ack.

## Claudius today
The user variant is wired. `lib/server/session.ts` captures `wasMidTurn = this.turnInFlight` at the top of `sendInput` (around line 1969) and, when true, queues `midturnInjectReminderBody()` via `queueReminder(this, "midturn-inject", …)` (around line 2059) so the forceful "you MUST address that message … This is an automated reminder — the user has NOT acknowledged that the prior task is done" wrapper rides the same turn as the late message. The reminder body lives at `midturnInjectReminderBody()` in `lib/server/session.ts` (lines 330–360) with a comment block explaining the deviation from the CLI prose (Claudius prepends the reminder, so it says "the message that follows" instead of "the message above"). A unit test at `tests/unit/midturn-inject-reminder.test.ts` locks the wording. The peer/coordinator variants have no analogue — `lib/client/use-dms.ts` and `lib/server/community/*` carry human-to-human DMs but never inject into a live agent turn, and there is no coordinator/peer-Claude wiring in `lib/server/session.ts`.

## Decision
PARTIAL. The mid-turn user case now has a forceful "MUST address … Do not ignore it" sidecar plus the explicit "this is automated, not an ack" framing, matching the TUI's human variant. The peer-session and coordinator variants are still MISSING — Claudius has no concept of one session injecting into another mid-turn, and the source comment in `session.ts` calls this out as intentionally unmodelled until multi-session coordination lands.
