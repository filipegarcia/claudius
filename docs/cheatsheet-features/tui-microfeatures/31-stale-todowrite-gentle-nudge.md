# Stale TodoWrite gentle nudge

**Source:** Claude Code TUI — input keyword nudge
**Status:** MISSING

## What it is
After N turns without using TodoWrite, the harness injects a `todo_reminder` system message suggesting Claude track progress or prune stale items, and dumps the current todo contents inline so the model can clean them up. Phrased as low-pressure:

> The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.

## Claudius today
Not surfaced in Claudius. `components/chat/TodosBanner.tsx` and the right-rail `widgets/TodoList.tsx` only *display* the agent's current TodoWrite output; nothing in `lib/server/session.ts` injects a stale-todo reminder back into the agent's context. A natural home would be a server-side hook in `lib/server/session.ts` that counts turns since the last TodoWrite tool call and pushes a `todo_reminder` user-message into the next query.

## Decision
MISSING. This is a harness-internal prompt-injection behavior baked into the Claude Code binary, not a UI feature — Claudius would have to replicate it by tracking TodoWrite turn-distance in the session loop and injecting the reminder string itself. Worth adding only if users report Claude letting todo lists go stale in long Claudius sessions; otherwise leave it to the SDK to handle if/when it ships there.
