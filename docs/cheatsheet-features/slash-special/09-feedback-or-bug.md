# /feedback or /bug

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/feedback` (alias `/bug`) submits feedback / a bug report about Claude Code.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "feedback"`, alias `bug`,
category `info`). The browser surface is `components/chat/FeedbackBanner.tsx`: a
non-blocking, CLI-style session-quality survey (thumbs up/down + short note) that
the server nudges via a `feedback_survey` SSE event (`lib/server/feedback-survey.ts`).
Submission goes to `app/api/feedback/route.ts`, which BOTH forwards the comment to
Anthropic via the SDK's `Query.submitFeedback` (the same channel the CLI uses) AND
persists a row to the per-workspace `.claudius.db` (`lib/server/feedback-store.ts`).
When the Anthropic forward can't land, the banner says so and points at a fallback
GitHub issues URL instead of silently dropping the feedback.

## Decision
ALREADY_EXISTS. Submitting feedback is fully covered by the FeedbackBanner survey
and `app/api/feedback/route.ts` (forward + local persistence + graceful-fail
fallback). The registry tags it `external`, but the working browser surface is the
survey banner; no new UI is needed.
