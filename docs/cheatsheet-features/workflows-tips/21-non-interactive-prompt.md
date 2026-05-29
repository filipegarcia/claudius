# Non-interactive prompt (claude -p)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** NOT_APPLICABLE

## What it is
`claude -p "<prompt>"` runs a single headless query and exits — meant for scripts, pipelines, and CI where there is no interactive TUI.

## Claudius today
Claudius is itself the interactive surface around the SDK: every prompt goes through the live chat composer (`components/chat/PromptInput.tsx`) and the session stream. The closest "fire a prompt without sitting in chat" equivalents already exist as scheduled/loop runs (`app/[workspaceId]/schedule/page.tsx`) which drive headless agent turns server-side.

## Decision
Not applicable. `-p` is a CLI affordance for headless scripting outside any UI — its whole point is the absence of an interactive surface. Building a "headless query box" in a browser app would just be a worse version of the existing chat; the genuine headless-automation use case is already served by the Schedule/loop surfaces. No browser surface to add.
