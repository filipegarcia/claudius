# /review

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/review` runs a local code review of a pull request (or the pending diff) and
reports findings in the conversation.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "sdk"` (category
`skill`, argsHint `[PR]`) and backed by the `review` / `code-review` skill. As
an `sdk`-handler command, `handleSend` in `app/[workspaceId]/page.tsx` forwards
`/review` verbatim to the SDK via the `asSlashCommand` no-echo path; the agent
runs the review and streams its findings (text, tool calls, file diffs) into the
chat, with results visible through the normal Git page
(`app/[workspaceId]/git/page.tsx`) for any edits.

## Decision
ALREADY_EXISTS. `/review` works today through the SDK forward path in
`app/[workspaceId]/page.tsx` (the `cmd?.handler === "sdk"` branch). Code review
is inherently an agent action that streams into the existing chat transcript;
there is no separate UI to build — the registry already classifies it as a
skill/`sdk` command. No new surface needed.
