# /diff

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Opens an interactive diff viewer to inspect pending code changes.

## Claudius today
The slash command is registered in `lib/shared/slash-commands.ts` (`id: "diff"`, category `ui`, handler `sdk`) and forwarded to the SDK. The real browser surface for inspecting diffs is the workspace Git page, which renders a full `DiffViewer` (`components/git/DiffViewer.tsx`) for staged/unstaged/committed changes, and individual tool calls (Edit/Write) already render inline diffs in the chat transcript via `components/chat/ToolCall.tsx`.

## Decision
ALREADY_EXISTS. Diff viewing has two strong browser surfaces: the Git page (`app/[workspaceId]/git/page.tsx`, using `DiffViewer`) and inline edit diffs in the chat transcript. The literal `/diff` slash is forwarded to the SDK as a UI command; no additional standalone diff surface is warranted.
