# claude "q" (with prompt)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude "your question"` starts a session and immediately sends the given prompt as the first turn.

## Claudius today
Typing in the composer and submitting is exactly this — the create-session route (`app/api/sessions/route.ts`) plus the input route (`app/api/sessions/[id]/input/route.ts`) start a session and deliver the first prompt.

## Decision
Already covered. The composer (`components/chat/PromptInput.tsx`) sends an initial prompt into a freshly created session; the session-create API accepts a starting cwd/model and the first message flows through the input route. No new UI needed.
