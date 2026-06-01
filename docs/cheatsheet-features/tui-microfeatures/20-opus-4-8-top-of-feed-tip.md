# 'Opus 4.8 is here!' top-of-feed setup tip

**Source:** Claude Code TUI — tip rotation
**Status:** ALREADY_EXISTS

## What it is
A first-run announcement pinned at the very top of the feed (the TUI's
`tengu-top-of-feed-tip` slot) that reads `Opus 4.8 is here!`, notes it
`Now defaults to high effort`, and points at `/effort xhigh for your hardest tasks`.
Distinct from the simpler `Opus 4.8 is now available! /model to switch` line —
this is a persistent setup nudge, not a transient model-availability ping.

## Claudius today
`components/chat/OpusLaunchTipBanner.tsx` renders the launch tip pinned above
the message list with the same three beats ("Opus 4.8 is here!" + "Now
defaults to high effort" + a styled `/effort xhigh` hint). It is mounted
from `app/[workspaceId]/page.tsx` and dismissed once-per-browser via
localStorage (`claudius.opusLaunchTipDismissed`, with a same-tab change
event so the dismissal propagates without a reload), mirroring the TUI's
one-shot semantics. `/effort xhigh` renders as a non-clickable `<code>`
span because `/effort` is `handler: "sdk"` in `lib/shared/slash-commands.ts`
— clicking would dispatch the command into the model instead of just
pointing at the lever. The rotating under-spinner tips in
`lib/shared/tips.ts` are a separate surface, as is the transient
`OpusOverloadNudgePanel`.

## Decision
ALREADY_EXISTS. `OpusLaunchTipBanner` is the dedicated browser equivalent
of `tengu-top-of-feed-tip`, wired into the workspace page and gated by a
per-browser dismissal flag. No new UI needed.
