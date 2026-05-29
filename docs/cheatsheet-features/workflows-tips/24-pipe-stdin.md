# Pipe stdin (cat file | claude -p)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** NOT_APPLICABLE

## What it is
Pipe file contents (or any stdout) into a headless `claude -p` invocation as the prompt input, e.g. `cat file | claude -p "summarize"`.

## Claudius today
The browser composer accepts pasted/typed text, image attachments, and `@`-mention file references (`components/chat/AtMentionPicker.tsx`), and the Files page (`app/[workspaceId]/files/page.tsx`) lets the agent read any workspace file directly. There is no "stdin" concept in a browser — the equivalent of "feed this file into the prompt" is `@`-mentioning it or letting the agent Read it.

## Decision
Not applicable. Stdin piping is a shell/CLI mechanism with no browser analog; the in-app equivalents (paste, image attach, `@`-mention, agent file reads) already cover "get content into the prompt." No browser surface to add.
