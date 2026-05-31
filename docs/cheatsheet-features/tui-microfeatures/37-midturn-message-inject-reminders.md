# Coordinator / peer / mid-turn user message inject

**Source:** Claude Code TUI — system reminder injection
**Status:** PARTIAL

## What it is
When a coordinator, a peer Claude session, or the user sends a message while Claude is mid-turn, the TUI doesn't deliver it as a normal user turn — it injects a sidecar `task-notification` at the end of the current turn whose wording varies by sender. Coordinator is mandatory (`Address this before completing your current task`), peer is permissive (`decide whether/how to respond` — explicitly flagged as "from another Claude session, not your user"), and the human variant is forceful: `IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.` The wrapper marks every variant as automated ("NOT a message from the user … Do NOT interpret this as user acknowledgement") so the model can't mistake the inject for a fresh ack.

## Claudius today
Mid-turn user input is partially covered. `lib/server/session.ts` pushes follow-up text/blocks onto `this.inputQueue` while a turn is in flight (see the queued-content branches around lines 1366 and 1437), and a one-shot goal reminder can be prepended to the queued content (`takeGoalReminder()` at lines 1487+). But there is no forceful "MUST address" wrapper on plain mid-turn user messages, no `task-notification` framing, and no automated-vs-acknowledgement marker. The peer/coordinator variants have no analogue at all: `lib/client/use-dms.ts` and `lib/server/community/*` carry human-to-human DMs over the community server but never inject into a live agent turn, and there is no coordinator/peer-Claude wiring in `lib/server/session.ts`.

## Decision
PARTIAL. The mid-turn user case is handled functionally (input queue + optional goal-reminder prefix) but without the forceful "MUST address … Do not ignore it" sidecar or the explicit "this is automated, not an ack" framing. The peer-session and coordinator variants are MISSING — Claudius has no concept of one session injecting into another mid-turn. Worth adding as a queued-content wrapper in `lib/server/session.ts` if we want parity with the TUI's user-variant nudge; the peer/coordinator variants only become relevant if multi-session coordination lands.
