# Prompt-queue 'Press up to edit' hint

**Source:** Claude Code TUI — input keyword nudge
**Status:** PARTIAL

## What it is
Tip teaching users that messages typed while Claude is working get queued, and that pressing Up arrow opens the queued messages for editing instead of starting prompt-history navigation. The TUI rotates the composer placeholder to `Press up to edit queued messages`, throttled by `queuedCommandUpHintCount` (`queuedCommandUpHintCount||0)<zkO)return"Press up to edit queued messages`).

## Claudius today
Queueing itself is fully wired: `components/chat/PromptInput.tsx` flips the placeholder to `"Queue a follow-up — Shift+Enter for newline"` and shows a `Queue` button while a turn is `pending`, and `components/chat/QueueIndicator.tsx` renders each queued message with click-to-edit, reorder, and remove controls (the "edit" affordance moves the queued text back into the composer). Up arrow is not bound to queue-edit, though — `PromptInput.tsx` reserves `Cmd/Ctrl+ArrowUp/ArrowDown` for shell-style prompt-history recall (`recallHistory`, lines ~568–610). There is no rotating placeholder that points users at the Up-arrow path specifically.

## Decision
PARTIAL. Claudius already exposes a richer queue UI than the TUI hint advertises (visible `QueueIndicator` with explicit edit/reorder/remove buttons), so the "Press up to edit queued messages" placeholder is less necessary in the browser. If we want parity with the TUI nudge, the natural home is a throttled placeholder swap inside `components/chat/PromptInput.tsx` when `pending` and the queue is non-empty — and, if we choose to bind plain `ArrowUp` (no modifier) to focus the most-recent queued message, the hint becomes self-explanatory. Worth picking up only if user testing shows the queue panel is being missed.
