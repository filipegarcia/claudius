# /recap

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** NOT_APPLICABLE

## What it is
Summarizes the session context on return — a short "where we left off" recap (e.g. Goal / Done / Next).

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "recap"`, category `memory`, handler `sdk`) and forwarded to the SDK, which intercepts `/recap` locally as a built-in command and produces no assistant response that Claudius can render. The `RecapBanner` (`components/chat/RecapBanner.tsx`), despite the name, is the always-on session-title strip (SDK `customTitle ?? summary`); its own docstring notes it does not capture `/recap` output and that a richer Goal/Done/Next recap "is deferred."

## Decision
NOT_APPLICABLE (as a buildable shell). The SDK swallows `/recap` locally and emits nothing back over the stream, so there is no payload to surface — a real recap surface would require Claudius to send its own structured summarization prompt to Claude on demand and render the reply, which is backend SDK plumbing, not a UI shell. The baseline (auto session title/summary) already ships via `RecapBanner`. If pursued later: deferred — needs backend (a dedicated "recap" prompt + event), and would naturally live as a chat-header control or a button on the session-header panel.
