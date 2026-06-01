# Prompt-queue 'Press up to edit' hint

**Source:** Claude Code TUI — input keyword nudge
**Status:** ALREADY_EXISTS

## What it is
While Claude is working, messages typed into the composer are queued for the next turn. The TUI rotates its placeholder to `Press up to edit queued messages` (throttled by `queuedCommandUpHintCount`) to teach users that ArrowUp opens the queued messages for editing rather than starting prompt-history navigation. The grounded binary string is `queuedCommandUpHintCount||0)<zkO)return"Press up to edit queued messages`.

## Claudius today
Claudius surfaces the queue with a dedicated panel rather than a keybinding hint. `components/chat/QueueIndicator.tsx` renders each queued message above the composer with explicit Edit, Reorder, and Remove controls (clicking a row "moves the queued text back into the prompt"). `components/chat/PromptInput.tsx` shows a footer `queueHint` while a turn is `pending`: `"Send queues until current response finishes"` when empty, and `"<n> queued · edit above"` once at least one message is queued — the comment at that site explicitly calls this out as parity with the TUI's "Press up to edit queued messages" nudge, retargeted at the visible panel ("Claudius doesn't bind plain ArrowUp to queue-edit").

## Decision
ALREADY_EXISTS. The TUI's ArrowUp keybinding hint maps to Claudius's `QueueIndicator` panel plus the `queueHint` footer copy in `PromptInput.tsx`, which together cover the same teaching moment (your message is queued; here is how to edit it) without overloading the Up arrow. No new UI is needed; if anyone wanted closer literal parity later, the cheapest follow-up would be binding plain ArrowUp on an empty composer to focus the top queued row.
